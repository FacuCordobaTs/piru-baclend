import { and, eq, gte, sql } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { pedidoUnificado } from '../db/schema'
import { pedidoReal } from './pedido-ejemplo'

type Db = MySql2Database<Record<string, never>>

/**
 * El contador de VALOR de la prueba y de la pausa: "Recibiste X pedidos por $Y". Cuenta los pedidos
 * que ENTRARON por Piru (web, no anotados a mano) desde que arrancó el ciclo (`desde`).
 *
 * El panel (`/planes/mi-suscripcion`) muestra al dueño el valor generado por Piru:
 * nunca cuenta los pedidos de ejemplo de la demo (`pedidoReal`).
 */
export async function contarValorPiru(
  db: Db,
  restauranteId: number,
  desde: Date,
): Promise<{ pedidos: number; monto: number }> {
  const [fila] = await db
    .select({
      pedidos: sql<number>`COUNT(*)`,
      monto: sql<string>`COALESCE(SUM(${pedidoUnificado.total}), 0)`,
    })
    .from(pedidoUnificado)
    .where(
      and(
        eq(pedidoUnificado.restauranteId, restauranteId),
        eq(pedidoUnificado.anotadoManualmente, false),
        gte(pedidoUnificado.createdAt, desde),
        pedidoReal(),
      ),
    )
  return {
    pedidos: Number(fila?.pedidos ?? 0),
    monto: parseFloat(String(fila?.monto ?? '0')),
  }
}
