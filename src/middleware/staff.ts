import type { Context, Next } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { resolverSesionStaff, type StaffPrincipal, type StaffRole } from '../lib/staff'

export type StaffContext = Context & { staff: StaffPrincipal }

/** Strictly accepts a staff session; restaurant-owner JWTs never pass this gate. */
export const staffAuthMiddleware = async (c: Context, next: Next) => {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer ')) return c.json({ error: 'Authorization header required' }, 401)
  const staff = await resolverSesionStaff(drizzle(pool), header.slice(7))
  if (!staff) return c.json({ error: 'Sesión de staff inválida o vencida' }, 401)
  ;(c as StaffContext).staff = staff
  await next()
}

export const requireStaffRole = (...roles: StaffRole[]) => async (c: Context, next: Next) => {
  const staff = (c as Partial<StaffContext>).staff
  if (!staff || !roles.includes(staff.rol)) return c.json({ error: 'Permisos insuficientes' }, 403)
  await next()
}
