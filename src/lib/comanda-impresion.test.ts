import { describe, expect, test } from 'bun:test'
import { cantidadImpresaTrasEdicion, cantidadesPendientes, mismaConfiguracionItem } from './comanda-impresion'

const base = { productoId: 10, varianteId: null, varianteSecundariaId: null, ingredientesExcluidos: [2], agregados: [{ id: 4 }], nota: null }

describe('impresión incremental de comandas', () => {
  test('una unidad agregada queda como único delta pendiente', () => {
    expect(cantidadImpresaTrasEdicion({ ...base, cantidadImpresa: 2 }, { ...base, cantidad: 3 })).toBe(2)
    expect(cantidadesPendientes([{ id: 7, cantidad: 3, cantidadImpresa: 2 }])).toEqual([{ id: 7, cantidad: 1 }])
  })

  test('bajar cantidad no deja un contador impreso imposible', () => {
    expect(cantidadImpresaTrasEdicion({ ...base, cantidadImpresa: 3 }, { ...base, cantidad: 1 })).toBe(1)
    expect(cantidadesPendientes([{ id: 7, cantidad: 1, cantidadImpresa: 1 }])).toEqual([])
  })

  test('cambiar la configuración obliga a imprimir la fila completa', () => {
    const cambiado = { ...base, nota: 'sin sal' }
    expect(mismaConfiguracionItem(base, cambiado)).toBe(false)
    expect(cantidadImpresaTrasEdicion({ ...base, cantidadImpresa: 2 }, { ...cambiado, cantidad: 2 })).toBe(0)
  })

  test('tolera JSON serializado por el driver', () => {
    expect(mismaConfiguracionItem(base, { ...base, ingredientesExcluidos: '[2]', agregados: '[{"id":4}]' })).toBe(true)
  })
})
