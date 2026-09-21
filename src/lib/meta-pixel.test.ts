import { describe, expect, test } from 'bun:test'
import { esMetaPixelIdValido, normalizarMetaPixelId } from './meta-pixel'

describe('configuración del pixel de Meta', () => {
  test('normaliza el ID antes de guardarlo', () => {
    expect(normalizarMetaPixelId('  2426435001137598  ')).toBe('2426435001137598')
    expect(normalizarMetaPixelId('   ')).toBeNull()
  })

  test('acepta sólo IDs numéricos de 15 o 16 dígitos, o configuración vacía', () => {
    expect(esMetaPixelIdValido('2426435001137598')).toBe(true)
    expect(esMetaPixelIdValido('123456789012345')).toBe(true)
    expect(esMetaPixelIdValido(null)).toBe(true)
    expect(esMetaPixelIdValido(undefined)).toBe(true)
    expect(esMetaPixelIdValido('')).toBe(true)
    expect(esMetaPixelIdValido('fbq-2426435001137598')).toBe(false)
    expect(esMetaPixelIdValido('12345678901234')).toBe(false)
    expect(esMetaPixelIdValido('12345678901234567')).toBe(false)
    expect(esMetaPixelIdValido('242643500113759.8')).toBe(false)
  })
})
