import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'

// Rutas reales con el contrato de marketers df3ff0e, sin tocar MySQL.
let cola: unknown[][] = []
let escrituras: unknown[] = []
function cadena(filas: unknown[]) {
  const q: any = new Proxy({}, {
    get: (_, prop) => prop === 'then'
      ? (ok: any, err: any) => Promise.resolve(filas).then(ok, err)
      : (...args: unknown[]) => {
          if (prop === 'values' || prop === 'set') escrituras.push(args[0])
          return q
        },
  })
  return q
}
const db = {
  select: () => {
    if (!cola.length) throw new Error('Consulta inesperada')
    return cadena(cola.shift()!)
  },
  insert: () => cadena([{ insertId: 42 }]),
  update: () => cadena([{ affectedRows: 1 }]),
}
const rutaDb = resolve(import.meta.dir, '../db')
const dbReal = await import(rutaDb)
const drizzleReal = await import('drizzle-orm/mysql2')
mock.module(rutaDb, () => ({ pool: {} }))
mock.module('drizzle-orm/mysql2', () => ({ drizzle: () => db }))
afterAll(() => {
  mock.module(rutaDb, () => dbReal)
  mock.module('drizzle-orm/mysql2', () => drizzleReal)
})
const { modulosRoute } = await import('./modulos')
const { codigoDescuentoRoute } = await import('./codigo-descuento')
const app = new Hono().route('/api/modulos', modulosRoute).route('/api/codigo-descuento', codigoDescuentoRoute)
const local = { id: 6, nombre: 'Local', origen: null, claimedAt: null, telefonoVerificado: true }
const modulo = {
  id: 3, codigo: 'codigos_descuento', categoriaId: 1, nombre: 'Cupones',
  tipo: 'incluido', precioMensual: '0.00', activable: true, activo: true,
  activoCatalogo: true, estado: 'activo', origen: 'usuario', vigenteHasta: null,
}
function pedir(ruta: string, method = 'GET', body?: unknown, marketer = false) {
  const token = jwt.sign({ id: 6, scope: 'restaurante', ...(marketer ? { marketerId: 8 } : { appMarketing: true }) }, process.env.JWT_SECRET || 'fallback-secret')
  return app.request(`/api${ruta}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
function auth(marketer: boolean) { return [...(marketer ? [[{ id: 1 }]] : []), [local]] }
beforeEach(() => { cola = []; escrituras = [] })

for (const marketer of [false, true]) describe(marketer ? 'sesión marketer' : 'sesión dueño', () => {
  test('activar gratis renueva una fila vencida y habilita crear el cupón', async () => {
    cola = [...auth(marketer), [modulo], [{ estado: 'activa' }],
      [{ estado: 'activa' }], [{ ...modulo, vigenteHasta: new Date('2020-01-01') }],
      [{ estado: 'activa' }], [modulo]]
    const activacion = await pedir('/modulos/codigos_descuento/activar', 'PUT', undefined, marketer)
    expect(activacion.status).toBe(200)
    expect(await activacion.json()).toMatchObject({ success: true, idempotent: false, data: { activoAhora: true } })
    expect(escrituras[0]).toMatchObject({ restauranteId: 6, estado: 'activo', vigenteHasta: null })
    expect(cola).toHaveLength(0)

    const body = { codigo: 'martes', tipo: 'porcentaje', valor: '10', limiteUsos: null,
      montoMinimo: '0', fechaInicio: '2026-10-24T00:00:00-03:00', fechaFin: null }
    cola = [...auth(marketer), [{ estado: 'activa' }], [modulo], [], [{ id: 42, ...body, codigo: 'MARTES' }]]
    const cupon = await pedir('/codigo-descuento/create', 'POST', body, marketer)
    expect(cupon.status).toBe(201)
    expect(await cupon.json()).toMatchObject({ success: true, data: { id: 42, codigo: 'MARTES' } })
    expect(escrituras).toContainEqual(expect.objectContaining({ restauranteId: 6, codigo: 'MARTES', generadoAutomaticamente: false }))
    expect(cola).toHaveLength(0)
  })

  test('crea envío gratis sin importe y lo normaliza a cero', async () => {
    const body = { codigo: 'envio', tipo: 'envio_gratis', montoMinimo: '10000', limiteUsos: 20 }
    cola = [...auth(marketer), [{ estado: 'activa' }], [modulo], [], [{ id: 42, ...body }]]
    const res = await pedir('/codigo-descuento/create', 'POST', body, marketer)
    expect(res.status).toBe(201)
    expect(escrituras).toContainEqual(expect.objectContaining({
      restauranteId: 6, codigo: 'ENVIO', tipo: 'envio_gratis', valor: '0.00', montoMinimo: '10000', limiteUsos: 20,
    }))
    expect(cola).toHaveLength(0)
  })

  test('cambiar un cupón a envío gratis descarta el importe anterior', async () => {
    const anterior = { id: 42, restauranteId: 6, codigo: 'ENVIO', tipo: 'monto_fijo', valor: '1500' }
    cola = [...auth(marketer), [{ estado: 'activa' }], [modulo], [anterior], [{ ...anterior, tipo: 'envio_gratis', valor: '0.00' }]]
    const res = await pedir('/codigo-descuento/42', 'PUT', { tipo: 'envio_gratis', valor: '9999' }, marketer)
    expect(res.status).toBe(200)
    expect(escrituras).toContainEqual({ tipo: 'envio_gratis', valor: '0.00' })
    expect(cola).toHaveLength(0)
  })

  test('al pasar de envío gratis a monto fijo exige un importe positivo', async () => {
    cola = [...auth(marketer), [{ estado: 'activa' }], [modulo], [{ id: 42, restauranteId: 6, codigo: 'ENVIO', tipo: 'envio_gratis', valor: '0.00' }]]
    const res = await pedir('/codigo-descuento/42', 'PUT', { tipo: 'monto_fijo' }, marketer)
    expect(res.status).toBe(400)
    expect(escrituras.filter((fila: any) => fila.marketerId === undefined)).toHaveLength(0)
    expect(cola).toHaveLength(0)
  })

  test('no anuncia éxito ni escribe si la suscripción impide usar el módulo', async () => {
    cola = [...auth(marketer), [modulo], [{ estado: 'suspendida' }]]
    const res = await pedir('/modulos/codigos_descuento/activar', 'PUT', undefined, marketer)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ success: false, code: 'suscripcion_sin_acceso' })
    expect(escrituras.filter((fila: any) => fila.marketerId === undefined)).toHaveLength(0)
  })

  test('crear cupón sin herramienta activa conserva el gate y devuelve JSON', async () => {
    cola = [...auth(marketer), [{ estado: 'activa' }], [{ ...modulo, estado: 'inactivo' }]]
    const res = await pedir('/codigo-descuento/create', 'POST', { codigo: 'MARTES', tipo: 'porcentaje', valor: '10' }, marketer)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ success: false, moduleRequired: true, module: 'codigos_descuento' })
    expect(escrituras.filter((fila: any) => fila.marketerId === undefined)).toHaveLength(0)
  })
})


test('mis-modulos y el gate usan el mismo estado después de activar', async () => {
  cola = [[local], [{ id: 1, nombre: 'Ventas', activo: true }], [{ estado: 'activa' }], [modulo]]
  const res = await pedir('/modulos/mis-modulos')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ success: true, data: [{ modulos: [{ codigo: 'codigos_descuento', activoAhora: true }] }] })
  expect(cola).toHaveLength(0)
})

test('activar un módulo ya operativo es idempotente', async () => {
  cola = [[local], [modulo], [{ estado: 'trial' }], [{ estado: 'trial' }], [modulo]]
  const res = await pedir('/modulos/codigos_descuento/activar', 'PUT')
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ success: true, idempotent: true, data: { activoAhora: true } })
  expect(escrituras).toHaveLength(0)
})

test('una herramienta paga nunca se activa por el endpoint gratuito', async () => {
  cola = [[local], [{ ...modulo, tipo: 'pago' }]]
  const res = await pedir('/modulos/codigos_descuento/activar', 'PUT')
  expect(res.status).toBe(409)
  expect(await res.json()).toMatchObject({ success: false, paymentRequired: true })
  expect(escrituras).toHaveLength(0)
})
