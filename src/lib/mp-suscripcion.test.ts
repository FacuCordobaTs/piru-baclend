import { expect, test } from 'bun:test'
import { externalReferenceSuscripcion } from './mp-suscripcion'

test('usa una external reference canónica para facturas compuestas', () => {
  expect(externalReferenceSuscripcion(42)).toBe('piru-suscripcion-42')
})
