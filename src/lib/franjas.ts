import { drizzle } from 'drizzle-orm/mysql2'
import { and, eq, ne, gte, sql } from 'drizzle-orm'
import { pedidoUnificado as PedidoUnificadoTable } from '../db/schema'

type Db = ReturnType<typeof drizzle>

type FranjaParaConteo = {
  horaInicio: string
  horaFin: string
  cupoReseteadoAt: Date | null
}

/**
 * Cuenta los pedidos pagados de HOY que corresponden a una franja de horario.
 * Un pedido pertenece a la franja si su `horarioProgramado` es "HH:mm-HH:mm" (inicio-fin).
 * Se excluyen los pedidos cancelados y, si la franja fue reseteada manualmente,
 * solo se cuentan los pedidos creados a partir del reseteo.
 */
export async function contarPedidosPagadosFranja(
  db: Db,
  restauranteId: number,
  franja: FranjaParaConteo,
): Promise<number> {
  const valorHorario = `${franja.horaInicio}-${franja.horaFin}`
  const condiciones = [
    eq(PedidoUnificadoTable.restauranteId, restauranteId),
    eq(PedidoUnificadoTable.pagado, true),
    ne(PedidoUnificadoTable.estado, 'cancelled'),
    eq(PedidoUnificadoTable.horarioProgramado, valorHorario),
    sql`DATE(${PedidoUnificadoTable.createdAt}) = CURDATE()`,
  ]
  if (franja.cupoReseteadoAt) {
    condiciones.push(gte(PedidoUnificadoTable.createdAt, franja.cupoReseteadoAt))
  }

  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(PedidoUnificadoTable)
    .where(and(...condiciones))

  return Number(row?.total ?? 0)
}
