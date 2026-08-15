import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import * as bcrypt from 'bcrypt'
import { pool } from '../db'
import { sucursal as SucursalTable, usuarioRestaurante as UsuarioRestauranteTable } from '../db/schema'
import { authMiddleware } from '../middleware/auth'
import { autenticarStaffConPin, asegurarOwnerStaff, generarCodigoAccesoStaff, revocarSesionesStaff } from '../lib/staff'

const pinSchema = z.string().regex(/^\d{4,8}$/, 'El PIN debe tener entre 4 y 8 dígitos')
const crearStaffSchema = z.object({
  nombre: z.string().trim().min(1).max(255),
  rol: z.enum(['admin', 'mozo']),
  sucursalId: z.number().int().positive().nullable().optional(),
  pin: pinSchema,
})
const editarStaffSchema = z.object({
  nombre: z.string().trim().min(1).max(255).optional(),
  sucursalId: z.number().int().positive().nullable().optional(),
  activo: z.boolean().optional(),
  pin: pinSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, 'No hay cambios para guardar')
const loginSchema = z.object({ codigoAcceso: z.string().min(16).max(64), pin: pinSchema })

async function sucursalEsDelRestaurante(db: any, restauranteId: number, sucursalId: number | null | undefined) {
  if (sucursalId == null) return true
  const [sucursal] = await db.select({ id: SucursalTable.id }).from(SucursalTable).where(and(
    eq(SucursalTable.id, sucursalId), eq(SucursalTable.restauranteId, restauranteId),
  )).limit(1)
  return Boolean(sucursal)
}

// Login independiente: el token emitido no es compatible con authMiddleware.
const staffLoginRoute = new Hono().post('/login', zValidator('json', loginSchema), async (c) => {
  const db = drizzle(pool)
  const { codigoAcceso, pin } = c.req.valid('json')
  const resultado = await autenticarStaffConPin(db, codigoAcceso, pin)
  if ('error' in resultado) {
    const message = resultado.error === 'BLOQUEADO' ? 'PIN bloqueado temporalmente' : 'Código de acceso o PIN inválido'
    return c.json({ success: false, code: resultado.error, message, bloqueadoHasta: ('bloqueadoHasta' in resultado ? resultado.bloqueadoHasta : null) ?? null }, 401)
  }
  return c.json({ success: true, data: {
    token: resultado.token, expiraAt: resultado.expiraAt,
    usuario: { id: resultado.usuario.id, nombre: resultado.usuario.nombre, rol: resultado.usuario.rol, sucursalId: resultado.usuario.sucursalId },
  } })
})

// Gestión exclusiva desde la sesión normal del dueño/admin. La PWA de mozos no
// consume esta superficie; sus endpoints scopiados pertenecen a T38.
const staffRoute = new Hono().use('*', authMiddleware)

staffRoute.get('/usuarios', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const owner = await asegurarOwnerStaff(db, restauranteId)
  const usuarios = await db.select({
    id: UsuarioRestauranteTable.id, nombre: UsuarioRestauranteTable.nombre, rol: UsuarioRestauranteTable.rol,
    sucursalId: UsuarioRestauranteTable.sucursalId, codigoAcceso: UsuarioRestauranteTable.codigoAcceso,
    activo: UsuarioRestauranteTable.activo, bloqueadoHasta: UsuarioRestauranteTable.bloqueadoHasta,
    ultimoAccesoAt: UsuarioRestauranteTable.ultimoAccesoAt, createdAt: UsuarioRestauranteTable.createdAt,
  }).from(UsuarioRestauranteTable).where(eq(UsuarioRestauranteTable.restauranteId, restauranteId))
  return c.json({ success: true, data: usuarios, ownerId: owner.id })
})

staffRoute.post('/usuarios', zValidator('json', crearStaffSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const body = c.req.valid('json')
  if (!(await sucursalEsDelRestaurante(db, restauranteId, body.sucursalId))) return c.json({ success: false, message: 'La sucursal no pertenece al restaurante' }, 422)
  const codigoAcceso = generarCodigoAccesoStaff()
  const result = await db.insert(UsuarioRestauranteTable).values({
    restauranteId, nombre: body.nombre, rol: body.rol, sucursalId: body.sucursalId ?? null,
    pinHash: await bcrypt.hash(body.pin, 12), codigoAcceso, activo: true,
  })
  const id = Number(result[0].insertId)
  return c.json({ success: true, data: { id, codigoAcceso }, message: 'Usuario de staff creado' }, 201)
})

staffRoute.put('/usuarios/:id{[0-9]+}', zValidator('json', editarStaffSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const id = Number(c.req.param('id'))
  const body = c.req.valid('json')
  const [usuario] = await db.select().from(UsuarioRestauranteTable).where(and(
    eq(UsuarioRestauranteTable.id, id), eq(UsuarioRestauranteTable.restauranteId, restauranteId),
  )).limit(1)
  if (!usuario) return c.json({ success: false, message: 'Usuario no encontrado' }, 404)
  if (usuario.rol === 'owner' && (body.activo === false || body.pin !== undefined || body.sucursalId !== undefined)) {
    return c.json({ success: false, message: 'La identidad owner se administra con la cuenta principal del restaurante' }, 422)
  }
  if (!(await sucursalEsDelRestaurante(db, restauranteId, body.sucursalId))) return c.json({ success: false, message: 'La sucursal no pertenece al restaurante' }, 422)
  const changes: any = { updatedAt: new Date() }
  if (body.nombre !== undefined) changes.nombre = body.nombre
  if (body.sucursalId !== undefined) changes.sucursalId = body.sucursalId
  if (body.activo !== undefined) changes.activo = body.activo
  if (body.pin !== undefined) changes.pinHash = await bcrypt.hash(body.pin, 12)
  if (body.activo === false || body.pin !== undefined) await revocarSesionesStaff(db, id)
  await db.update(UsuarioRestauranteTable).set(changes).where(eq(UsuarioRestauranteTable.id, id))
  return c.json({ success: true, message: 'Usuario de staff actualizado' })
})

export { staffLoginRoute, staffRoute }
