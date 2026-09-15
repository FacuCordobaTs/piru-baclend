import { createHash, randomBytes } from 'node:crypto'
import * as bcrypt from 'bcrypt'
import * as jwt from 'jsonwebtoken'
import { and, eq, gt, isNull, or } from 'drizzle-orm'
import { restaurante as RestauranteTable, sesionStaff as SesionStaffTable, usuarioRestaurante as UsuarioRestauranteTable } from '../db/schema'

export const STAFF_ROLES = ['owner', 'admin', 'mozo'] as const
export type StaffRole = typeof STAFF_ROLES[number]
// Las sesiones de la PWA de mozos no vencen por tiempo. Siguen siendo
// revocables desde el panel al desactivar el usuario o cambiar su PIN.
export const STAFF_SESSION_HOURS: number | null = null
const MAX_PIN_ATTEMPTS = 5
const PIN_LOCK_MINUTES = 15

export type StaffPrincipal = {
  usuarioId: number
  restauranteId: number
  sucursalId: number | null
  rol: StaffRole
  nombre: string
  sesionId: number
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')
export const generarCodigoAccesoStaff = () => randomBytes(12).toString('base64url')

/** Owner identity is separate from its restaurant login and is created lazily for new restaurants. */
export async function asegurarOwnerStaff(db: any, restauranteId: number) {
  const [existing] = await db.select().from(UsuarioRestauranteTable).where(and(
    eq(UsuarioRestauranteTable.restauranteId, restauranteId),
    eq(UsuarioRestauranteTable.rol, 'owner'),
  )).limit(1)
  if (existing) return existing

  const [restaurante] = await db.select({ nombre: RestauranteTable.nombre })
    .from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1)
  if (!restaurante) throw new Error('Restaurante no encontrado al resolver owner')
  const result = await db.insert(UsuarioRestauranteTable).values({
    restauranteId,
    nombre: restaurante.nombre?.trim() || `Owner #${restauranteId}`,
    rol: 'owner',
    activo: true,
  })
  const id = Number(result[0].insertId)
  const [owner] = await db.select().from(UsuarioRestauranteTable).where(eq(UsuarioRestauranteTable.id, id)).limit(1)
  return owner
}

export async function crearSesionStaff(db: any, usuario: any) {
  const expiraAt = null
  const raw = randomBytes(32).toString('base64url')
  const result = await db.insert(SesionStaffTable).values({
    usuarioRestauranteId: usuario.id,
    tokenHash: tokenHash(raw),
    expiraAt,
  })
  const sesionId = Number(result[0].insertId)
  const token = jwt.sign({
    typ: 'staff', sid: sesionId, uid: usuario.id, rid: usuario.restauranteId,
    rol: usuario.rol, sucursalId: usuario.sucursalId, nonce: raw,
  }, process.env.JWT_SECRET || 'fallback-secret')
  await db.update(UsuarioRestauranteTable).set({ ultimoAccesoAt: new Date(), intentosPinFallidos: 0, bloqueadoHasta: null, updatedAt: new Date() })
    .where(eq(UsuarioRestauranteTable.id, usuario.id))
  return { token, expiraAt, sesionId }
}

export async function autenticarStaffConPin(db: any, codigoAcceso: string, pin: string) {
  const [usuario] = await db.select().from(UsuarioRestauranteTable)
    .where(eq(UsuarioRestauranteTable.codigoAcceso, codigoAcceso)).limit(1)
  // Deliberadamente no revela si el código o el PIN falló.
  if (!usuario || !usuario.activo || !usuario.pinHash) return { error: 'CREDENCIALES_INVALIDAS' as const }
  const ahora = new Date()
  if (usuario.bloqueadoHasta && usuario.bloqueadoHasta > ahora) return { error: 'BLOQUEADO' as const, bloqueadoHasta: usuario.bloqueadoHasta }
  if (!(await bcrypt.compare(pin, usuario.pinHash))) {
    const intentos = usuario.intentosPinFallidos + 1
    const bloqueadoHasta = intentos >= MAX_PIN_ATTEMPTS ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000) : null
    await db.update(UsuarioRestauranteTable).set({
      intentosPinFallidos: bloqueadoHasta ? 0 : intentos,
      bloqueadoHasta,
      updatedAt: ahora,
    }).where(eq(UsuarioRestauranteTable.id, usuario.id))
    return bloqueadoHasta ? { error: 'BLOQUEADO' as const, bloqueadoHasta } : { error: 'CREDENCIALES_INVALIDAS' as const }
  }
  return { usuario, ...(await crearSesionStaff(db, usuario)) }
}

export async function resolverSesionStaff(db: any, token: string): Promise<StaffPrincipal | null> {
  let decoded: any
  // Las sesiones emitidas antes de esta versión tienen un claim `exp` de 12 h.
  // Su vigencia se decide exclusivamente por la sesión persistida, lo que
  // permite extenderlas sin forzar otro OTP y conserva la revocación server-side.
  try { decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret', { ignoreExpiration: true }) } catch { return null }
  if (decoded?.typ !== 'staff' || !Number.isInteger(decoded.sid) || !Number.isInteger(decoded.uid) || !Number.isInteger(decoded.rid) || typeof decoded.nonce !== 'string') return null
  const [sesion] = await db.select({ id: SesionStaffTable.id, usuarioId: SesionStaffTable.usuarioRestauranteId })
    .from(SesionStaffTable)
    .where(and(
      eq(SesionStaffTable.id, decoded.sid),
      eq(SesionStaffTable.tokenHash, tokenHash(decoded.nonce)),
      isNull(SesionStaffTable.revocadaAt),
      or(isNull(SesionStaffTable.expiraAt), gt(SesionStaffTable.expiraAt, new Date())),
    ))
    .limit(1)
  if (!sesion || sesion.usuarioId !== decoded.uid) return null
  const [usuario] = await db.select().from(UsuarioRestauranteTable).where(and(
    eq(UsuarioRestauranteTable.id, decoded.uid), eq(UsuarioRestauranteTable.restauranteId, decoded.rid), eq(UsuarioRestauranteTable.activo, true),
  )).limit(1)
  if (!usuario || usuario.rol !== decoded.rol) return null
  return { usuarioId: usuario.id, restauranteId: usuario.restauranteId, sucursalId: usuario.sucursalId, rol: usuario.rol, nombre: usuario.nombre, sesionId: sesion.id }
}

export async function revocarSesionesStaff(db: any, usuarioId: number) {
  await db.update(SesionStaffTable).set({ revocadaAt: new Date() })
    .where(and(eq(SesionStaffTable.usuarioRestauranteId, usuarioId), isNull(SesionStaffTable.revocadaAt)))
}

/**
 * Extrae el número nacional argentino de 10 dígitos (código de área + número local)
 * tolerando prefijos internacionales (+54, 549, 54), interurbanos (0) y móviles (9, 15).
 */
export function extraerTelefonoArgentino10(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = raw.replace(/\D/g, '')
  if (!d) return null

  // 1) Si empieza con 549 (WhatsApp internacional Argentina, ej: 5493415123456)
  if (d.startsWith('549')) {
    const resto = d.slice(3)
    if (resto.length === 10) return resto
    d = resto
  } else if (d.startsWith('540')) {
    d = d.slice(3)
  } else if (d.startsWith('54')) {
    const resto = d.slice(2)
    if (resto.length === 10) return resto
    d = resto
  }

  // 2) Quitar 0 inicial si existe
  if (d.startsWith('0')) {
    d = d.slice(1)
  }

  // 3) Si tiene 10 dígitos exactos, es el número nacional
  if (d.length === 10) {
    return d
  }

  // 4) Si tiene 11 dígitos y empieza con 9 (ej: 9 351 123 4567)
  if (d.length === 11 && d.startsWith('9')) {
    return d.slice(1)
  }

  // 5) Formato con "15" móvil (12 dígitos tras quitar 0):
  // Área de 2 dígitos (11), 3 dígitos (341, 351, etc.) o 4 dígitos (3476, etc.)
  if (d.length === 12) {
    if (d.slice(2, 4) === '15') return d.slice(0, 2) + d.slice(4)
    if (d.slice(3, 5) === '15') return d.slice(0, 3) + d.slice(5)
    if (d.slice(4, 6) === '15') return d.slice(0, 4) + d.slice(6)
  }

  return null
}

/**
 * Formatea un número al estándar internacional para WhatsApp (549 + 10 dígitos para Argentina).
 */
export function formatearParaWhatsApp(raw: string): string {
  const n10 = extraerTelefonoArgentino10(raw)
  if (n10) return `549${n10}`
  const d = raw.replace(/\D/g, '')
  if (d.startsWith('54') && !d.startsWith('549') && d.length === 12) {
    return `549${d.slice(2)}`
  }
  return d
}

/**
 * Determina si dos representaciones de teléfono corresponden al mismo número,
 * tolerando diferencias de código de país, prefijo móvil, prefijo 0, espacios o símbolos.
 */
export function telefonosCoinciden(telA: string | null | undefined, telB: string | null | undefined): boolean {
  if (!telA || !telB) return false
  const cleanA = telA.replace(/\D/g, '')
  const cleanB = telB.replace(/\D/g, '')
  if (!cleanA || !cleanB) return false

  if (cleanA === cleanB) return true

  const n10A = extraerTelefonoArgentino10(telA)
  const n10B = extraerTelefonoArgentino10(telB)
  if (n10A && n10B && n10A === n10B) return true

  // Fallback: si uno termina con el otro (mínimo 8 dígitos)
  if (cleanA.length >= 8 && cleanB.length >= 8) {
    if (cleanA.endsWith(cleanB) || cleanB.endsWith(cleanA)) return true
  }

  return false
}

