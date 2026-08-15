import { SUSCRIPCION_ESTADOS } from './planes'

export type EstadoSuscripcionTemporal = 'trial' | 'activa' | 'pago_pendiente' | 'suspendida' | 'cancelada'

/** Política pura del ciclo de vida; no abre conexiones ni muta la base. */
export function resolverEstadoPorTiempo(
  sub: { estado: EstadoSuscripcionTemporal; fechaProximoCobro: Date | null; graciaHasta: Date | null; fechaCancelacion: Date | null },
  ahora = new Date(),
  diasGracia = 7,
): { estado: EstadoSuscripcionTemporal; graciaHasta: Date | null } {
  if (sub.estado === SUSCRIPCION_ESTADOS.CANCELADA || sub.estado === SUSCRIPCION_ESTADOS.SUSPENDIDA) {
    return { estado: sub.estado, graciaHasta: sub.graciaHasta }
  }
  if (sub.fechaCancelacion && new Date(sub.fechaCancelacion) <= ahora) {
    return { estado: SUSCRIPCION_ESTADOS.CANCELADA, graciaHasta: sub.graciaHasta }
  }
  const proximoCobro = sub.fechaProximoCobro ? new Date(sub.fechaProximoCobro) : null
  if (!proximoCobro || ahora <= proximoCobro) return { estado: sub.estado, graciaHasta: sub.graciaHasta }
  const graciaHasta = sub.graciaHasta ?? new Date(proximoCobro.getTime() + diasGracia * 24 * 60 * 60 * 1000)
  return ahora <= graciaHasta
    ? { estado: SUSCRIPCION_ESTADOS.PAGO_PENDIENTE, graciaHasta }
    : { estado: SUSCRIPCION_ESTADOS.SUSPENDIDA, graciaHasta }
}
