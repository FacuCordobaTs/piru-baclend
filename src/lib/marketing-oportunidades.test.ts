import { describe, expect, test } from 'bun:test'
import { filtrarOportunidadesMarketing, resolverOportunidadesMarketing } from './marketing-oportunidades'

const ahora = new Date('2026-08-28T15:00:00.000Z')
const haceDias = (dias: number) => new Date(ahora.getTime() - dias * 24 * 60 * 60 * 1000)

function datos() {
  return {
    clientes: [
      { id: 1, nombre: 'VIP dormido', marketingOptOut: false },
      { id: 2, nombre: 'Baja', marketingOptOut: true },
      { id: 3, nombre: 'Activo', marketingOptOut: false },
    ],
    pedidos: [
      ...Array.from({ length: 6 }, (_, i) => ({ id: i + 1, clienteId: 1, total: 10000, createdAt: haceDias(170 - i * 20) })),
      { id: 20, clienteId: 2, total: 2000, createdAt: haceDias(2) },
      { id: 30, clienteId: 3, total: 3000, createdAt: haceDias(3) },
    ],
    items: [{ pedidoId: 6, productoId: 10, cantidad: 2 }, { pedidoId: 20, productoId: 11, cantidad: 1 }],
    productos: [{ id: 10, nombre: 'Pizza' }, { id: 11, nombre: 'Empanada' }],
    recuperos: [], contactos: [],
  }
}

describe('resolverOportunidadesMarketing', () => {
  test('clasifica en batch, prioriza un VIP enfriado y conserva su destino', () => {
    const oportunidades = resolverOportunidadesMarketing(datos(), [{
      id: 99, clienteId: 1, recetaCodigo: 'recuperar_habito', destinoTipo: 'carrito', productoId: null,
      carritoRep: '10x2', codigoDescuentoId: null, activo: true, expiraAt: null, createdAt: haceDias(1),
    }], ahora)
    const vip = oportunidades[0]
    expect(vip.cliente.id).toBe(1)
    expect(vip.prioridad).toBe('alta')
    expect(vip.diagnostico.esVip).toBe(true)
    expect(vip.receta.codigo).toBe('recuperar_habito')
    expect(vip.destino).toEqual({ tipo: 'carrito', carritoRep: '10x2' })
    expect(vip.ultimoEnlacePreparado?.id).toBe(99)
  })

  test('muestra opt-out como bloqueo visible, sin volverlo accionable', () => {
    const baja = resolverOportunidadesMarketing(datos(), [], ahora).find((oportunidad) => oportunidad.cliente.id === 2)!
    expect(baja.elegibilidad.elegible).toBe(false)
    expect(baja.elegibilidad.bloqueos).toEqual(expect.arrayContaining([expect.objectContaining({ motivo: 'opt_out' })]))
  })

  test('recomienda la segunda compra aunque el único pedido sea antiguo', () => {
    const oportunidad = resolverOportunidadesMarketing({
      clientes: [{ id: 4, nombre: 'Primer pedido antiguo', marketingOptOut: false }],
      pedidos: [{ id: 40, clienteId: 4, total: 5000, createdAt: haceDias(365) }],
      items: [{ pedidoId: 40, productoId: 12, cantidad: 1 }],
      productos: [{ id: 12, nombre: 'Milanesa' }],
      recuperos: [],
      contactos: [],
    }, [], ahora)[0]

    expect(oportunidad.diagnostico.segmento).toBe('nuevo')
    expect(oportunidad.receta.codigo).toBe('segunda_compra')
    expect(oportunidad.destino).toEqual({ tipo: 'carrito', carritoRep: '12x1' })
  })

  test('filtra por segmento y receta sin alterar la clasificación', () => {
    const oportunidades = resolverOportunidadesMarketing(datos(), [], ahora)
    const vip = oportunidades.find((oportunidad) => oportunidad.cliente.id === 1)!
    expect(filtrarOportunidadesMarketing(oportunidades, { segmento: vip.diagnostico.segmento })).toEqual([vip])
    expect(filtrarOportunidadesMarketing(oportunidades, { receta: vip.receta.codigo })).toEqual([vip])
  })
})
