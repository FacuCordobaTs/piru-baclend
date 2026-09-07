import { and, eq } from 'drizzle-orm'
import { pedidoUnificado } from '../db/schema'
import { bloquearIdentidadesRestaurante } from './clientes-identidad'

export async function buscarPedidoPorRequest(db: any, restauranteId: number, requestId?: string, lock = false) {
  if (!requestId) return null
  const query = db.select().from(pedidoUnificado).where(and(
    eq(pedidoUnificado.restauranteId, restauranteId), eq(pedidoUnificado.clientRequestId, requestId),
  )).limit(1)
  const [pedido] = await (lock ? query.for('update') : query)
  return pedido ?? null
}

/** El lock precede al de mesa: un retry de mesa devuelve su pedido existente. */
export async function crearPedidoPosUnaVez<T>(db: any, restauranteId: number, requestId: string | undefined,
  crear: (tx: any) => Promise<T>): Promise<{ repetido: any; creado?: never } | { repetido?: never; creado: T }> {
  try {
    return await db.transaction(async (tx: any) => {
      await bloquearIdentidadesRestaurante(tx, restauranteId)
      const repetido = await buscarPedidoPorRequest(tx, restauranteId, requestId, true)
      if (repetido) return { repetido }
      return { creado: await crear(tx) }
    })
  } catch (error: any) {
    if (requestId && (error?.code === 'ER_DUP_ENTRY' || error?.cause?.code === 'ER_DUP_ENTRY')) {
      const repetido = await buscarPedidoPorRequest(db, restauranteId, requestId)
      if (repetido) return { repetido }
    }
    throw error
  }
}
