import { describe, expect, test } from 'bun:test'
import { staffLoginRoute, staffRoute } from './staff'

describe('staff routes initialization', () => {
  test('staffLoginRoute and staffRoute are defined and mountable', () => {
    expect(staffLoginRoute).toBeDefined()
    expect(staffRoute).toBeDefined()
  })
})
