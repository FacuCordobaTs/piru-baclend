import type { Context, Next } from 'hono'
import * as jwt from 'jsonwebtoken'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { marketer } from '../db/schema'

export interface MarketerContext extends Context {
  marketer: typeof marketer.$inferSelect
}
export async function marketerAuthMiddleware(c: Context, next: Next) {
  const header = c.req.header('Authorization')
  if (!header?.startsWith('Bearer '))
    return c.json({ error: 'Iniciá sesión' }, 401)
  let decoded: { scope?: string; marketerId?: number }
  try {
    decoded = jwt.verify(
      header.slice(7),
      process.env.JWT_SECRET || 'fallback-secret',
    ) as typeof decoded
  } catch {
    return c.json({ error: 'Sesión vencida' }, 401)
  }
  if (
    decoded.scope !== 'marketer' ||
    !Number.isInteger(decoded.marketerId) ||
    Number(decoded.marketerId) <= 0
  )
    return c.json({ error: 'Sesión de marketer requerida' }, 401)
  const [row] = await drizzle(pool)
    .select()
    .from(marketer)
    .where(and(eq(marketer.id, decoded.marketerId!), eq(marketer.activo, true)))
    .limit(1)
  if (!row) return c.json({ error: 'La cuenta está desactivada' }, 401)
  ;(c as MarketerContext).marketer = row
  await next()
}
