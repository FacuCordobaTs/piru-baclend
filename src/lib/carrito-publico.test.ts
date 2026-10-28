import { describe, expect, test } from 'bun:test'
import { crearLimitador, idCarrito, idCarritoValido, validarContexto, validarItems, validarReturnUrl } from './carrito-publico'

describe('carrito de handoff', () => {
  test('normaliza las líneas y rechaza lo que no es un carrito', () => {
    const r = validarItems([{ productoId: 10, cantidad: 2, varianteId: 3, agregados: [7, 7], nota: '  sin sal ', precio: 1 }])
    expect(r).toEqual({ items: [{ productoId: 10, cantidad: 2, varianteId: 3, agregados: [7], ingredientesExcluidos: [], nota: 'sin sal' }] })
    for (const malo of [[], null, [{ productoId: -1 }], [{ productoId: 1, cantidad: 100 }], [{ productoId: 1, agregados: ['x'] }], [{ productoId: 1, nota: 'x'.repeat(301) }], Array(51).fill({ productoId: 1 })])
      expect('error' in validarItems(malo)).toBe(true)
  })

  test('el contexto sólo lleva campos conocidos, sin PII', () => {
    expect(validarContexto({ campaniaSlug: 'promo-1', visitorId: 'abc', telefono: '342', nombre: 'Ana', codigoPromocional: 'HOLA 10' })).toEqual({ campaniaSlug: 'promo-1', visitorId: 'abc' })
  })

  test('la vuelta sólo al subdominio o a la tienda del mismo local', () => {
    expect(validarReturnUrl('https://bronx.piru.app/', 'bronx')).toBe('https://bronx.piru.app/')
    expect(validarReturnUrl('https://my.piru.app/bronx/c/promo?x=1', 'bronx')).toBe('https://my.piru.app/bronx/c/promo')
    for (const malo of ['https://otra.piru.app/', 'https://bronx.piru.app.evil.com/', 'http://bronx.piru.app/', 'https://my.piru.app/bronxx', 'javascript:alert(1)', 'https://user@bronx.piru.app/'])
      expect(validarReturnUrl(malo, 'bronx')).toBeNull()
  })

  test('ids opacos y límite por IP', () => {
    const id = idCarrito()
    expect(idCarritoValido(id)).toBe(true)
    expect(idCarritoValido('../../x')).toBe(false)
    const limitar = crearLimitador(2, 1000)
    expect([limitar('ip', 0), limitar('ip', 1), limitar('ip', 2), limitar('ip', 2000)]).toEqual([true, true, false, true])
  })
})
