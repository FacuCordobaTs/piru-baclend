import { describe, expect, test } from 'bun:test'
import { deduplicarPedidosHistorial } from './clientes-historial'

const item = { nombreProducto: 'Pizza', cantidad: 1, precioUnitario: '16900.00' }

const pedido = (id: number, createdAt: string, overrides: Record<string, unknown> = {}) => ({
  id,
  tipo: 'delivery',
  total: '16900.00',
  createdAt,
  items: [item],
  ...overrides,
})

describe('historial de clientes', () => {
  test('colapsa un reintento idéntico de WhatsApp dentro de 30 minutos', () => {
    const resultado = deduplicarPedidosHistorial([
      pedido(7258, '2026-08-20T21:58:00.000Z'),
      pedido(7270, '2026-08-20T22:21:00.000Z'),
    ])

    expect(resultado.map((p) => p.id)).toEqual([7270])
  })

  test('conserva pedidos con otro carrito o fuera de la ventana', () => {
    const resultado = deduplicarPedidosHistorial([
      pedido(1, '2026-08-20T20:00:00.000Z'),
      pedido(2, '2026-08-20T20:10:00.000Z', { total: '20000.00' }),
      pedido(3, '2026-08-20T21:00:00.000Z'),
    ])

    expect(resultado.map((p) => p.id)).toEqual([3, 2, 1])
  })
})

