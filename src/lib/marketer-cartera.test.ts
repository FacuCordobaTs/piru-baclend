import { expect, test } from 'bun:test'
import { metricasCartera } from './marketer-cartera'

test('cuenta actividad pero sólo factura pedidos cobrados y conserva ocho semanas', () => {
  const ahora = new Date('2026-10-03T20:00:00Z')
  const datos = metricasCartera(
    [
      {
        restauranteId: 6,
        createdAt: new Date('2026-10-02T20:00:00Z'),
        pagado: true,
        total: '13500',
      },
      {
        restauranteId: 6,
        createdAt: new Date('2026-10-02T21:00:00Z'),
        pagado: false,
        total: '5000',
      },
      {
        restauranteId: 6,
        createdAt: new Date('2026-08-30T20:00:00Z'),
        pagado: true,
        total: '10000',
      },
      {
        restauranteId: 6,
        createdAt: new Date('2026-07-03T20:00:00Z'),
        pagado: true,
        total: '999999',
      },
    ],
    ahora,
  )
  expect(datos.ventas30d).toBe(13500)
  expect(datos.ventas30dAnterior).toBe(10000)
  expect(datos.pedidos30d).toBe(2)
  expect(datos.ventasSemanales).toHaveLength(8)
  expect(datos.ventasSemanales[7]).toBe(13500)
})
