import { describe, expect, test } from 'bun:test'
import {
  CARTA_JSON_EJEMPLO,
  INSTRUCTIVO_CARTA_JSON,
  avisosCartaJson,
  cartaJsonSchema,
  describirErroresCartaJson,
  normalizarCartaJson,
} from './carta-json'

describe('carta JSON importada', () => {
  test('el ejemplo del instructivo es válido y normaliza todos los campos', () => {
    const resultado = cartaJsonSchema.safeParse(CARTA_JSON_EJEMPLO)
    expect(resultado.success).toBe(true)

    const carta = normalizarCartaJson(resultado.data!)
    expect(carta.categorias).toHaveLength(2)
    expect(carta.categorias[0].productos[0]).toMatchObject({
      nombre: 'Doble cheddar',
      precio: null,
      variantes: [
        { nombre: 'Simple', precio: 6500 },
        { nombre: 'Doble', precio: 8200 },
      ],
      extras: [
        { nombre: 'Extra cheddar', precio: 900 },
        { nombre: 'Bacon', precio: 1200 },
      ],
      permiteNota: true,
    })
    expect(carta.categorias[1].esBebida).toBe(true)
  })

  test('acepta precios como texto numérico y los convierte a número', () => {
    const resultado = cartaJsonSchema.safeParse({
      categorias: [{ nombre: 'Platos', productos: [{ nombre: 'Milanesa', precio: '7200.50' }] }],
    })
    expect(resultado.success).toBe(true)
    expect(normalizarCartaJson(resultado.data!).categorias[0].productos[0].precio).toBe(7200.5)
  })

  test('rechaza precios con símbolos o separadores de miles', () => {
    const resultado = cartaJsonSchema.safeParse({
      categorias: [{ nombre: 'Platos', productos: [{ nombre: 'Milanesa', precio: '$ 7.200' }] }],
    })
    expect(resultado.success).toBe(false)
    expect(describirErroresCartaJson(resultado.error!)).toContain('categorias[1].productos[1].precio')
  })

  test('rechaza categorías vacías, nombres vacíos y variantes secundarias sin principales', () => {
    expect(cartaJsonSchema.safeParse({ categorias: [] }).success).toBe(false)
    expect(cartaJsonSchema.safeParse({ categorias: [{ nombre: ' ', productos: [{ nombre: 'x' }] }] }).success).toBe(false)
    expect(cartaJsonSchema.safeParse({ categorias: [{ nombre: 'C', productos: [] }] }).success).toBe(false)

    const secundarias = cartaJsonSchema.safeParse({
      categorias: [{
        nombre: 'Pizzas',
        productos: [{
          nombre: 'Muzzarella',
          variantesSecundarias: [{ nombre: 'Familiar', precio: 0 }],
        }],
      }],
    })
    expect(secundarias.success).toBe(false)
    expect(describirErroresCartaJson(secundarias.error!)).toContain('necesita variantes principales')
  })

  test('advierte categorías o productos repetidos y productos sin precio', () => {
    const carta = cartaJsonSchema.parse({
      categorias: [
        { nombre: 'Bebidas', productos: [{ nombre: 'Agua' }, { nombre: 'Agua' }] },
        { nombre: 'bebidas', productos: [{ nombre: 'Coca', precio: 2500 }] },
      ],
    })
    const avisos = avisosCartaJson(carta)
    expect(avisos.join(' ')).toContain('Agua')
    expect(avisos.join(' ').toLowerCase()).toContain('categoría "bebidas" está repetida')
    expect(avisos.join(' ')).toContain('precio 0')
  })

  test('el instructivo incluye el contrato y el ejemplo real', () => {
    expect(INSTRUCTIVO_CARTA_JSON).toContain('"categorias"')
    expect(INSTRUCTIVO_CARTA_JSON).toContain('variantesSecundarias')
    expect(INSTRUCTIVO_CARTA_JSON).toContain(JSON.stringify(CARTA_JSON_EJEMPLO, null, 2))
    expect(INSTRUCTIVO_CARTA_JSON).toContain('sin bloques de Markdown')
    expect(INSTRUCTIVO_CARTA_JSON).toContain('Importar un JSON')
  })
})
