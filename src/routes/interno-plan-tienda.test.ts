import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'

let cola: unknown[][] = []
let cambios: Record<string, unknown>[] = []
let errorSelect: unknown = null
function consulta(filas: unknown[]) {
  const q: any = new Proxy({}, {
    get: (_, prop) => prop === 'then'
      ? (ok: any, err: any) => Promise.resolve(filas).then(ok, err)
      : () => q,
  })
  return q
}
const db = {
  select: () => {
    if (errorSelect) throw errorSelect
    if (!cola.length) throw new Error('Consulta inesperada')
    return consulta(cola.shift()!)
  },
  update: () => ({ set: (values: Record<string, unknown>) => {
    cambios.push(values)
    return consulta([{ affectedRows: 1 }])
  } }),
}
const rutaDb = resolve(import.meta.dir, '../db')
const dbReal = await import(rutaDb)
const drizzleReal = await import('drizzle-orm/mysql2')
mock.module(rutaDb, () => ({ pool: {} }))
mock.module('drizzle-orm/mysql2', () => ({ drizzle: () => db }))
const { internoRoute } = await import('./interno')
const app = new Hono().route('/api/interno', internoRoute)
const secretoOriginal = process.env.INTERNO_JWT_SECRET
process.env.INTERNO_JWT_SECRET ||= 'interno-plan-tienda-test'
afterAll(() => {
  mock.module(rutaDb, () => dbReal)
  mock.module('drizzle-orm/mysql2', () => drizzleReal)
  if (secretoOriginal === undefined) delete process.env.INTERNO_JWT_SECRET
  else process.env.INTERNO_JWT_SECRET = secretoOriginal
})
beforeEach(() => { cola = []; cambios = []; errorSelect = null })

function cambiarPlan(codigo: unknown, token = jwt.sign({ scope: 'interno' }, process.env.INTERNO_JWT_SECRET!)) {
  return app.request('/api/interno/locales/1/plan-tienda', {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo }),
  })
}

test('pasar un local self-serve a Evolución le vuelve a poner el paywall de siempre y nada más', async () => {
  cola = [[{ id: 1, planTienda: 'inicial', requiereSuscripcion: false }]]
  const res = await cambiarPlan('evolucion')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ success: true, data: { planTienda: 'evolucion', requiereSuscripcion: true } })
  // Una sola escritura, sobre restaurante: ni suscripción ni módulos.
  expect(cambios).toEqual([{ planTienda: 'evolucion', requiereSuscripcion: true }])
})

test('pasar a un plan nuevo saca el paywall viejo', async () => {
  cola = [[{ id: 1, planTienda: 'evolucion', requiereSuscripcion: true }]]
  const res = await cambiarPlan('impulso')
  expect(res.status).toBe(200)
  expect(cambios).toEqual([{ planTienda: 'impulso', requiereSuscripcion: false }])
})

test('elegir el plan que ya tiene no escribe nada (un Evolución viejo conserva su paywall)', async () => {
  cola = [[{ id: 1, planTienda: 'evolucion', requiereSuscripcion: false }]]
  const res = await cambiarPlan('evolucion')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ data: { planTienda: 'evolucion', requiereSuscripcion: false } })
  expect(cambios).toHaveLength(0)
})

test('un código que no es un plan se rechaza sin tocar el local', async () => {
  const res = await cambiarPlan('premium')
  expect(res.status).toBe(400)
  expect(cambios).toHaveLength(0)
})

test('local inexistente: 404', async () => {
  cola = [[]]
  const res = await cambiarPlan('esencial')
  expect(res.status).toBe(404)
  expect(cambios).toHaveLength(0)
})

test('sin la migración aplicada responde 409 con el motivo', async () => {
  errorSelect = Object.assign(new Error('Unknown column'), { code: 'ER_BAD_FIELD_ERROR' })
  const res = await cambiarPlan('evolucion')
  expect(res.status).toBe(409)
  expect(cambios).toHaveLength(0)
})

test('un token de restaurante no puede cambiar el plan', async () => {
  const res = await cambiarPlan('evolucion', jwt.sign({ id: 1, scope: 'restaurante' }, process.env.INTERNO_JWT_SECRET!))
  expect(res.status).toBe(401)
  expect(cambios).toHaveLength(0)
})
