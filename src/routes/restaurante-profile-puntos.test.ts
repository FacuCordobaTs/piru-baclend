import { afterAll, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { getTableName } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import * as jwt from 'jsonwebtoken'

// Proyecta las columnas solicitadas por la ruta, para detectar también campos
// que se olviden en el SELECT (no sólo en la serialización del perfil).
let puntos: number | null = 700
let soloCanjePuntos = false
const joinsPuntos: Array<{ sql: string; params: unknown[] }> = []
const local = { id: 7, nombre: 'Local', username: 'local', requiereSuscripcion: false }
const dbFalsa = {
  select: (campos?: Record<string, any>) => {
    let tabla = ''
    const q: any = new Proxy({}, {
      get: (_t, metodo) => {
        if (metodo === 'then') return (ok: any, err: any) => {
          const filas = tabla === 'restaurante' ? [local]
            : tabla === 'producto' ? [{
              id: 223, restaurante_id: 7, nombre: 'Milanesa', activo: true,
              puntos_necesarios: puntos, puntos_ganados: puntos === null ? null : 12,
              solo_canje_puntos: soloCanjePuntos, soloCanjePuntos,
            }] : []
          return Promise.resolve(campos ? filas.map(f => Object.fromEntries(
            Object.entries(campos).map(([clave, columna]) => [clave, (f as any)[columna.name] ?? null]),
          )) : filas).then(ok, err)
        }
        return (...args: any[]) => {
          if (metodo === 'from') tabla = getTableName(args[0])
          if (metodo === 'leftJoin' && getTableName(args[0]) === 'producto_puntos') {
            joinsPuntos.push(new MySqlDialect().sqlToQuery(args[1]))
          }
          return q
        }
      },
    })
    return q
  },
}
const rutaDb = resolve(import.meta.dir, '../db')
const dbReal = await import(rutaDb)
const drizzleReal = await import('drizzle-orm/mysql2')
mock.module(rutaDb, () => ({ pool: {} }))
mock.module('drizzle-orm/mysql2', () => ({ drizzle: () => dbFalsa }))
afterAll(() => {
  mock.module(rutaDb, () => dbReal)
  mock.module('drizzle-orm/mysql2', () => drizzleReal)
})
const { Hono } = await import('hono')
const { restauranteRoute } = await import('./restaruante')
const app = new Hono().route('/api/restaurante', restauranteRoute)
const token = jwt.sign({ id: 7, scope: 'restaurante' }, process.env.JWT_SECRET || 'fallback-secret')

test('el perfil del admin conserva el canje configurado en el club y acota sus puntos al local', async () => {
  puntos = 700
  soloCanjePuntos = true
  const respuesta = await app.request('/api/restaurante/profile', { headers: { Authorization: `Bearer ${token}` } })
  expect(respuesta.status).toBe(200)
  const { data } = await respuesta.json()
  expect(data.productos[0]).toMatchObject({ id: 223, puntosNecesarios: 700, puntosGanados: 12, soloCanjePuntos: true })
  expect(joinsPuntos.at(-1)?.sql).toContain('`producto_puntos`.`producto_id` = `producto`.`id`')
  expect(joinsPuntos.at(-1)?.sql).toContain('`producto_puntos`.`restaurante_id` = ?')
  expect(joinsPuntos.at(-1)?.params).toEqual([7])
})

test('sin configuración de puntos el perfil devuelve ceros', async () => {
  puntos = null
  soloCanjePuntos = false
  const respuesta = await app.request('/api/restaurante/profile', { headers: { Authorization: `Bearer ${token}` } })
  expect(respuesta.status).toBe(200)
  const { data } = await respuesta.json()
  expect(data.productos[0]).toMatchObject({ puntosNecesarios: 0, puntosGanados: 0 })
})

const { publicRoute } = await import('./public')
const tienda = new Hono().route('/api/public', publicRoute)
for (const tipo of ['delivery', 'takeaway']) {
  test(`${tipo}: el servidor rechaza comprar un producto exclusivo de canje con dinero`, async () => {
    soloCanjePuntos = true
    const respuesta = await tienda.request(`/api/public/${tipo}/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restauranteId: 7, direccion: 'Mitre 123', lat: -31.6, lng: -60.7,
        items: [{ productoId: 223, cantidad: 1, esCanjePuntos: false }] }),
    })
    expect(respuesta.status).toBe(400)
    expect((await respuesta.json()).message).toBe('Este producto sólo se puede canjear por puntos')
  })
}

const { resolverItemPos } = await import('./pedido-unificado')
test('POS: no permite agregar un producto exclusivo de canje desde un catálogo viejo', async () => {
  soloCanjePuntos = true
  const resultado = await resolverItemPos(dbFalsa, 7, { productoId: 223, cantidad: 1 } as any)
  expect(resultado).toMatchObject({ error: 'ITEM_INVALIDO', message: 'Este producto sólo se puede canjear por puntos en la tienda' })
})
