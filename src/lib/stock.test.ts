import { describe, expect, test } from 'bun:test'
import {
  consumoDeItem,
  estaBajoStock,
  redondearCantidad,
  umbralStockMinimo,
  type RecetaConsumo,
} from './stock'

describe('control de stock', () => {
  test('redondea cantidades a tres decimales', () => {
    expect(redondearCantidad(1.23456)).toBe(1.235)
    expect(redondearCantidad(Number.NaN)).toBe(0)
  })

  test('usa el umbral explícito y, si falta, el 20% del máximo', () => {
    expect(umbralStockMinimo(3, 100)).toBe(3)
    expect(umbralStockMinimo(0, 100)).toBe(0)
    expect(umbralStockMinimo(null, 100)).toBe(20)
    expect(umbralStockMinimo(undefined, 0)).toBeNull()
  })

  test('una alerta explícita en cero sólo salta sin stock', () => {
    expect(estaBajoStock({ stockActual: 0, stockMinimo: 0, stockMaximo: 50 })).toBe(true)
    expect(estaBajoStock({ stockActual: 1, stockMinimo: 0, stockMaximo: 50 })).toBe(false)
  })

  test('un insumo inactivo no alerta', () => {
    expect(estaBajoStock({ stockActual: 0, stockMinimo: 5, stockMaximo: 50, activo: false })).toBe(false)
  })

  test('la receta base y las variantes elegidas se suman', () => {
    const recetas: RecetaConsumo[] = [
      { insumoId: 1, varianteId: null, cantidad: 1 },
      { insumoId: 1, varianteId: 10, cantidad: 1 },
      { insumoId: 2, varianteId: 20, cantidad: 50 },
      { insumoId: 3, varianteId: 99, cantidad: 5 },
    ]
    const consumo = consumoDeItem(recetas, {
      varianteId: 10,
      varianteSecundariaId: 20,
      cantidad: 2,
    })
    expect(consumo.get(1)).toBe(4)
    expect(consumo.get(2)).toBe(100)
    expect(consumo.has(3)).toBe(false)
  })

  test('sin variantes elegidas sólo aplica la receta base', () => {
    const recetas: RecetaConsumo[] = [
      { insumoId: 1, varianteId: null, cantidad: 2 },
      { insumoId: 1, varianteId: 10, cantidad: 1 },
    ]
    const consumo = consumoDeItem(recetas, { varianteId: null, varianteSecundariaId: null, cantidad: 3 })
    expect(consumo.get(1)).toBe(6)
  })
})
