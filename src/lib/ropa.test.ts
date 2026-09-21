import { describe, expect, test } from 'bun:test'
import {
  calcularTotales,
  hexDeColor,
  leerColores,
  leerImagenes,
  leerTalles,
  validarVariante,
  type RopaProductoRow,
} from './ropa'

const producto = (overrides: Partial<RopaProductoRow> = {}): RopaProductoRow => ({
  id: 1,
  nombre: 'Hoodie Drop 01',
  precio: '45000.00',
  imagenes: ['https://cdn.piru.app/a.jpg', 'https://cdn.piru.app/b.jpg'],
  talles: ['S', 'M', 'L'],
  colores: [{ nombre: 'Negro', hex: '#000000' }, { nombre: 'Crema', hex: '#F5F0E6' }],
  stock: null,
  activo: true,
  ...overrides,
})

describe('lectura de columnas JSON', () => {
  test('acepta tanto array ya parseado como el string que devuelve MySQL', () => {
    expect(leerTalles(['S', 'M'])).toEqual(['S', 'M'])
    expect(leerTalles('["S","M"]')).toEqual(['S', 'M'])
    expect(leerColores('[{"nombre":"Negro","hex":"#000"}]')).toEqual([{ nombre: 'Negro', hex: '#000' }])
  })

  test('un JSON roto o de otro tipo no rompe el catálogo', () => {
    expect(leerTalles('no es json')).toEqual([])
    expect(leerTalles(null)).toEqual([])
    expect(leerTalles({})).toEqual([])
    expect(leerImagenes(undefined)).toEqual([])
    // Entradas vacías o de tipo equivocado se descartan una por una.
    expect(leerTalles(['S', '', null as unknown as string, 'M'])).toEqual(['S', 'M'])
    expect(leerColores([{ nombre: '  ' }, 'x', null])).toEqual([])
  })
})

describe('validarVariante', () => {
  test('acepta talle y color de la lista del producto', () => {
    expect(validarVariante(producto(), 'M', 'Negro')).toBeNull()
  })

  test('rechaza un talle que el producto no ofrece', () => {
    const error = validarVariante(producto(), 'XXL', 'Negro')
    expect(error).toContain('Talle inválido')
    expect(error).toContain('S, M, L')
  })

  test('rechaza un color que el producto no ofrece, y el caso sin color', () => {
    expect(validarVariante(producto(), 'M', 'Fucsia')).toContain('Color inválido')
    expect(validarVariante(producto(), 'M', null)).toContain('Color inválido')
    expect(validarVariante(producto(), null, 'Negro')).toContain('Talle inválido')
  })

  test('un producto sin talles ni colores cargados acepta cualquier combinación vacía', () => {
    const libre = producto({ talles: [], colores: [] })
    expect(validarVariante(libre, null, null)).toBeNull()
    // Pero si el cliente manda un talle inventado, se ignora en vez de rechazarse:
    // el producto no declara talles, así que no hay lista contra la cual validar.
    expect(validarVariante(libre, 'XXL', 'Fucsia')).toBeNull()
  })

  test('hexDeColor resuelve el hex y devuelve null cuando no hay color', () => {
    expect(hexDeColor(producto(), 'Crema')).toBe('#F5F0E6')
    expect(hexDeColor(producto(), 'Inexistente')).toBeNull()
    expect(hexDeColor(producto(), null)).toBeNull()
  })
})

describe('calcularTotales', () => {
  const items = [
    { cantidad: 2, precioUnitario: 45000 },
    { cantidad: 1, precioUnitario: 12500.5 },
  ]

  test('suma cantidad × precio y cobra el envío sólo en modalidad envio', () => {
    expect(calcularTotales(items, 'envio', 3500)).toEqual({
      subtotal: 102500.5,
      costoEnvio: 3500,
      total: 106000.5,
    })
    expect(calcularTotales(items, 'retiro', 3500)).toEqual({
      subtotal: 102500.5,
      costoEnvio: 0,
      total: 102500.5,
    })
  })

  test('no acumula error de coma flotante al sumar precios con centavos', () => {
    // 0.1 + 0.2 en floats da 0.30000000000000004; en centavos tiene que dar 0.3 exacto.
    const centavos = [
      { cantidad: 1, precioUnitario: 0.1 },
      { cantidad: 1, precioUnitario: 0.2 },
    ]
    expect(calcularTotales(centavos, 'retiro', 0).subtotal).toBe(0.3)
  })

  test('un costo de envío negativo o basura nunca resta del total', () => {
    expect(calcularTotales(items, 'envio', -500).costoEnvio).toBe(0)
    expect(calcularTotales(items, 'envio', Number.NaN).costoEnvio).toBe(0)
  })

  test('un carrito vacío da todo en cero', () => {
    expect(calcularTotales([], 'envio', 3500)).toEqual({
      subtotal: 0,
      costoEnvio: 3500,
      total: 3500,
    })
  })

  test('acepta los precios como string decimal, que es como los devuelve MySQL', () => {
    const desdeDb = [{ cantidad: 3, precioUnitario: '1999.99' as unknown as number }]
    expect(calcularTotales(desdeDb, 'retiro', 0).total).toBe(5999.97)
  })
})
