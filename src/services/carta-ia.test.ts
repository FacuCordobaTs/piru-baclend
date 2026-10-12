import { expect, test } from 'bun:test'
import { normalizarCarta } from './carta-ia'

test('conserva dos elecciones, dos grupos de extras, títulos y notas sin sumar el precio dos veces', () => {
  const carta = normalizarCarta({ categorias: [{ nombre: 'Pizzas', productos: [{
    nombre: 'Pizza', precio: null, ingredientes: [' mozzarella '],
    variantes: [{ nombre: 'Grande', precio: 12000 }],
    variantesSecundarias: [{ nombre: 'Muzzarella', precio: 0 }, { nombre: 'Especial', precio: 1500 }],
    extras: [{ nombre: 'Aceitunas', precio: 500 }], extrasSecundarios: [{ nombre: 'Salsa picante', precio: 0 }],
    tituloVariantesPrimarias: ' Elegí el tamaño ', tituloVariantesSecundarias: 'Elegí el sabor',
    tituloExtrasPrimarios: 'Agregados', tituloExtrasSecundarios: 'Salsas', permiteNota: true, tituloNota: 'Aclaraciones',
  }] }] })
  const p = carta.categorias[0].productos[0]
  expect(p.variantesSecundarias?.map(v => v.precio)).toEqual([0, 1500])
  expect(p.extrasSecundarios?.[0].nombre).toBe('Salsa picante')
  expect(p.tituloVariantesPrimarias).toBe('Elegí el tamaño')
  expect(p.tituloExtrasSecundarios).toBe('Salsas')
  expect(p.permiteNota).toBe(true)
  expect(p.descripcion).toBe('Mozzarella')
})

test('un menú simple no inventa segunda elección ni extras, y conserva bebidas', () => {
  const p = normalizarCarta({ categorias: [{ nombre: 'Bebidas', esBebida: true, productos: [{ nombre: 'Agua', precio: 1000 }] }] })
  expect(p.categorias[0].esBebida).toBe(true)
  expect(p.categorias[0].productos[0].variantesSecundarias).toEqual([])
  expect(p.categorias[0].productos[0].extrasSecundarios).toEqual([])
})

test('ignora recargos inválidos y no permite una segunda elección sin la primera', () => {
  const p = normalizarCarta({ categorias: [{ nombre: 'Menú', productos: [{ nombre: 'Combo', variantesSecundarias: [{ nombre: 'Grande', precio: 1000 }], extrasSecundarios: [{ nombre: 'Roto', precio: -1 }] }] }] })
  expect(p.categorias[0].productos[0].variantesSecundarias).toEqual([])
  expect(p.categorias[0].productos[0].extrasSecundarios).toEqual([])
})
