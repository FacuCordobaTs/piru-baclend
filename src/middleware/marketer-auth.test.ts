import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'
import { createAuthMiddleware } from './auth'
import { marketerAccion, restauranteMarketer } from '../db/schema'

function caso() {
  let vinculoActivo = true
  const consultas: unknown[] = []
  const acciones: any[] = []
  const db = {
    select: () => {
      let table: unknown
      const query: any = {
        from: (t: unknown) => {
          table = t
          consultas.push(t)
          return query
        },
        innerJoin: () => query,
        where: () => query,
        limit: async () =>
          table === restauranteMarketer
            ? vinculoActivo
              ? [{ id: 1 }]
              : []
            : [{ id: 6, nombre: 'Brasa', rapiboyToken: 'SECRETO' }],
      }
      return query
    },
    insert: (table: unknown) => ({
      values: async (value: any) => {
        expect(table).toBe(marketerAccion)
        acciones.push(value)
      },
    }),
  }
  const app = new Hono()
    .use(
      '/api/*',
      createAuthMiddleware(() => db as any),
    )
    .all('/api/*', (c) =>
      c.json({
        id: (c as any).user.id,
        marketerId: (c as any).user.marketerId,
      }),
    )
  const token = (payload: object) =>
    jwt.sign(payload, process.env.JWT_SECRET || 'fallback-secret')
  const pedir = (
    path: string,
    method = 'GET',
    payload = { id: 6, scope: 'restaurante', marketerId: 2 },
  ) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token(payload)}` },
    })
  return {
    pedir,
    consultas,
    acciones,
    revocar: () => {
      vinculoActivo = false
    },
  }
}
describe('auth del marketer en rutas existentes', () => {
  test('el mismo token pierde acceso en el request siguiente a revocarlo', async () => {
    const c = caso()
    expect((await c.pedir('/api/clientes/list')).status).toBe(200)
    c.revocar()
    const res = await c.pedir('/api/clientes/list')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'acceso_marketer_revocado' })
  })
  test('las rutas de secretos no llegan al handler ni leen el perfil', async () => {
    for (const path of [
      '/api/restaurante/profile',
      '/api/sucursales/list',
      '/api/mi-marketer',
    ]) {
      const c = caso()
      const res = await c.pedir(path)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ code: 'marketer_sin_permiso' })
      expect(c.consultas).toEqual([restauranteMarketer])
    }
  })
  test('la sesión global no funciona como identidad de local', async () => {
    const c = caso()
    expect(
      (
        await c.pedir('/api/clientes/list', 'GET', {
          scope: 'marketer',
          marketerId: 2,
        } as any)
      ).status,
    ).toBe(401)
    expect(c.consultas).toHaveLength(0)
  })
  test('audita mutaciones sin query string y conserva la identidad verificada', async () => {
    const c = caso()
    const res = await c.pedir(
      '/api/marketing/campanas?telefono=549111234',
      'POST',
    )
    expect(await res.json()).toEqual({ id: 6, marketerId: 2 })
    expect(c.acciones).toMatchObject([
      {
        restauranteId: 6,
        marketerId: 2,
        metodo: 'POST',
        ruta: '/api/marketing/campanas',
        status: 200,
      },
    ])
  })
  test('los dueños conservan el acceso a su perfil', async () => {
    const c = caso()
    expect(
      (await c.pedir('/api/restaurante/profile', 'GET', { id: 6 } as any))
        .status,
    ).toBe(200)
  })
})
