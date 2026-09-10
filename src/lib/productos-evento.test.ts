import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { producto } from '../db/schema'
import { productoDisponibleEnPos } from './productos-evento'

test('catálogo y venta aíslan productos exclusivos por evento y restaurante', () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE producto (id INTEGER, restaurante_id INTEGER, evento_sucursal_id INTEGER);
    INSERT INTO producto VALUES (1,1,NULL),(2,1,20),(3,1,21),(4,2,NULL),(5,2,30);`)
  const ids = (tenant: number, sede?: number | null) => {
    const q = new MySqlDialect().sqlToQuery(sql`SELECT id FROM ${producto} WHERE ${and(
      eq(producto.restauranteId, tenant), productoDisponibleEnPos(sede),
    )} ORDER BY id`)
    return (db.query(q.sql).all(...q.params as any[]) as { id: number }[]).map(p => p.id)
  }
  try {
    expect(ids(1)).toEqual([1])
    expect(ids(1, null)).toEqual([1])
    expect(ids(1, 10)).toEqual([1])
    expect(ids(1, 20)).toEqual([1, 2])
    expect(ids(1, 21)).toEqual([1, 3])
    expect(ids(1, 30)).toEqual([1])
    expect(ids(2, 30)).toEqual([4, 5])
    // Reasignar un producto que ya estaba en un carrito web corta su compra.
    db.exec('UPDATE producto SET evento_sucursal_id=20 WHERE id=1')
    const q = new MySqlDialect().sqlToQuery(sql`SELECT id FROM ${producto} WHERE ${and(
      eq(producto.restauranteId, 1), eq(producto.id, 1), isNull(producto.eventoSucursalId),
    )}`)
    expect(db.query(q.sql).all(...q.params as any[])).toEqual([])
    expect(ids(1, 20)).toEqual([1, 2])
  } finally { db.close() }
})
