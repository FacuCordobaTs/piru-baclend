import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'
import { createInternoMarketersRoute } from './interno-marketers'
import { internoAuthMiddleware } from '../middleware/interno'
import { marketer, comisionMarketer } from '../db/schema'

function caso(afectadas = 1) {
  const escrituras: { table: unknown; values: any }[] = []
  const m = {
    id: 2,
    nombre: 'Tommy',
    email: 'tommy@example.com',
    telefono: null,
    codigo: 'TOMMY',
    comisionPorcentaje: '20.00',
    datosCobro: null,
    activo: true,
    passwordHash: 'secreto',
    activacionTokenHash: 'secreto',
    activacionExpiraAt: new Date(),
  }
  const db: any = {
    select: () => {
      const chain: any = {}
      for (const key of ['from', 'where', 'limit', 'orderBy', 'groupBy'])
        chain[key] = () => chain
      chain.then = (fn: any) => Promise.resolve([m]).then(fn)
      return chain
    },
    insert: (table: unknown) => ({
      values: async (values: any) => {
        escrituras.push({ table, values })
        return [{ insertId: 2 }]
      },
    }),
    update: (table: unknown) => ({
      set: (values: any) => ({
        where: async () => {
          escrituras.push({ table, values })
          return [{ affectedRows: afectadas }]
        },
      }),
    }),
  }
  const route = createInternoMarketersRoute(db)
  const pedir = (path: string, body: unknown) =>
    route.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  return { pedir, route, escrituras }
}
test('alta interno normaliza email/código, guarda sólo hash de activación y devuelve perfil seguro', async () => {
  const c = caso()
  const res = await c.pedir('/marketers', {
    nombre: 'Tommy',
    email: 'TOMMY@example.com',
    codigo: 'tommy',
    comisionPorcentaje: 20,
  })
  expect(res.status).toBe(201)
  const body = await res.json()
  expect(body.data.linkActivacion).toContain('/activar#token=')
  expect(body.data.marketer.passwordHash).toBeUndefined()
  expect(body.data.marketer.activacionTokenHash).toBeUndefined()
  const guardado = c.escrituras[0]
  expect(guardado.table).toBe(marketer)
  expect(guardado.values.email).toBe('tommy@example.com')
  expect(guardado.values.codigo).toBe('TOMMY')
  expect(guardado.values.activacionTokenHash).toHaveLength(64)
  expect(body.data.linkActivacion).not.toContain(
    guardado.values.activacionTokenHash,
  )
})
test('comisión sólo pasa de pendiente a pagada, exige referencia y admite fecha de transferencia', async () => {
  const c = caso()
  expect(
    (await c.pedir('/comisiones/2/pagar', { referencia: '' })).status,
  ).toBe(400)
  expect(c.escrituras).toHaveLength(0)
  expect(
    (
      await c.pedir('/comisiones/2/pagar', {
        referencia: 'Transferencia 123',
        pagadaAt: '2026-10-03T12:00:00-03:00',
      })
    ).status,
  ).toBe(200)
  expect(c.escrituras[0]).toMatchObject({
    table: comisionMarketer,
    values: { estado: 'pagada', referenciaPago: 'Transferencia 123' },
  })
  expect(c.escrituras[0].values.pagadaAt.toISOString()).toBe(
    '2026-10-03T15:00:00.000Z',
  )
  const yaPagada = caso(0)
  expect(
    (
      await yaPagada.pedir('/comisiones/2/pagar', {
        referencia: 'Otra transferencia',
      })
    ).status,
  ).toBe(409)
})
test('montada después del auth interno, ninguna cuenta de local o marketer entra', async () => {
  const secretAnterior = process.env.INTERNO_JWT_SECRET
  process.env.INTERNO_JWT_SECRET = 'secreto-interno-para-tests'
  try {
    const c = caso()
    const app = new Hono().use('*', internoAuthMiddleware).route('/', c.route)
    for (const scope of ['marketer', 'restaurante']) {
      const token = jwt.sign(
        { scope, id: 6, marketerId: 2 },
        'secreto-interno-para-tests',
      )
      expect(
        (
          await app.request('/marketers', {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(401)
    }
    expect((await app.request('/marketers')).status).toBe(401)
    expect(c.escrituras).toHaveLength(0)
  } finally {
    if (secretAnterior === undefined) delete process.env.INTERNO_JWT_SECRET
    else process.env.INTERNO_JWT_SECRET = secretAnterior
  }
})
