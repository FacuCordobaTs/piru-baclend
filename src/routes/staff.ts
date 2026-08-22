import { Hono } from 'hono'
import { randomInt, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { and, eq, gt, max } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import * as bcrypt from 'bcrypt'
import { pool } from '../db'
import {
  restaurante as RestauranteTable,
  sucursal as SucursalTable,
  usuarioRestaurante as UsuarioRestauranteTable,
  verificacionStaff as VerificacionStaffTable,
} from '../db/schema'
import { authMiddleware } from '../middleware/auth'
import { autenticarStaffConPin, asegurarOwnerStaff, crearSesionStaff, generarCodigoAccesoStaff, revocarSesionesStaff } from '../lib/staff'
import { sendVerificationCodeWhatsApp } from '../services/whatsapp'

const pinSchema = z.string().regex(/^\d{4,8}$/, 'El PIN debe tener entre 4 y 8 dígitos')
const crearStaffSchema = z.object({
  nombre: z.string().trim().min(1).max(255),
  rol: z.enum(['admin', 'mozo']),
  sucursalId: z.number().int().positive().nullable().optional(),
  // Compatibilidad: los admins anteriores siguen enviando PIN y reciben un
  // codigo legacy. El flujo nuevo no necesita ninguno de los dos.
  pin: pinSchema.optional(),
})
const editarStaffSchema = z.object({
  nombre: z.string().trim().min(1).max(255).optional(),
  sucursalId: z.number().int().positive().nullable().optional(),
  activo: z.boolean().optional(),
  pin: pinSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, 'No hay cambios para guardar')
const loginSchema = z.object({ codigoAcceso: z.string().min(16).max(64), pin: pinSchema })
const loginOtpStartSchema = z.object({
  telefono: z.string().min(8).max(20),
  numeroMozo: z.number().int().positive().max(999999),
})
const loginOtpVerifySchema = z.object({
  verificationId: z.string().uuid(),
  codigo: z.string().regex(/^\d{6}$/),
  numeroMozo: z.number().int().positive().max(999999),
})

const OTP_EXPIRACION_MS = 10 * 60 * 1000
const OTP_REENVIO_COOLDOWN_MS = 45 * 1000
const OTP_MAX_INTENTOS = 5
const normalizarTelefono = (raw: string) => raw.replace(/\D/g, '')
const generarOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

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

// Login simple de la PWA: el numero identifica al mozo dentro del restaurante
// y la posesion del WhatsApp verificado del local reemplaza codigo largo + PIN.
staffLoginRoute.post('/login-otp/start', zValidator('json', loginOtpStartSchema), async (c) => {
  const db = drizzle(pool)
  const body = c.req.valid('json')
  const telefono = normalizarTelefono(body.telefono)
  if (telefono.length < 8) return c.json({ success: false, message: 'El número de WhatsApp no es válido' }, 400)

  try {
    const [identidad] = await db.select({ usuarioId: UsuarioRestauranteTable.id })
      .from(UsuarioRestauranteTable)
      .innerJoin(RestauranteTable, eq(RestauranteTable.id, UsuarioRestauranteTable.restauranteId))
      .where(and(
        eq(RestauranteTable.telefono, telefono),
        eq(RestauranteTable.telefonoVerificado, true),
        eq(UsuarioRestauranteTable.numeroMozo, body.numeroMozo),
        eq(UsuarioRestauranteTable.activo, true),
      ))
      .limit(1)

    // Mensaje deliberadamente indistinguible para no enumerar mozos/locales.
    if (!identidad) return c.json({ success: false, message: 'No encontramos ese mozo en el local' }, 404)

    const desde = new Date(Date.now() - OTP_REENVIO_COOLDOWN_MS)
    const [reciente] = await db.select({ id: VerificacionStaffTable.id })
      .from(VerificacionStaffTable)
      .where(and(
        eq(VerificacionStaffTable.telefono, telefono),
        eq(VerificacionStaffTable.verificado, false),
        gt(VerificacionStaffTable.createdAt, desde),
      ))
      .limit(1)
    if (reciente) return c.json({ success: false, message: 'Ya enviamos un código hace unos segundos. Esperá antes de pedir otro.' }, 429)

    const codigo = generarOtp()
    const verificationId = randomUUID()
    await db.insert(VerificacionStaffTable).values({
      id: verificationId,
      usuarioRestauranteId: identidad.usuarioId,
      telefono,
      codigoHash: await bcrypt.hash(codigo, 10),
      expiraEn: new Date(Date.now() + OTP_EXPIRACION_MS),
    })
    const envio = await sendVerificationCodeWhatsApp(c, { phone: telefono, code: codigo })
    if (!envio.success) {
      await db.delete(VerificacionStaffTable).where(eq(VerificacionStaffTable.id, verificationId))
      return c.json({ success: false, message: 'No pudimos enviar el código por WhatsApp. Intentá de nuevo.' }, 502)
    }
    return c.json({ success: true, data: { verificationId, expiraEnSegundos: OTP_EXPIRACION_MS / 1000 } })
  } catch (error) {
    console.error('Error iniciando login OTP de staff:', error)
    return c.json({ success: false, message: 'No pudimos iniciar el acceso' }, 500)
  }
})

staffLoginRoute.post('/login-otp/verify', zValidator('json', loginOtpVerifySchema), async (c) => {
  const db = drizzle(pool)
  const { verificationId, codigo, numeroMozo } = c.req.valid('json')
  try {
    const [reg] = await db.select().from(VerificacionStaffTable)
      .where(eq(VerificacionStaffTable.id, verificationId)).limit(1)
    if (!reg || reg.verificado) return c.json({ success: false, message: 'La verificación ya no está disponible' }, 400)
    if (new Date(reg.expiraEn).getTime() < Date.now()) return c.json({ success: false, message: 'El código expiró. Volvé a pedir uno.' }, 400)
    if (reg.intentos >= OTP_MAX_INTENTOS) return c.json({ success: false, message: 'Demasiados intentos. Volvé a pedir un código.' }, 429)

    const codigoOk = await bcrypt.compare(codigo, reg.codigoHash)
    if (!codigoOk) {
      await db.update(VerificacionStaffTable).set({ intentos: reg.intentos + 1 })
        .where(eq(VerificacionStaffTable.id, verificationId))
      const restantes = OTP_MAX_INTENTOS - reg.intentos - 1
      return c.json({ success: false, message: restantes > 0 ? `Código incorrecto. Te quedan ${restantes} intentos.` : 'Código incorrecto. Volvé a pedir uno.' }, 400)
    }

    const [usuario] = await db.select().from(UsuarioRestauranteTable).where(and(
      eq(UsuarioRestauranteTable.id, reg.usuarioRestauranteId),
      eq(UsuarioRestauranteTable.numeroMozo, numeroMozo),
      eq(UsuarioRestauranteTable.activo, true),
    )).limit(1)
    if (!usuario) return c.json({ success: false, message: 'El acceso del mozo ya no está activo' }, 403)

    const claim = await db.update(VerificacionStaffTable).set({ verificado: true })
      .where(and(eq(VerificacionStaffTable.id, verificationId), eq(VerificacionStaffTable.verificado, false)))
    if (Number(claim[0].affectedRows) !== 1) return c.json({ success: false, message: 'La verificación ya fue utilizada' }, 409)
    const sesion = await crearSesionStaff(db, usuario)
    return c.json({ success: true, data: {
      token: sesion.token,
      expiraAt: sesion.expiraAt,
      usuario: { id: usuario.id, nombre: usuario.nombre, rol: usuario.rol, sucursalId: usuario.sucursalId, numeroMozo: usuario.numeroMozo },
    } })
  } catch (error) {
    console.error('Error verificando login OTP de staff:', error)
    return c.json({ success: false, message: 'No pudimos verificar el código' }, 500)
  }
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
    numeroMozo: UsuarioRestauranteTable.numeroMozo,
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
  const codigoAcceso = body.pin ? generarCodigoAccesoStaff() : null
  const pinHash = body.pin ? await bcrypt.hash(body.pin, 12) : null
  const creado = await db.transaction(async (tx) => {
    // Serializa las altas de un mismo local para que dos clicks simultaneos no
    // intenten asignar el mismo numero.
    await tx.select({ id: RestauranteTable.id }).from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId)).limit(1).for('update')
    const [{ ultimoNumero }] = await tx.select({ ultimoNumero: max(UsuarioRestauranteTable.numeroMozo) })
      .from(UsuarioRestauranteTable).where(eq(UsuarioRestauranteTable.restauranteId, restauranteId))
    const numeroMozo = Number(ultimoNumero ?? 0) + 1
    const result = await tx.insert(UsuarioRestauranteTable).values({
      restauranteId, nombre: body.nombre, rol: body.rol, sucursalId: body.sucursalId ?? null,
      numeroMozo, pinHash, codigoAcceso, activo: true,
    })
    return { id: Number(result[0].insertId), numeroMozo }
  })
  return c.json({ success: true, data: { id: creado.id, codigoAcceso, numeroMozo: creado.numeroMozo }, message: 'Usuario de staff creado' }, 201)
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
