import { and, eq, sql } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { pedidoUnificado, sucursal } from '../db/schema'

type Db = MySql2Database<Record<string, never>>
export type SucursalOperacion = { id: number; activo: boolean; soloPos: boolean }

export function resolverSucursalOperacion(sucursales: SucursalOperacion[], raw?: string) {
  const id = Number(raw)
  // Una sede de evento inactiva conserva su historial aislado: jamás se cae al local.
  const seleccionada = sucursales.find(s => s.id === id && (s.activo || s.soloPos))
  return seleccionada ?? null
}

export function errorSucursalPos(sucursales: SucursalOperacion[], id?: number): string | null {
  const elegida = sucursales.find(s => s.id === id)
  if (id != null && (!elegida || !elegida.activo)) return 'La sucursal no está disponible. Revisá dónde está operando esta computadora.'
  if (sucursales.some(s => s.soloPos && s.activo) && !elegida?.soloPos) {
    return 'El POS está reservado al evento. Seleccioná su sede en esta computadora.'
  }
  return null
}

export function cargarSucursalesOperacion(db: Db, restauranteId: number) {
  return db.select({ id: sucursal.id, activo: sucursal.activo, soloPos: sucursal.soloPos })
    .from(sucursal).where(eq(sucursal.restauranteId, restauranteId))
}

export async function filtroSucursalOperacion(db: Db, restauranteId: number, raw?: string) {
  return filtroPedidosPorSede(await cargarSucursalesOperacion(db, restauranteId), restauranteId, raw)
}

export function filtroPedidosPorSede(sedes: SucursalOperacion[], restauranteId: number, raw?: string) {
  const seleccionada = resolverSucursalOperacion(sedes, raw)
  if (seleccionada) return eq(pedidoUnificado.sucursalId, seleccionada.id)
  // Incluye NULL y TODAS las sucursales convencionales, incluso desactivadas,
  // igual que el admin anterior. Excluye eventos aunque ya hayan terminado.
  return sql`NOT EXISTS (SELECT 1 FROM sucursal sede_evento
    WHERE sede_evento.id = ${pedidoUnificado.sucursalId}
      AND sede_evento.restaurante_id = ${restauranteId} AND sede_evento.solo_pos = 1)`
}

export const sucursalPublica = (restauranteId: number) => and(
  eq(sucursal.restauranteId, restauranteId), eq(sucursal.activo, true), eq(sucursal.soloPos, false),
)
