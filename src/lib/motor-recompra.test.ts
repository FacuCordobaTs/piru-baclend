import { describe, expect, test } from 'bun:test'
import { calcularPrioridadStock } from './motor-recompra-prioridad'

describe('prioridad del stock del Motor de Recompra', () => {
  test('el segmento domina al ticket histórico', () => {
    expect(calcularPrioridadStock('en_riesgo', 1)).toBeGreaterThan(calcularPrioridadStock('dormido', 9_999_999))
    expect(calcularPrioridadStock('dormido', 1)).toBeGreaterThan(calcularPrioridadStock('perdido', 9_999_999))
  })

  test('dentro del segmento prioriza el ticket más alto y lo capa', () => {
    expect(calcularPrioridadStock('en_riesgo', 20_000)).toBeGreaterThan(calcularPrioridadStock('en_riesgo', 10_000))
    expect(calcularPrioridadStock('en_riesgo', 99_999_999)).toBe(calcularPrioridadStock('en_riesgo', 9_999_999))
  })
})

describe('segmento primer_pedido en el Motor de Recompra', () => {
  test('tiene la máxima prioridad sobre en_riesgo, dormido y perdido', () => {
    expect(calcularPrioridadStock('primer_pedido', 1)).toBeGreaterThan(calcularPrioridadStock('en_riesgo', 9_999_999))
    expect(calcularPrioridadStock('primer_pedido', 1)).toBeGreaterThan(calcularPrioridadStock('dormido', 9_999_999))
    expect(calcularPrioridadStock('primer_pedido', 1)).toBeGreaterThan(calcularPrioridadStock('perdido', 9_999_999))
  })
})

