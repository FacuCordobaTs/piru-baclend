import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import * as jwt from 'jsonwebtoken'

// Rutas reales y resolución real del módulo. La columna histórica se conserva
// en los datos para reproducir locales existentes sin hacer ningún backfill.
let flagHistorico = false
let moduloActivo = true
let cuponActivo = true
let codigo = 'ENVIO'
let lecturasFlagHistorico = 0
const db = {
  select(campos?: Record<string, any>) {
    if (campos?.codigoDescuentoEnabled) lecturasFlagHistorico++
    let tabla = ''
    const q: any = new Proxy({}, {
      get: (_, metodo) => metodo === 'then' ? (ok: any, err: any) => {
        const filas = tabla === 'restaurante' ? [{
          id: 7, username: 'prueba', nombre: 'Prueba', codigoDescuentoEnabled: flagHistorico,
          usarFranjasHorario: false, deliveryEnabled: true, takeawayEnabled: true,
        }] : tabla === 'modulo' ? [{
          id: 3, codigo: 'codigos_descuento', nombre: 'Cupones', tipo: 'incluido',
          precioMensual: '0.00', activoCatalogo: true, estado: moduloActivo ? 'activo' : 'inactivo',
          origen: 'usuario', vigenteHasta: null, precioMensualCongelado: null,
        }] : tabla === 'suscripcion' ? [{
          estado: 'activa', fechaProximoCobro: new Date('2999-01-01'), graciaHasta: null, fechaCancelacion: null,
        }] : tabla === 'codigo_descuento' ? [{
          id: 42, restauranteId: 7, codigo, tipo: 'envio_gratis', valor: '0.00',
          montoMinimo: '3000', activo: cuponActivo, fechaInicio: null, fechaFin: null,
          limiteUsos: 20, usosActuales: 0,
        }] : []
        return Promise.resolve(campos ? filas.map(fila => Object.fromEntries(
          Object.entries(campos).map(([nombre, columna]) => [nombre, (fila as any)[nombre] ?? (fila as any)[columna.name] ?? null]),
        )) : filas).then(ok, err)
      } : (...args: any[]) => {
        if (metodo === 'from') tabla = getTableName(args[0])
        return q
      },
    })
    return q
  },
}
const rutaDb = resolve(import.meta.dir, '../db')
const dbReal = await import(rutaDb)
const drizzleReal = await import('drizzle-orm/mysql2')
// El singleton de sockets conserva su DB real; estos tests sólo ejercitan HTTP.
await import('../websocket/manager')
mock.module(rutaDb, () => ({ pool: {} }))
mock.module('drizzle-orm/mysql2', () => ({ drizzle: () => db }))
afterAll(() => {
  mock.module(rutaDb, () => dbReal)
  mock.module('drizzle-orm/mysql2', () => drizzleReal)
})
const { publicRoute } = await import('./public')
const { restauranteRoute } = await import('./restaruante')
const app = new Hono().route('/api/public', publicRoute).route('/api/restaurante', restauranteRoute)
beforeEach(() => {
  flagHistorico = false
  moduloActivo = true
  cuponActivo = true
  codigo = 'ENVIO'
  lecturasFlagHistorico = 0
})

function validar() {
  return app.request('/api/public/descuentos/validar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restauranteId: 7, codigo, tipoPedido: 'delivery', costoEnvio: 1200, totalCarrito: 4700 }),
  })
}

for (const ruta of ['/restaurante/prueba', '/restaurante/id/7']) {
  test(`${ruta}: módulo activo y columna histórica apagada muestran el campo de cupón`, async () => {
    const res = await app.request(`/api/public${ruta}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { restaurante: { codigoDescuentoEnabled: true } } })
    expect(lecturasFlagHistorico).toBe(0)
  })
}

test('validar permite el cupón con módulo activo aunque la columna histórica esté apagada', async () => {
  const res = await validar()
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ success: true, data: { tipo: 'envio_gratis', montoDescuento: '1200.00', totalConDescuento: '3500.00' } })
  expect(lecturasFlagHistorico).toBe(0)
})

test('la columna histórica encendida no habilita ni muestra cupones con el módulo inactivo', async () => {
  flagHistorico = true
  moduloActivo = false
  const res = await app.request('/api/public/restaurante/prueba')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ data: { restaurante: { codigoDescuentoEnabled: false } } })
  expect(await (await validar()).json()).toMatchObject({ success: false, message: 'Este local no tiene habilitados los códigos de descuento' })
})

test('el módulo activo no permite usar un cupón pausado', async () => {
  cuponActivo = false
  expect(await (await validar()).json()).toMatchObject({ success: false, message: 'Este código ya no está activo' })
})

test('los cupones del motor conservan su propio acceso sin activar Cupones manuales', async () => {
  moduloActivo = false
  codigo = 'VOLVE-PRUEBA'
  expect(await (await validar()).json()).toMatchObject({ success: true, data: { montoDescuento: '1200.00' } })
})


test('el perfil del panel también informa la activación del módulo y no la columna histórica', async () => {
  const token = jwt.sign({ id: 7, scope: 'restaurante' }, process.env.JWT_SECRET || 'fallback-secret')
  const res = await app.request('/api/restaurante/profile', { headers: { Authorization: `Bearer ${token}` } })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ data: { restaurante: { codigoDescuentoEnabled: true } } })
})
