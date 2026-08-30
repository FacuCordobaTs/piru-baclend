import { describe, expect, test } from 'bun:test'
import { esGtmContainerIdValido, normalizarGtmContainerId } from './gtm'

describe('configuración GTM', () => {
  test('normaliza el contenedor antes de guardarlo', () => {
    expect(normalizarGtmContainerId('  gtm-a1b2c3  ')).toBe('GTM-A1B2C3')
    expect(normalizarGtmContainerId('   ')).toBeNull()
  })

  test('acepta sólo IDs de contenedor GTM o configuración vacía', () => {
    expect(esGtmContainerIdValido('GTM-A1B2C3')).toBe(true)
    expect(esGtmContainerIdValido(null)).toBe(true)
    expect(esGtmContainerIdValido('G-ABC123')).toBe(false)
    expect(esGtmContainerIdValido('GTM-abc-123')).toBe(false)
  })
})
