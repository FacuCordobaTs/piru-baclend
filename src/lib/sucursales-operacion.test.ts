import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { and, eq, sql } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { pedidoUnificado, sucursal } from '../db/schema'
import { eventoHabilitaPos, errorSucursalPos, filtroPedidosPorSede, sucursalPublica, type SucursalOperacion } from './sucursales-operacion'

const dialect = new MySqlDialect()
const sedes: SucursalOperacion[] = [
  { id: 10, activo: true, soloPos: false },
  { id: 11, activo: false, soloPos: false },
  { id: 20, activo: true, soloPos: true },
  { id: 21, activo: false, soloPos: true },
]

// Ejecuta el SQL real del filtro (sintaxis compartida con MySQL) sobre fixtures.
// Las migraciones y rutas completas se cubren aparte con el fixture MySQL opt-in.
function fixture() {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE sucursal (id INTEGER, restaurante_id INTEGER, activo INTEGER, solo_pos INTEGER);
    CREATE TABLE pedido_unificado (id INTEGER, restaurante_id INTEGER, sucursal_id INTEGER);
    INSERT INTO sucursal VALUES (10,1,1,0),(11,1,0,0),(20,1,1,1),(21,1,0,1),(30,2,1,0),(31,2,1,0);
    INSERT INTO pedido_unificado VALUES (1,1,NULL),(2,1,10),(3,1,11),(4,1,20),(5,1,21),(6,2,NULL),(7,2,30),(8,2,31);`)
  return db
}
function ids(db: Database, tenant: number, scope?: string, rows = sedes) {
  const query = dialect.sqlToQuery(sql`SELECT id FROM ${pedidoUnificado} WHERE ${and(
    eq(pedidoUnificado.restauranteId, tenant), filtroPedidosPorSede(rows, tenant, scope),
  )} ORDER BY id`)
  return (db.query(query.sql).all(...query.params as any[]) as { id: number }[]).map(r => r.id)
}

describe('local + evento sin mezclar pedidos', () => {
  test('admin anterior sin filtro conserva NULL y sucursales normales, nunca eventos', () => {
    const db = fixture()
    try {
      for (const scope of [undefined, '', 'all', 'invalido', '999', '11']) expect(ids(db, 1, scope)).toEqual([1, 2, 3])
      expect(ids(db, 1, '10')).toEqual([2])
      expect(ids(db, 1, '20')).toEqual([4])
      expect(ids(db, 1, '21')).toEqual([5])
      expect(ids(db, 1, '30')).toEqual([1, 2, 3]) // id de otro tenant no seleccionable
    } finally { db.close() }
  })

  test('desactivar el evento mantiene ambos historiales aislados', () => {
    const db = fixture()
    try {
      db.exec('UPDATE sucursal SET activo=0 WHERE id=20')
      const inactivas = sedes.map(s => s.id === 20 ? { ...s, activo: false } : s)
      expect(ids(db, 1, undefined, inactivas)).toEqual([1, 2, 3])
      expect(ids(db, 1, '20', inactivas)).toEqual([4])
      expect(errorSucursalPos(inactivas, 20)).not.toBeNull()
      expect(errorSucursalPos(inactivas)).toBeNull()
    } finally { db.close() }
  })

  test('otro restaurante conserva todas sus sucursales y el filtro actual', () => {
    const db = fixture()
    const otras = [30, 31].map(id => ({ id, activo: true, soloPos: false }))
    try {
      expect(ids(db, 2, undefined, otras)).toEqual([6, 7, 8])
      expect(ids(db, 2, '30', otras)).toEqual([7])
      expect(ids(db, 2, '20', otras)).toEqual([6, 7, 8])
      expect(errorSucursalPos(otras)).toBeNull()
      expect(errorSucursalPos(otras, 30)).toBeNull()
      expect(errorSucursalPos([], undefined)).toBeNull()
    } finally { db.close() }
  })

  test('tienda, retiro y zona de delivery sólo aceptan sucursales públicas del tenant', () => {
    const db = fixture()
    try {
      const q = dialect.sqlToQuery(sql`SELECT id FROM ${sucursal} WHERE ${sucursalPublica(1)}`)
      expect(db.query(q.sql).all(...q.params as any[])).toEqual([{ id: 10 }])
      db.exec('DELETE FROM sucursal WHERE id IN (10,11)') // Alfajor, sin locales configurados
      expect(db.query(q.sql).all(...q.params as any[])).toEqual([]) // checkout idéntico al anterior
    } finally { db.close() }
  })

  test('POS sólo se crea en un evento activo y del tenant; nunca reasigna silenciosamente', () => {
    expect(errorSucursalPos(sedes, 20)).toBeNull()
    for (const id of [undefined, 10, 11, 21, 30, 999]) expect(errorSucursalPos(sedes, id)).not.toBeNull()
  })
})

test('el permiso POS propio del evento respeta actividad y suscripción, sin entitlement global', () => {
  const evento = { id: 20, activo: true, soloPos: true }
  for (const estado of ['trial', 'activa', 'pago_pendiente', null] as const) expect(eventoHabilitaPos(evento, estado)).toBe(true)
  for (const estado of ['suspendida', 'cancelada'] as const) expect(eventoHabilitaPos(evento, estado)).toBe(false)
  expect(eventoHabilitaPos({ ...evento, activo: false }, 'activa')).toBe(false)
  expect(eventoHabilitaPos({ ...evento, soloPos: false }, 'activa')).toBe(false)
  expect(eventoHabilitaPos(undefined, 'activa')).toBe(false)
})
