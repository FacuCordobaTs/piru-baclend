import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { getTableName } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import * as jwt from 'jsonwebtoken'

const config = { plantilla: 'moderna', productoDestacadoId: 42, frase: 'Nuestra cocina', portadaUrl: 'https://fotos.test/local.jpg' }
let local: Record<string, any>
const escrituras: Array<{ data: Record<string, any>; params: unknown[] }> = []
const dialect = new MySqlDialect()
const dbFalsa = {
  select(campos?: Record<string, any>) {
    let tabla = '', filtro: any
    const q: any = new Proxy({}, { get: (_, metodo) => {
      if (metodo === 'then') return (ok: any, err: any) => {
        const sql = filtro ? dialect.sqlToQuery(filtro) : null
        const duplicado = tabla === 'restaurante' && sql?.sql.includes('<>')
        const filas = duplicado ? [] : tabla === 'restaurante' ? [local]
          : tabla === 'sala' ? [{ id: 1, restauranteId: 7, token: 'sala-prueba' }]
          : tabla === 'pedido' ? [{ id: 1, estado: 'pending' }] : []
        return Promise.resolve(campos ? filas.map(f => Object.fromEntries(Object.entries(campos).map(([k, col]) => [k, (f as any)[col.name] ?? (f as any)[k] ?? null]))) : filas).then(ok, err)
      }
      return (...args: any[]) => { if (metodo === 'from') tabla = getTableName(args[0]); if (metodo === 'where') filtro = args[0]; return q }
    } })
    return q
  },
  update() { return { set(data: Record<string, any>) { return { async where(filtro: any) {
    escrituras.push({ data, params: dialect.sqlToQuery(filtro).params }); local = { ...local, ...data }
  } } } } },
}
const rutaDb = resolve(import.meta.dir, '../db')
const dbReal = await import(rutaDb)
const drizzleReal = await import('drizzle-orm/mysql2')
mock.module(rutaDb, () => ({ pool: {} }))
mock.module('drizzle-orm/mysql2', () => ({ drizzle: () => dbFalsa }))
afterAll(() => { mock.module(rutaDb, () => dbReal); mock.module('drizzle-orm/mysql2', () => drizzleReal) })
const { Hono } = await import('hono')
const { restauranteRoute } = await import('./restaruante')
const { onboardingRoute } = await import('./onboarding')
const { publicRoute } = await import('./public')
const { mesaRoute } = await import('./mesa')
const app = new Hono().route('/api/restaurante', restauranteRoute).route('/api/onboarding', onboardingRoute).route('/api/public', publicRoute).route('/api/mesa', mesaRoute)
const token = (interno = false) => jwt.sign({ id: 7, scope: 'restaurante', ...(interno ? { accesoTemporalInterno: true } : {}) }, process.env.JWT_SECRET || 'fallback-secret')
const request = (path: string, body?: object, interno = false) => app.request(path, {
  method: body ? 'PUT' : 'GET', headers: { Authorization: `Bearer ${token(interno)}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
})
beforeEach(() => { local = { id: 7, nombre: 'Local', username: 'local', requiereSuscripcion: false, tienda: config }; escrituras.length = 0 })

test('el dueño edita tienda de su identidad, no el restaurante enviado en el body', async () => {
  const r = await request('/api/restaurante/update', { restauranteId: 999, tienda: { plantilla: 'elegante', historia: { texto: 'Hola' }, desconocida: true } })
  expect(r.status).toBe(200)
  expect((await r.json()).data.tienda).toEqual({ plantilla: 'elegante', historia: { texto: 'Hola' } })
  expect(escrituras[0].params).toEqual([7])
})
test('omitir tienda conserva la configuración y null la elimina', async () => {
  expect((await request('/api/restaurante/update', { nombre: 'Nuevo nombre' })).status).toBe(200)
  expect(local.tienda).toEqual(config)
  expect((await request('/api/restaurante/update', { tienda: null })).status).toBe(200)
  expect(local.tienda).toBeNull()
})
test('onboarding acepta personalización de un local nuevo y omitirla conserva los defaults', async () => {
  local.tienda = null
  const base = { username: 'local', notifyWhatsapp: false, notifyPrinter: false, finalizar: false }
  const r = await request('/api/onboarding/complete', { ...base, tienda: JSON.stringify(config) }, true)
  expect(r.status).toBe(200); expect(local.tienda).toEqual(config); expect(escrituras[0].params).toEqual([7])
  expect((await request('/api/onboarding/complete', base, true)).status).toBe(200)
  expect(local.tienda).toEqual(config)
})
test('construir por onboarding exige interno y actualizar exige autenticación', async () => {
  expect((await request('/api/onboarding/complete', { username: 'local', notifyWhatsapp: false, notifyPrinter: false, tienda: {} })).status).toBe(403)
  expect((await app.request('/api/restaurante/update', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tienda: {} }) })).status).toBe(401)
  expect(escrituras).toHaveLength(0)
})
test('una imagen rechazada devuelve 400 sin mutar la configuración', async () => {
  const r = await request('/api/restaurante/update', { tienda: { portadaUrl: 'data:image/svg+xml;base64,AAAA' } })
  expect(r.status).toBe(400); expect(escrituras).toHaveLength(0); expect(local.tienda).toEqual(config)
})
for (const path of ['/api/restaurante/profile', '/api/public/restaurante/local', '/api/mesa/join/sala-prueba']) {
  test(`${path}: devuelve el mismo contrato, con y sin personalización`, async () => {
    for (const tienda of [config, null]) {
      local.tienda = tienda
      const r = await request(path)
      expect(r.status).toBe(200)
      expect((await r.json()).data.restaurante.tienda).toEqual(tienda)
    }
  })
}
