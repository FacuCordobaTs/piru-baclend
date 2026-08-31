import { describe, expect, test } from 'bun:test'
import { aplicarOfertaProducto, ofertaProductoEstaVigente, type OfertaProductoCampana } from './campana-oferta'

const oferta = (overrides: Partial<OfertaProductoCampana> = {}): OfertaProductoCampana => ({
  id: 1, productoId: 10, descuentoProductoPorcentaje: 20, limiteUsos: null, usosActuales: 0,
  fechaInicio: null, fechaFin: null, ...overrides,
})

describe('oferta de producto de campaña', () => {
  test('sólo descuenta el producto asociado y no empeora su descuento propio', () => {
    expect(aplicarOfertaProducto(1000, 0, 10, oferta())).toMatchObject({ precioFinal: 800, descuentoAtribuibleCampana: 200 })
    expect(aplicarOfertaProducto(1000, 0, 11, oferta())).toMatchObject({ precioFinal: 1000, descuentoAtribuibleCampana: 0 })
    expect(aplicarOfertaProducto(1000, 30, 10, oferta())).toMatchObject({ precioFinal: 700, descuentoAtribuibleCampana: 0 })
  })

  test('respeta inicio, fin y cupo', () => {
    const ahora = new Date('2026-08-31T12:00:00.000Z')
    expect(ofertaProductoEstaVigente(oferta({ fechaInicio: new Date('2026-08-31T11:00:00.000Z'), fechaFin: new Date('2026-08-31T13:00:00.000Z') }), ahora)).toBe(true)
    expect(ofertaProductoEstaVigente(oferta({ fechaFin: new Date('2026-08-31T11:59:59.000Z') }), ahora)).toBe(false)
    expect(ofertaProductoEstaVigente(oferta({ limiteUsos: 5, usosActuales: 5 }), ahora)).toBe(false)
  })
})
