import { createHash, randomBytes } from 'node:crypto'
import * as bcrypt from 'bcrypt'
import * as jwt from 'jsonwebtoken'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { restaurante as RestauranteTable, sesionStaff as SesionStaffTable, usuarioRestaurante as UsuarioRestauranteTable } from '../db/schema'

export const STAFF_ROLES = ['owner', 'admin', 'mozo'] as const
export type StaffRole = typeof STAFF_ROLES[number]
export const STAFF_SESSION_HOURS = 12
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
  const expiraAt = new Date(Date.now() + STAFF_SESSION_HOURS * 60 * 60 * 1000)
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
  }, process.env.JWT_SECRET || 'fallback-secret', { expiresIn: `${STAFF_SESSION_HOURS}h` })
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
  try { decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret') } catch { return null }
  if (decoded?.typ !== 'staff' || !Number.isInteger(decoded.sid) || !Number.isInteger(decoded.uid) || !Number.isInteger(decoded.rid) || typeof decoded.nonce !== 'string') return null
  const [sesion] = await db.select({ id: SesionStaffTable.id, usuarioId: SesionStaffTable.usuarioRestauranteId })
    .from(SesionStaffTable)
    .where(and(eq(SesionStaffTable.id, decoded.sid), eq(SesionStaffTable.tokenHash, tokenHash(decoded.nonce)), isNull(SesionStaffTable.revocadaAt), gt(SesionStaffTable.expiraAt, new Date())))
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
