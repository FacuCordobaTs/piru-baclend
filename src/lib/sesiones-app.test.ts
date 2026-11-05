import { describe, expect, test } from 'bun:test'
import { esTokenRetirado, puedeSocketAdmin } from './sesiones-app'

describe('tokens del canal de marketers retirado', () => {
  test('se reconocen los tres', () => {
    expect(esTokenRetirado({ scope: 'marketer' })).toBe(true)
    expect(esTokenRetirado({ scope: 'restaurante', marketerId: 3 })).toBe(true)
    expect(esTokenRetirado({ scope: 'restaurante', appMarketing: true })).toBe(true)
    expect(esTokenRetirado({ scope: 'restaurante' })).toBe(false)
  })

  test('el feed de pedidos sólo lo abre la sesión del panel', () => {
    expect(puedeSocketAdmin({ id: 4, scope: 'restaurante' })).toBe(true)
    expect(puedeSocketAdmin({ id: 4 })).toBe(true)
    expect(puedeSocketAdmin({ id: 4, scope: 'restaurante', marketerId: 2 })).toBe(false)
    expect(puedeSocketAdmin({ id: 4, scope: 'restaurante', appMarketing: true })).toBe(false)
    expect(puedeSocketAdmin({ id: 4, scope: 'restaurante', appSitios: true })).toBe(false)
    expect(puedeSocketAdmin({ marketerId: 2, scope: 'marketer' })).toBe(false)
    expect(puedeSocketAdmin({ id: 0 })).toBe(false)
  })
})
