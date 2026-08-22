const VENTANA_PEDIDO_REPETIDO_MS = 30 * 60 * 1000

interface ItemHistorial {
  nombreProducto: string
  cantidad: number
  precioUnitario: string
}

interface PedidoHistorialDeduplicable {
  id: number
  tipo: string
  total: string
  createdAt: Date | string
  items: ItemHistorial[]
}

function firmaPedido(pedido: PedidoHistorialDeduplicable): string {
  const items = pedido.items
    .map((item) => `${item.nombreProducto}\u0000${item.precioUnitario}\u0000${item.cantidad}`)
    .sort()
    .join('\u0001')

  return `${pedido.tipo}\u0002${pedido.total}\u0002${items}`
}

/**
 * El checkout por WhatsApp persiste el pedido antes de abrir la aplicación y no
 * recibe confirmación de que el usuario finalmente envió el mensaje. Si vuelve
 * al menú y reintenta, puede quedar el mismo carrito registrado dos veces.
 *
 * Esto sólo depura el read-model de Clientes: conserva el registro más nuevo de
 * un carrito idéntico dentro de la misma sesión y nunca borra datos de pedidos.
 */
export function deduplicarPedidosHistorial<T extends PedidoHistorialDeduplicable>(pedidos: T[]): T[] {
  const ordenados = [...pedidos].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  const ultimoPorFirma = new Map<string, number>()

  return ordenados.filter((pedido) => {
    const timestamp = new Date(pedido.createdAt).getTime()
    if (!Number.isFinite(timestamp)) return true

    const firma = firmaPedido(pedido)
    const ultimoTimestamp = ultimoPorFirma.get(firma)
    if (ultimoTimestamp != null && ultimoTimestamp - timestamp <= VENTANA_PEDIDO_REPETIDO_MS) {
      return false
    }

    ultimoPorFirma.set(firma, timestamp)
    return true
  })
}

