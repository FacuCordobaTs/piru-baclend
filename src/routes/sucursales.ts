import { Hono, type Context } from 'hono'
import { pool } from '../db'
import { sucursal as SucursalTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { MODULE_KEYS, tieneModuloActivo } from '../lib/modulos'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, count } from 'drizzle-orm'

const createSucursalSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido'),
  direccion: z.string().max(255).optional().nullable(),
  whatsappEnabled: z.boolean().optional().default(false),
  whatsappNumber: z.string().max(50).optional().nullable(),
  rapiboyToken: z.string().max(512).optional().nullable(),
  activo: z.boolean().optional().default(true),
})

const updateSucursalSchema = z.object({
  nombre: z.string().min(1).optional(),
  direccion: z.string().max(255).optional().nullable(),
  whatsappEnabled: z.boolean().optional(),
  whatsappNumber: z.string().max(50).optional().nullable(),
  rapiboyToken: z.string().max(512).optional().nullable(),
  activo: z.boolean().optional(),
})

const sucursalesRoute = new Hono()

sucursalesRoute.use('*', authMiddleware)

function moduloRequerido(c: Context, modulo: typeof MODULE_KEYS.MULTISUCURSAL | typeof MODULE_KEYS.RAPIBOY, message: string) {
  return c.json(
    {
      success: false,
      moduleRequired: true,
      module: modulo,
      // Alias temporal para admins instalados que todavía reconocen este campo.
      upgradeRequired: true,
      message,
    },
    403,
  )
}

sucursalesRoute.get('/list', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    const sucursales = await db
      .select()
      .from(SucursalTable)
      .where(eq(SucursalTable.restauranteId, restauranteId))

    return c.json({ success: true, data: sucursales }, 200)
  } catch (error) {
    console.error('Error listando sucursales:', error)
    return c.json({ success: false, message: 'Error al listar sucursales' }, 500)
  }
})

sucursalesRoute.post('/create', zValidator('json', createSucursalSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const body = c.req.valid('json')

  try {
    // La suscripción base permite una sucursal. Crear una segunda o más requiere
    // el módulo incluido opt-in, sin alterar las sucursales existentes.
    // El gate va acá (no como middleware) porque depende de cuántas ya existen.
    const [{ total }] = await db
      .select({ total: count() })
      .from(SucursalTable)
      .where(eq(SucursalTable.restauranteId, restauranteId))

    if (total >= 1 && !(await tieneModuloActivo(db, restauranteId, MODULE_KEYS.MULTISUCURSAL))) {
      return moduloRequerido(c, MODULE_KEYS.MULTISUCURSAL, 'Activá el módulo Múltiples sucursales para crear otra sucursal')
    }

    // Las credenciales de Rapiboy son configuración del módulo. Si se desactiva,
    // se conservan para una futura reactivación; sólo puede eliminarse una
    // credencial existente, no crearla ni modificarla.
    if (body.rapiboyToken !== null && body.rapiboyToken !== undefined
      && !(await tieneModuloActivo(db, restauranteId, MODULE_KEYS.RAPIBOY))) {
      return moduloRequerido(c, MODULE_KEYS.RAPIBOY, 'Activá el módulo Rapiboy para configurar sus credenciales')
    }

    const result = await db.insert(SucursalTable).values({
      restauranteId,
      nombre: body.nombre,
      direccion: body.direccion ?? null,
      whatsappEnabled: body.whatsappEnabled,
      whatsappNumber: body.whatsappNumber ?? null,
      rapiboyToken: body.rapiboyToken ?? null,
      activo: body.activo,
    })

    const insertedId = Number(result[0].insertId)
    const [row] = await db
      .select()
      .from(SucursalTable)
      .where(eq(SucursalTable.id, insertedId))
      .limit(1)

    return c.json({ success: true, data: row, message: 'Sucursal creada' }, 201)
  } catch (error) {
    console.error('Error creando sucursal:', error)
    return c.json({ success: false, message: 'Error al crear sucursal' }, 500)
  }
})

sucursalesRoute.put('/:id', zValidator('json', updateSucursalSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) {
    return c.json({ success: false, message: 'ID inválido' }, 400)
  }

  const body = c.req.valid('json')
  const patch: {
    nombre?: string
    direccion?: string | null
    whatsappEnabled?: boolean
    whatsappNumber?: string | null
    rapiboyToken?: string | null
    activo?: boolean
  } = {}
  if (body.nombre !== undefined) patch.nombre = body.nombre
  if (body.direccion !== undefined) patch.direccion = body.direccion
  if (body.whatsappEnabled !== undefined) patch.whatsappEnabled = body.whatsappEnabled
  if (body.whatsappNumber !== undefined) patch.whatsappNumber = body.whatsappNumber
  if (body.rapiboyToken !== undefined) patch.rapiboyToken = body.rapiboyToken
  if (body.activo !== undefined) patch.activo = body.activo

  if (Object.keys(patch).length === 0) {
    return c.json({ success: false, message: 'No hay datos para actualizar' }, 400)
  }

  try {
    const [existing] = await db
      .select({ id: SucursalTable.id })
      .from(SucursalTable)
      .where(and(eq(SucursalTable.id, id), eq(SucursalTable.restauranteId, restauranteId)))
      .limit(1)

    if (!existing) {
      return c.json({ success: false, message: 'Sucursal no encontrada' }, 404)
    }

    if (body.rapiboyToken !== undefined && body.rapiboyToken !== null
      && !(await tieneModuloActivo(db, restauranteId, MODULE_KEYS.RAPIBOY))) {
      return moduloRequerido(c, MODULE_KEYS.RAPIBOY, 'Activá el módulo Rapiboy para configurar sus credenciales')
    }

    await db.update(SucursalTable).set(patch).where(eq(SucursalTable.id, id))

    const [row] = await db.select().from(SucursalTable).where(eq(SucursalTable.id, id)).limit(1)
    return c.json({ success: true, data: row, message: 'Sucursal actualizada' }, 200)
  } catch (error) {
    console.error('Error actualizando sucursal:', error)
    return c.json({ success: false, message: 'Error al actualizar sucursal' }, 500)
  }
})

sucursalesRoute.delete('/:id', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) {
    return c.json({ success: false, message: 'ID inválido' }, 400)
  }

  try {
    const result = await db
      .update(SucursalTable)
      .set({ activo: false })
      .where(and(eq(SucursalTable.id, id), eq(SucursalTable.restauranteId, restauranteId)))

    if (result[0].affectedRows === 0) {
      return c.json({ success: false, message: 'Sucursal no encontrada' }, 404)
    }

    return c.json({ success: true, message: 'Sucursal desactivada' }, 200)
  } catch (error) {
    console.error('Error desactivando sucursal:', error)
    return c.json({ success: false, message: 'Error al desactivar sucursal' }, 500)
  }
})

export { sucursalesRoute }
