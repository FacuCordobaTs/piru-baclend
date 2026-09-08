import type { Context, Next } from 'hono'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { pedidoUnificado } from '../db/schema'
import { tienePosDeEvento } from '../lib/sucursales-operacion'
import { MODULE_KEYS } from '../lib/modulos'
import { requireModulo } from './modulo'

/** Para altas con body ya validado y consultas auxiliares del POS. */
export async function requirePosEnSucursal(c: Context, next: Next, sucursalId?: number) {
  const restauranteId = Number((c as any).user?.id)
  if (restauranteId && await tienePosDeEvento(drizzle(pool), restauranteId, sucursalId)) return next()
  return requireModulo(MODULE_KEYS.POS)(c, next)
}

/** Edición: la excepción se obtiene del pedido persistido, nunca del body/query. */
export async function requirePosDelPedido(c: Context, next: Next) {
  const restauranteId = Number((c as any).user?.id)
  const id = Number(c.req.param('id'))
  if (!restauranteId) return c.json({ success: false, message: 'No autenticado' }, 401)
  if (!Number.isInteger(id) || id < 1) return c.json({ success: false, message: 'ID inválido' }, 400)
  const [pedido] = await drizzle(pool).select({ sucursalId: pedidoUnificado.sucursalId })
    .from(pedidoUnificado).where(and(eq(pedidoUnificado.id, id), eq(pedidoUnificado.restauranteId, restauranteId))).limit(1)
  return requirePosEnSucursal(c, next, pedido?.sucursalId ?? undefined)
}

export const requirePosConsulta = (c: Context, next: Next) => requirePosEnSucursal(c, next, Number(c.req.query('sucursalId')))
