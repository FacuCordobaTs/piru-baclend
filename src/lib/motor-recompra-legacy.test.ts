import { describe, expect, test } from 'bun:test'
import { puedeCrearGoteoLegacy } from './compatibilidad-recompra'

describe('T32 · compatibilidad del scheduler legacy', () => {
  test('un entitlement de Crecimiento nuevo no puede crear una cola de goteo', () => {
    expect(puedeCrearGoteoLegacy(false)).toBe(false)
  })

  test('una cuenta migrada que conserva el entitlement Motor mantiene su scheduler', () => {
    expect(puedeCrearGoteoLegacy(true)).toBe(true)
  })
})
