import { eq, isNull, or } from 'drizzle-orm'
import { producto } from '../db/schema'

/** El catálogo común sigue disponible; un exclusivo sólo admite su sede. */
export function productoDisponibleEnPos(sucursalId?: number | null) {
  return sucursalId == null
    ? isNull(producto.eventoSucursalId)
    : or(isNull(producto.eventoSucursalId), eq(producto.eventoSucursalId, sucursalId))!
}
