import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'
import { internoAuthMiddleware } from './interno'

test('crear con sólo un teléfono exige la sesión firmada de interno, incluso con una sesión de restaurante', async () => {
  const previo = process.env.INTERNO_JWT_SECRET
  process.env.INTERNO_JWT_SECRET = 'interno-test-secret'
  let altas = 0
  const app = new Hono().use('*', internoAuthMiddleware).post('/locales/crear-telefono', c => {
    altas++
    return c.json({ success: true })
  })
  try {
    const request = (token?: string) => app.request('/locales/crear-telefono', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} })
    expect((await request()).status).toBe(401)
    expect((await request(jwt.sign({ id: 7, scope: 'restaurante' }, 'interno-test-secret'))).status).toBe(401)
    expect((await request(jwt.sign({ scope: 'interno' }, 'otro-secret'))).status).toBe(401)
    expect(altas).toBe(0)
    expect((await request(jwt.sign({ scope: 'interno' }, 'interno-test-secret'))).status).toBe(200)
    expect(altas).toBe(1)
  } finally {
    if (previo === undefined) delete process.env.INTERNO_JWT_SECRET
    else process.env.INTERNO_JWT_SECRET = previo
  }
})
