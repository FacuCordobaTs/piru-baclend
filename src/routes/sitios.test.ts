import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'
import { createAuthMiddleware } from '../middleware/auth'
import { createSitiosRoute } from './sitios'

const secreto = process.env.JWT_SECRET || 'fallback-secret'
const firmar = (payload: object, opciones?: jwt.SignOptions) => jwt.sign(payload, secreto, opciones)

/** Base mínima: el local 42 existe (auth y canje del pase sólo leen `restaurante`). */
const db: any = {
  select: () => {
    const q: any = { from: () => q, where: () => q, innerJoin: () => q, limit: async () => [{ id: 42, email: null, nombre: 'Bronx', origen: null, claimedAt: null, telefonoVerificado: true, rapiboyToken: null }] }
    return q
  },
  insert: () => ({ values: async () => {} }),
}

function app() {
  const auth = createAuthMiddleware(() => db)
  const a = new Hono()
    .route('/api/sitios', createSitiosRoute({ getDb: () => db, auth }))
    .use('/api/restaurante/*', auth)
    .get('/api/restaurante/profile', (c) => c.json({ ok: true }))
  return (path: string, method = 'GET', token?: string) =>
    a.request(path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

describe('entrada a Páginas desde el panel', () => {
  test('el panel recibe un pase de dos minutos sin id, que se canjea por una sesión de Páginas', async () => {
    const pedir = app()
    const res = await pedir('/api/sitios/entrada', 'POST', firmar({ id: 42 }))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.url).toStartWith('https://pages.piru.app/entrar#token=')
    const pase = decodeURIComponent(data.url.split('#token=')[1])
    const decodificado = jwt.verify(pase, secreto) as jwt.JwtPayload
    expect(decodificado).toMatchObject({ scope: 'entrada-sitios', restauranteId: 42 })
    expect(decodificado.id).toBeUndefined()
    expect(decodificado.exp! - decodificado.iat!).toBe(120)

    // El pase no sirve como token de local.
    expect((await pedir('/api/restaurante/profile', 'GET', pase)).status).toBe(401)

    const sesion = await pedir('/api/sitios/sesion', 'POST', pase)
    expect(sesion.status).toBe(200)
    const { token } = await sesion.json()
    expect(jwt.verify(token, secreto)).toMatchObject({ id: 42, scope: 'restaurante', appSitios: true })

    // La sesión de Páginas no alcanza el resto del panel ni emite pases nuevos.
    const perfil = await pedir('/api/restaurante/profile', 'GET', token)
    expect(perfil.status).toBe(403)
    expect((await perfil.json()).code).toBe('sitios_sin_permiso')
    expect((await pedir('/api/sitios/entrada', 'POST', token)).status).toBe(403)
  })

  test('un pase vencido, adulterado o de otra app no abre sesión', async () => {
    const pedir = app()
    for (const pase of [
      firmar({ scope: 'entrada-sitios', restauranteId: 42 }, { expiresIn: -10 }),
      jwt.sign({ scope: 'entrada-sitios', restauranteId: 42 }, 'otro-secreto'),
      firmar({ scope: 'entrada-app-marketing', restauranteId: 42 }),
      firmar({ id: 42 }),
    ])
      expect((await pedir('/api/sitios/sesion', 'POST', pase)).status).toBe(401)
  })

  test('la demo, el marketer y la app de marketing no pueden entrar a Páginas', async () => {
    const pedir = app()
    expect((await pedir('/api/sitios/entrada', 'POST', firmar({ id: 42, scope: 'restaurante', demo: true }))).status).toBe(403)
    expect((await pedir('/api/sitios', 'GET', firmar({ id: 42, scope: 'restaurante', demo: true }))).status).toBe(403)
    expect((await pedir('/api/sitios', 'GET', firmar({ id: 42, scope: 'restaurante', appMarketing: true }))).status).toBe(403)
    // Un token de Páginas con marcas mezcladas es inválido.
    expect((await pedir('/api/sitios', 'GET', firmar({ id: 42, scope: 'restaurante', appSitios: true, demo: true }))).status).toBe(401)
  })
})
