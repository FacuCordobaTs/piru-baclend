import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'

let cola: unknown[][] = []
let cambios: Record<string, unknown>[] = []
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
process.env.INTERNO_JWT_SECRET ||= 'interno-renovacion-test'
afterAll(() => {
  mock.module(rutaDb, () => dbReal)
  mock.module('drizzle-orm/mysql2', () => drizzleReal)
  if (secretoOriginal === undefined) delete process.env.INTERNO_JWT_SECRET
  else process.env.INTERNO_JWT_SECRET = secretoOriginal
})
beforeEach(() => { cola = []; cambios = [] })

function renovar(token = jwt.sign({ scope: 'interno' }, process.env.INTERNO_JWT_SECRET!)) {
  return app.request('/api/interno/locales/1/suscripcion', {
    method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciclo: 'mensual' }),
  })
}

test('Renovar el local 1 extiende la suscripción y devuelve la fecha confirmada con los módulos facturables', async () => {
  const vencimiento = new Date(Date.now() + 10 * 86400000)
  cola = [
    [{ id: 1 }],
    [{ id: 1, codigo: 'piru', nombre: 'Piru', precioMensual: '100.00', activo: true, descuentoAnual: 0 }],
    [{ id: 1 }],
    [{ estado: 'activa', ciclo: 'mensual', fechaInicio: new Date('2026-01-01'), fechaProximoCobro: vencimiento }],
    [{ precioMensual: '100.00' }],
    [{ estado: 'activa' }],
    [{ codigo: 'motor_recompra', tipo: 'pago', estado: 'activo', precioMensual: '20.00', precioMensualCongelado: '15.00', activoCatalogo: true, vigenteHasta: null }],
  ]
  const res = await renovar()
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.success).toBe(true)
  expect(new Date(body.data.fechaProximoCobro).getTime()).toBeGreaterThan(vencimiento.getTime())
  expect(cambios[0]).toMatchObject({ estado: 'activa', trialFin: null, graciaHasta: null, fechaCancelacion: null })
  expect(cambios[1]).toMatchObject({ montoModulosMensual: '15.00', montoTotalMensual: '115.00' })
  expect(cola).toHaveLength(0)
})

test('Renovar devuelve un error explícito si falta la configuración, sin cambiar la suscripción', async () => {
  cola = [[{ id: 1 }], [], [{ id: 1 }], []]
  const res = await renovar()
  expect(res.status).toBe(409)
  expect(await res.json()).toMatchObject({ success: false, message: 'Falta configurar la suscripción Piru' })
  expect(cambios).toHaveLength(0)
})

test('un token de restaurante no puede renovar desde interno', async () => {
  const res = await renovar(jwt.sign({ id: 1, scope: 'restaurante' }, process.env.INTERNO_JWT_SECRET!))
  expect(res.status).toBe(401)
  expect(cambios).toHaveLength(0)
})
