import { describe, expect, test } from 'bun:test'
import { calcularBeneficioCupon } from './cupones'

const cupon = { tipo: 'envio_gratis', valor: '0', montoMinimo: '10000' } as const

describe('cupón de envío gratis', () => {
  test('bonifica el envío de cada zona y conserva el precio de los productos', () => {
    for (const costoEnvio of [500, 1800, 15000]) {
      const total = 12000 + costoEnvio
      const beneficio = calcularBeneficioCupon(cupon, { total, tipoPedido: 'delivery', costoEnvio })
      expect(beneficio).toEqual({ montoDescuento: costoEnvio })
      expect(total - beneficio.montoDescuento!).toBe(12000)
    }
  })

  test('la compra mínima no incluye envío, aunque el total la supere', () => {
    expect(calcularBeneficioCupon(cupon, { total: 11000, tipoPedido: 'delivery', costoEnvio: 2000 }))
      .toEqual({ error: 'El código requiere un mínimo de $10000' })
    expect(calcularBeneficioCupon(cupon, { total: 12000, tipoPedido: 'delivery', costoEnvio: 2000 }))
      .toEqual({ montoDescuento: 2000 })
  })

  test('no aplica a retiro ni a un checkout que no indique delivery', () => {
    for (const tipoPedido of ['takeaway', undefined] as const) {
      expect(calcularBeneficioCupon(cupon, { total: 12000, tipoPedido, costoEnvio: 2000 }).error)
        .toBe('Este cupón es válido sólo para delivery')
    }
  })

  test('no consume un beneficio en envíos ya gratuitos o canjeados con puntos', () => {
    for (const costoEnvio of [0, undefined]) {
      expect(calcularBeneficioCupon(cupon, { total: 12000, tipoPedido: 'delivery', costoEnvio }).error)
        .toContain('requiere un envío con costo')
    }
  })

  test('el valor guardado nunca convierte el cupón en un descuento de productos', () => {
    expect(calcularBeneficioCupon({ ...cupon, valor: '99999' }, { total: 13000, tipoPedido: 'delivery', costoEnvio: 1000 }))
      .toEqual({ montoDescuento: 1000 })
  })
})

test('porcentaje y monto fijo conservan su base, tope y compra mínima', () => {
  const pedido = { total: 12500, tipoPedido: 'delivery', costoEnvio: 2500 } as const
  expect(calcularBeneficioCupon({ tipo: 'porcentaje', valor: '10' }, pedido)).toEqual({ montoDescuento: 1250 })
  expect(calcularBeneficioCupon({ tipo: 'monto_fijo', valor: '3000' }, pedido)).toEqual({ montoDescuento: 3000 })
  expect(calcularBeneficioCupon({ tipo: 'monto_fijo', valor: '99999' }, pedido)).toEqual({ montoDescuento: 12500 })
  expect(calcularBeneficioCupon({ tipo: 'porcentaje', valor: '10', montoMinimo: '13000' }, pedido).error)
    .toBe('El código requiere un mínimo de $13000')
})
