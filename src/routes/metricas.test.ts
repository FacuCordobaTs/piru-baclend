import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import * as jwt from 'jsonwebtoken'

// GET /metricas sin base: cada `select()` entrega la siguiente respuesta de la
// cola, en el orden en que el handler las pide (la primera es la del login).
let cola: unknown[][] = []

function cadena(filas: unknown[]) {
  const q: any = new Proxy(function () {}, {
    get: (_t, prop) =>
      prop === 'then'
        ? (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(filas).then(ok, err)
        : () => q,
    apply: () => q,
  })
  return q
}
const dbFalsa = { select: () => cadena(cola.shift() ?? []) }

// Los mocks de módulo valen para todo el proceso de `bun test`: se devuelven al terminar.
const RUTA_DB = resolve(import.meta.dir, '../db')
const dbReal = await import(RUTA_DB)
const drizzleReal = await import('drizzle-orm/mysql2')
mock.module(RUTA_DB, () => ({ pool: {} }))
mock.module('drizzle-orm/mysql2', () => ({ drizzle: () => dbFalsa }))
afterAll(() => {
  mock.module(RUTA_DB, () => dbReal)
  mock.module('drizzle-orm/mysql2', () => drizzleReal)
})

const { Hono } = await import('hono')
const { metricasRoute } = await import('./metricas')
const app = new Hono().route('/api/metricas', metricasRoute)

const token = jwt.sign({ id: 6, scope: 'restaurante' }, process.env.JWT_SECRET || 'fallback-secret')
const pedir = (query = '') =>
  app.request(`/api/metricas${query}`, { headers: { Authorization: `Bearer ${token}` } })

beforeEach(() => {
  cola = []
})

function cargarRespuestas(extra: unknown[][] = []) {
  cola = [
    [{ id: 6, email: null, nombre: 'Brasa', origen: null, claimedAt: null, telefonoVerificado: false, rapiboyToken: null }],
    // ingresos y pedidos
    [{ totalMensual: '20250.00', totalHistorico: '40000.00', totalMensualManual: '6750.00', totalMensualWeb: '13500.00' }],
    [{ pedidosMensuales: '4', pedidosMensualesPagados: '3', pedidosMensualesManual: '1', pedidosMensualesWeb: '3', pedidosHistoricos: '9' }],
    // medios de pago y top 5
    [{ metodoPago: 'efectivo', total: '13500.00' }, { metodoPago: null, total: '6750.00' }],
    [{ productoId: 5, nombre: 'Hamburguesa', cantidad: '3', totalVendido: '20250.00' }],
    ...extra,
  ]
}

describe('GET /metricas', () => {
  test('conserva los totales de siempre y suma las series del período', async () => {
    cargarRespuestas([
      // por hora
      [{ hora: 20, pedidos: 2, total: '13500.00' }, { hora: '21', pedidos: '1', total: '6750.00' }],
      // por día
      [{ fecha: '2026-10-08', pedidos: 1, total: '6750.00' }, { fecha: '2026-10-10', pedidos: '2', total: '13500.00' }],
      // por categoría
      [
        { categoriaId: 3, nombre: 'Hamburguesas', cantidad: '3', totalVendido: '20250.00' },
        { categoriaId: null, nombre: null, cantidad: '1', totalVendido: '1500.00' },
      ],
      // productos vendidos
      [
        { productoId: 5, nombre: 'Hamburguesa', categoria: 'Hamburguesas', cantidad: '3', totalVendido: '20250.00' },
        { productoId: 9, nombre: null, categoria: null, cantidad: '1', totalVendido: '1500.00' },
      ],
    ])
    const res = await pedir('?from=2026-10-01&to=2026-10-12')
    expect(res.status).toBe(200)
    const { data } = await res.json()

    expect(data.ingresos).toEqual({ mensual: 20250, historico: 40000, mensualManual: 6750, mensualWeb: 13500 })
    expect(data.pedidos).toMatchObject({ mensuales: 4, mensualesPagados: 3, historicos: 9 })
    expect(data.desgloseMetodoPago).toEqual([
      { metodoPago: 'efectivo', total: 13500 },
      { metodoPago: 'desconocido', total: 6750 },
    ])
    expect(data.topProductos).toHaveLength(1)

    expect(data.porHora).toEqual([
      { hora: 20, pedidos: 2, total: 13500 },
      { hora: 21, pedidos: 1, total: 6750 },
    ])
    expect(data.porDia).toEqual([
      { fecha: '2026-10-08', pedidos: 1, total: 6750 },
      { fecha: '2026-10-10', pedidos: 2, total: 13500 },
    ])
    expect(data.porCategoria).toEqual([
      { categoriaId: 3, nombre: 'Hamburguesas', cantidad: 3, totalVendido: 20250 },
      { categoriaId: null, nombre: 'Sin categoría', cantidad: 1, totalVendido: 1500 },
    ])
    expect(data.productosVendidos).toEqual([
      { productoId: 5, nombre: 'Hamburguesa', categoria: 'Hamburguesas', cantidad: 3, totalVendido: 20250 },
      { productoId: 9, nombre: 'Producto eliminado', categoria: null, cantidad: 1, totalVendido: 1500 },
    ])
    // Las ocho consultas, ni una más.
    expect(cola).toHaveLength(0)
  })

  test('sin pedidos devuelve las series vacías en lugar de fallar', async () => {
    cargarRespuestas([[], [], [], []])
    const res = await pedir('?from=2026-10-01&to=2026-10-12')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.porHora).toEqual([])
    expect(data.porDia).toEqual([])
    expect(data.porCategoria).toEqual([])
    expect(data.productosVendidos).toEqual([])
  })
})
