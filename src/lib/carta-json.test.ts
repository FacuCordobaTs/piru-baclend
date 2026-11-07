import { describe, expect, test } from 'bun:test'
import {
  CARTA_JSON_EJEMPLO,
  INSTRUCTIVO_CARTA_JSON,
  avisosCartaJson,
  cartaJsonSchema,
  describirErroresCartaJson,
  normalizarCartaJson,
  normalizarNegocioCartaJson,
  normalizarTelefonoNegocio,
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

  test('normaliza la portada y las fotos extra sin duplicarlas', () => {
    const carta = cartaJsonSchema.parse({
      categorias: [{
        nombre: 'Hamburguesas',
        productos: [{
          nombre: 'Doble cheddar',
          precio: 8200,
          imagenUrl: 'https://cdn.local/doble.jpg',
          imagenesExtra: ['https://cdn.local/doble.jpg', 'https://cdn.local/doble-2.jpg'],
        }],
      }],
    })
    const producto = normalizarCartaJson(carta).categorias[0].productos[0] as any
    expect(producto.imagenUrl).toBe('https://cdn.local/doble.jpg')
    expect(producto.imagenesExtra).toEqual(['https://cdn.local/doble-2.jpg'])
  })

  test('si sólo llegan fotos extra, la primera pasa a ser portada', () => {
    const carta = cartaJsonSchema.parse({
      categorias: [{
        nombre: 'Hamburguesas',
        productos: [{ nombre: 'Doble cheddar', precio: 8200, imagenesExtra: ['https://cdn.local/a.jpg', 'https://cdn.local/b.jpg'] }],
      }],
    })
    const producto = normalizarCartaJson(carta).categorias[0].productos[0] as any
    expect(producto.imagenUrl).toBe('https://cdn.local/a.jpg')
    expect(producto.imagenesExtra).toEqual(['https://cdn.local/b.jpg'])
  })

  test('rechaza URLs de imagen inválidas y más de 5 extras', () => {
    const invalida = cartaJsonSchema.safeParse({
      categorias: [{ nombre: 'Hamburguesas', productos: [{ nombre: 'Doble', imagenUrl: 'no-es-una-url' }] }],
    })
    expect(invalida.success).toBe(false)

    const muchas = cartaJsonSchema.safeParse({
      categorias: [{
        nombre: 'Hamburguesas',
        productos: [{
          nombre: 'Doble',
          imagenUrl: 'https://cdn.local/a.jpg',
          imagenesExtra: Array.from({ length: 6 }, (_, i) => `https://cdn.local/${i}.jpg`),
        }],
      }],
    })
    expect(muchas.success).toBe(false)
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
    expect(INSTRUCTIVO_CARTA_JSON).toContain('imagenUrl')
    expect(INSTRUCTIVO_CARTA_JSON).toContain('imagenesExtra')
    expect(INSTRUCTIVO_CARTA_JSON).toContain(JSON.stringify(CARTA_JSON_EJEMPLO, null, 2))
    expect(INSTRUCTIVO_CARTA_JSON).toContain('sin bloques de Markdown')
    expect(INSTRUCTIVO_CARTA_JSON).toContain('Importar un JSON')
  })

  test('normaliza los datos del negocio y el WhatsApp', () => {
    const carta = cartaJsonSchema.parse(CARTA_JSON_EJEMPLO)
    expect(normalizarNegocioCartaJson(carta.negocio)).toEqual({
      nombre: 'Burger Ejemplo',
      telefono: '5493511234567',
      direccion: 'Av. Colón 1234, Córdoba',
      lat: -31.4135,
      lng: -64.1973,
      logoUrl: 'https://images.ejemplo.com/logo-burger-ejemplo.png',
    })
    expect(normalizarTelefonoNegocio('+54 9 351 123-4567')).toBe('5493511234567')
    expect(normalizarTelefonoNegocio('0351 1234567')).toBe('5493511234567')
    expect(normalizarTelefonoNegocio('123')).toBeNull()
    expect(normalizarNegocioCartaJson({ lat: -31 })).toBeNull()
    expect(cartaJsonSchema.safeParse({ ...CARTA_JSON_EJEMPLO, negocio: { telefono: '12' } }).success).toBe(false)
    expect(INSTRUCTIVO_CARTA_JSON).toContain('logoUrl')
    expect(INSTRUCTIVO_CARTA_JSON).toContain('-carta.json')
  })
})
