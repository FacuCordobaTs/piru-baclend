import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { and, asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { mesaLocal as MesaLocalTable, sucursal as SucursalTable } from '../db/schema'
import { authMiddleware } from '../middleware/auth'
import { requireModulo } from '../middleware/modulo'
import { MODULE_KEYS } from '../lib/modulos'

// Las coordenadas no tienen un borde máximo: el lienzo del admin crece según la
// distribución de cada restaurante. Sólo se evita guardar posiciones negativas.
const posicionX = z.number().int().min(0)
const posicionY = z.number().int().min(0)
const dimension = z.number().int().min(1).max(12)
const mesaBaseSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre es requerido').max(255),
  sucursalId: z.number().int().positive().nullable().optional(),
  posicionX: posicionX.optional(),
  posicionY: posicionY.optional(),
  ancho: dimension.optional(),
  alto: dimension.optional(),
  capacidad: z.number().int().min(1).max(100).optional(),
  estadoManual: z.string().trim().max(50).nullable().optional(),
  activo: z.boolean().optional(),
  orden: z.number().int().min(0).max(10_000).optional(),
})
const mesaPatchSchema = mesaBaseSchema.partial()
const layoutSchema = z.object({
  mesas: z.array(z.object({
    id: z.number().int().positive(),
    posicionX,
    posicionY,
    ancho: dimension,
    alto: dimension,
    orden: z.number().int().min(0).max(10_000),
  })).min(1).max(200),
})

const mesasLocalesRoute = new Hono()
  .use('*', authMiddleware)
  .use('*', requireModulo(MODULE_KEYS.MESAS))

async function sucursalPerteneceAlRestaurante(db: ReturnType<typeof drizzle>, restauranteId: number, sucursalId: number | null | undefined) {
  if (sucursalId === null || sucursalId === undefined) return true
  const [sucursal] = await db.select({ id: SucursalTable.id })
    .from(SucursalTable)
    .where(and(eq(SucursalTable.id, sucursalId), eq(SucursalTable.restauranteId, restauranteId)))
    .limit(1)
  return Boolean(sucursal)
}

mesasLocalesRoute.get('/', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const incluirInactivas = c.req.query('incluirInactivas') === 'true'
  const where = incluirInactivas
    ? eq(MesaLocalTable.restauranteId, restauranteId)
    : and(eq(MesaLocalTable.restauranteId, restauranteId), eq(MesaLocalTable.activo, true))
  const mesas = await db.select().from(MesaLocalTable).where(where)
    .orderBy(asc(MesaLocalTable.orden), asc(MesaLocalTable.id))
  return c.json({ success: true, data: mesas })
})

mesasLocalesRoute.post('/', zValidator('json', mesaBaseSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const body = c.req.valid('json')
  if (!(await sucursalPerteneceAlRestaurante(db, restauranteId, body.sucursalId))) {
    return c.json({ success: false, message: 'La sucursal no pertenece a este restaurante' }, 422)
  }
  const ahora = new Date()
  const result = await db.insert(MesaLocalTable).values({
    restauranteId,
    nombre: body.nombre,
    sucursalId: body.sucursalId ?? null,
    posicionX: body.posicionX ?? 0,
    posicionY: body.posicionY ?? 0,
    ancho: body.ancho ?? 1,
    alto: body.alto ?? 1,
    capacidad: body.capacidad ?? 1,
    estadoManual: body.estadoManual ?? null,
    activo: body.activo ?? true,
    orden: body.orden ?? 0,
    createdAt: ahora,
    updatedAt: ahora,
  })
  const id = Number(result[0].insertId)
  const [mesa] = await db.select().from(MesaLocalTable).where(eq(MesaLocalTable.id, id)).limit(1)
  return c.json({ success: true, data: mesa, message: 'Mesa creada' }, 201)
})

mesasLocalesRoute.put('/:id{[0-9]+}', zValidator('json', mesaPatchSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ success: false, message: 'ID de mesa inválido' }, 400)
  const body = c.req.valid('json')
  if (Object.keys(body).length === 0) return c.json({ success: false, message: 'No hay cambios para guardar' }, 400)
  if (body.sucursalId !== undefined && !(await sucursalPerteneceAlRestaurante(db, restauranteId, body.sucursalId))) {
    return c.json({ success: false, message: 'La sucursal no pertenece a este restaurante' }, 422)
  }
  const [existente] = await db.select().from(MesaLocalTable)
    .where(and(eq(MesaLocalTable.id, id), eq(MesaLocalTable.restauranteId, restauranteId))).limit(1)
  if (!existente) return c.json({ success: false, message: 'Mesa no encontrada' }, 404)
  await db.update(MesaLocalTable).set({ ...body, updatedAt: new Date() })
    .where(and(eq(MesaLocalTable.id, id), eq(MesaLocalTable.restauranteId, restauranteId)))
  const [mesa] = await db.select().from(MesaLocalTable).where(eq(MesaLocalTable.id, id)).limit(1)
  return c.json({ success: true, data: mesa, message: 'Mesa actualizada' })
})

/** Guarda varias posiciones en una sola transacción para no dejar un grid a medio mover. */
mesasLocalesRoute.put('/layout', zValidator('json', layoutSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const { mesas } = c.req.valid('json')
  const ids = new Set(mesas.map((mesa) => mesa.id))
  if (ids.size !== mesas.length) return c.json({ success: false, message: 'El layout contiene mesas repetidas' }, 422)

  const existentes = await db.select({ id: MesaLocalTable.id }).from(MesaLocalTable)
    .where(eq(MesaLocalTable.restauranteId, restauranteId))
  if (mesas.some((mesa) => !existentes.some((existente) => existente.id === mesa.id))) {
    return c.json({ success: false, message: 'Una o más mesas no pertenecen a este restaurante' }, 404)
  }
  const ahora = new Date()
  await db.transaction(async (tx) => {
    for (const mesa of mesas) {
      await tx.update(MesaLocalTable).set({ ...mesa, updatedAt: ahora }).where(and(eq(MesaLocalTable.id, mesa.id), eq(MesaLocalTable.restauranteId, restauranteId)))
    }
  })
  return c.json({ success: true, message: 'Layout guardado' })
})

/** La baja es lógica: T34/T35 podrán seguir mostrando el historial de una mesa retirada. */
mesasLocalesRoute.delete('/:id{[0-9]+}', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return c.json({ success: false, message: 'ID de mesa inválido' }, 400)
  const result = await db.update(MesaLocalTable).set({ activo: false, updatedAt: new Date() })
    .where(and(eq(MesaLocalTable.id, id), eq(MesaLocalTable.restauranteId, restauranteId)))
  if (!result[0].affectedRows) return c.json({ success: false, message: 'Mesa no encontrada' }, 404)
  return c.json({ success: true, message: 'Mesa desactivada' })
})

export { mesasLocalesRoute }
