import { describe, expect, test } from 'bun:test'
import { acreditarPuntosPedidoAprobado, correspondeAcreditarPuntos, esEstadoPedidoDespachado } from './puntos'

/**
 * Regla del club: los puntos de un pedido se suman recién cuando el pedido fue despachado.
 * Cobrar no alcanza: mientras el pedido siga activo no se acredita nada.
 */

function dbConPedido(pedido: Record<string, unknown>) {
  const inserts: any[] = []
  const db: any = {
    transaction: async (trabajo: (tx: any) => Promise<any>) => trabajo(db),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ ...pedido }] }),
      }),
    }),
    insert: () => ({
      values: async (values: any) => {
        inserts.push(values)
        return [{ insertId: 1 }]
      },
    }),
    update: () => ({
      set: () => ({ where: async () => [{ affectedRows: 1 }] }),
    }),
  }
  return { db, inserts }
}

describe('acreditación de puntos del club', () => {
  test('un pedido todavía activo no suma puntos aunque ya esté cobrado', () => {
    for (const estado of ['pending', 'received', 'preparing', 'ready', null, undefined]) {
      expect(correspondeAcreditarPuntos({ estado })).toBe(false)
    }
  })

  test('suma al despacharse, sin exigir un cobro previo', () => {
    for (const estado of ['dispatched', 'delivered', 'archived']) {
      expect(correspondeAcreditarPuntos({ estado })).toBe(true)
    }
  })

  test('"despachado" incluye los estados que escribe la entrega', () => {
    expect(esEstadoPedidoDespachado('archived')).toBe(true)
    expect(esEstadoPedidoDespachado('dispatched')).toBe(true)
    expect(esEstadoPedidoDespachado('delivered')).toBe(true)
    expect(esEstadoPedidoDespachado('preparing')).toBe(false)
    expect(esEstadoPedidoDespachado(null)).toBe(false)
  })

  test('acreditar un pedido aún no despachado no escribe nada', async () => {
    const { db, inserts } = dbConPedido({
      id: 42,
      restauranteId: 7,
      clienteId: 1,
      estado: 'pending',
      puntosGanados: 100,
      puntosBonus: 0,
      puntosBonusClave: null,
      marketingCampanaId: null,
    })
    expect(await acreditarPuntosPedidoAprobado(db, 42)).toBe(false)
    expect(inserts).toHaveLength(0)
  })
})
