import { randomUUID } from 'crypto'
import { isNull, notLike, or, type SQL } from 'drizzle-orm'
import { pedidoUnificado } from '../db/schema'

/**
 * Marca de los pedidos de la demo de prospección (`datos-ejemplo-db.ts`): llevan este prefijo en
 * `client_request_id`, que ni el panel ni la tienda generan así. Es una convención, no una columna,
 * a propósito: `pedido_unificado` es la tabla caliente y una columna nueva ataría el deploy del
 * backend al SQL (el `select()` de Drizzle pide todas sus columnas).
 *
 * Las filas de ejemplo son reales para el panel del local —ahí se ven y cuentan, hasta que el dueño las
 * borra— pero NO son actividad. Todo número que mida si el local recibió pedidos de verdad se calcula
 * con `pedidoReal()`: el valor de la prueba (panel y aviso de vencimiento), el "primer pedido" del claim
 * y la cartera del marketer. Una consulta nueva de ese tipo tiene que sumarla.
 */
export const PREFIJO_REQUEST_EJEMPLO = 'ejemplo-'

/** El `client_request_id` de un pedido de ejemplo: único y de 20 caracteres (la columna admite 36). */
export const nuevoRequestIdEjemplo = () =>
  `${PREFIJO_REQUEST_EJEMPLO}${randomUUID().replace(/-/g, '').slice(0, 12)}`

export const esRequestIdEjemplo = (id: string | null | undefined) =>
  typeof id === 'string' && id.startsWith(PREFIJO_REQUEST_EJEMPLO)

/**
 * Condición SQL: el pedido NO es de ejemplo. Un pedido sin `client_request_id` (los de siempre) es
 * real: sin el `IS NULL`, `NOT LIKE` sobre NULL daría NULL y los dejaría afuera.
 */
export function pedidoReal(columna = pedidoUnificado.clientRequestId): SQL {
  return or(isNull(columna), notLike(columna, `${PREFIJO_REQUEST_EJEMPLO}%`)) as SQL
}
