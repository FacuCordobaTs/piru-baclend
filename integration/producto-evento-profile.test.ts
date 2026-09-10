import { expect, mock, test } from 'bun:test'
import { producto, restaurante } from '../src/db/schema'

// Ejecutar por separado: simula la DB y autenticación, pero recorre el handler
// real de /profile (incluido su SELECT y la serialización que recibe el admin).
const productos = [
  { id: 1, restaurante_id: 7, nombre: 'Habitual', precio: '1500.00', activo: true, evento_sucursal_id: null },
  { id: 2, restaurante_id: 7, nombre: 'Exclusivo', precio: '3500.00', activo: true, evento_sucursal_id: 20 },
]
const db = {
  select(fields?: Record<string, any>) {
    let table: unknown
    const query = {
      from(value: unknown) { table = value; return query },
      where() { return query },
      leftJoin() { return query },
      innerJoin() { return query },
      then(resolve: (rows: any[]) => unknown, reject?: (error: unknown) => unknown) {
        const rows = table === producto ? productos : table === restaurante ? [{ id: 7, nombre: 'Local', requiereSuscripcion: false }] : []
        return Promise.resolve(rows.map(row => fields
          ? Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, (row as any)[column.name] ?? null]))
          : row)).then(resolve, reject)
      },
    }
    return query
  },
}

mock.module('../src/db', () => ({ pool: {} }))
const mysql = await import('drizzle-orm/mysql2')
mock.module('drizzle-orm/mysql2', () => ({ ...mysql, drizzle: () => db }))
mock.module('../src/middleware/auth', () => ({ authMiddleware: async (c: any, next: () => Promise<void>) => {
  c.user = { id: 7 }; await next()
} }))
const suscripciones = await import('../src/lib/suscripciones')
mock.module('../src/lib/suscripciones', () => ({ ...suscripciones, resolverEstadoVigente: async () => null }))
const suscripcion = await import('../src/lib/suscripcion')
mock.module('../src/lib/suscripcion', () => ({ ...suscripcion, resolverSuscripcionUnica: async () => ({ estado: null, sinSuscripcion: true }) }))
const planes = await import('../src/lib/planes')
mock.module('../src/lib/planes', () => ({ ...planes, resolverSuscripcion: async () => ({ features: new Set() }) }))
const modulos = await import('../src/lib/modulos')
mock.module('../src/lib/modulos', () => ({ ...modulos, tieneModuloActivo: async () => false }))
const { restauranteRoute } = await import('../src/routes/restaruante')

test('profile conserva eventoSucursalId al guardar, refrescar y volver al catálogo habitual', async () => {
  const leer = async () => {
    const response = await restauranteRoute.request('/profile')
    expect(response.status).toBe(200)
    return (await response.json() as any).data.productos
  }
  const iniciales = await leer()
  expect(iniciales[0]).toMatchObject({ id: 1, eventoSucursalId: null })
  expect(iniciales[1]).toMatchObject({ id: 2, eventoSucursalId: 20 })
  productos[0]!.evento_sucursal_id = 20
  expect((await leer())[0]).toMatchObject({ id: 1, eventoSucursalId: 20 })
  productos[0]!.evento_sucursal_id = null
  expect((await leer())[0]).toMatchObject({ id: 1, eventoSucursalId: null })
})
