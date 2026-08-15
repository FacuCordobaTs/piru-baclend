/**
 * Dominio de la suscripción única de Piru.
 *
 * Los campos `plan*` que expone este módulo existen sólo para poder responder
 * a admins instalados durante la transición. No son la fuente comercial: la
 * configuración `piru` es la única suscripción que se puede contratar.
 */
import { and, eq } from 'drizzle-orm'
import { type MySql2Database } from 'drizzle-orm/mysql2'
import {
  configuracionSuscripcion as ConfiguracionSuscripcionTable,
  plan as PlanTable,
  suscripcion as SuscripcionTable,
} from '../db/schema'
import { ESTADOS_SUSCRIPCION_CON_ACCESO } from './modulos'

type Db = MySql2Database<Record<string, never>>

export const SUSCRIPCION_UNICA_CODIGO = 'piru'

export interface ConfiguracionSuscripcionUnica {
  id: number
  codigo: string
  nombre: string
  descripcion: string | null
  precioMensual: string
  descuentoAnual: number
  activo: boolean
}

export interface SuscripcionUnicaResuelta {
  suscripcionId: number | null
  configuracion: ConfiguracionSuscripcionUnica | null
  estado: string | null
  ciclo: 'mensual' | 'anual' | null
  fechaInicio: Date | null
  trialFin: Date | null
  fechaProximoCobro: Date | null
  graciaHasta: Date | null
  fechaCancelacion: Date | null
  precioBaseMensual: string | null
  montoModulosMensual: string | null
  montoTotalMensual: string | null
  conAccesoAPago: boolean
  sinSuscripcion: boolean
  // Aliases de respuesta para admins anteriores. No usarlos para capacidades.
  planId: number | null
  planCodigo: string | null
  planNombre: string | null
}

export async function obtenerConfiguracionSuscripcion(
  db: Db,
): Promise<ConfiguracionSuscripcionUnica | null> {
  const [configuracion] = await db
    .select()
    .from(ConfiguracionSuscripcionTable)
    .where(eq(ConfiguracionSuscripcionTable.codigo, SUSCRIPCION_UNICA_CODIGO))
    .limit(1)

  if (!configuracion) return null
  return {
    id: configuracion.id,
    codigo: configuracion.codigo,
    nombre: configuracion.nombre,
    descripcion: configuracion.descripcion,
    precioMensual: configuracion.precioMensual.toString(),
    descuentoAnual: configuracion.descuentoAnual,
    activo: configuracion.activo,
  }
}

/** Resuelve la suscripción comercial sin derivar catálogo ni precio de `plan`. */
export async function resolverSuscripcionUnica(
  db: Db,
  restauranteId: number,
): Promise<SuscripcionUnicaResuelta> {
  const [row, configuracion] = await Promise.all([
    db
      .select({
        suscripcionId: SuscripcionTable.id,
        estado: SuscripcionTable.estado,
        ciclo: SuscripcionTable.ciclo,
        fechaInicio: SuscripcionTable.fechaInicio,
        trialFin: SuscripcionTable.trialFin,
        fechaProximoCobro: SuscripcionTable.fechaProximoCobro,
        graciaHasta: SuscripcionTable.graciaHasta,
        fechaCancelacion: SuscripcionTable.fechaCancelacion,
        precioBaseMensual: SuscripcionTable.precioBaseMensual,
        montoModulosMensual: SuscripcionTable.montoModulosMensual,
        montoTotalMensual: SuscripcionTable.montoTotalMensual,
        planId: SuscripcionTable.planId,
        planCodigo: PlanTable.codigo,
        planNombre: PlanTable.nombre,
      })
      .from(SuscripcionTable)
      .leftJoin(PlanTable, eq(SuscripcionTable.planId, PlanTable.id))
      .where(eq(SuscripcionTable.restauranteId, restauranteId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    obtenerConfiguracionSuscripcion(db),
  ])

  if (!row) {
    return {
      suscripcionId: null,
      configuracion,
      estado: null,
      ciclo: null,
      fechaInicio: null,
      trialFin: null,
      fechaProximoCobro: null,
      graciaHasta: null,
      fechaCancelacion: null,
      precioBaseMensual: null,
      montoModulosMensual: null,
      montoTotalMensual: null,
      conAccesoAPago: false,
      sinSuscripcion: true,
      planId: null,
      planCodigo: null,
      planNombre: null,
    }
  }

  const estado = row.estado as SuscripcionUnicaResuelta['estado']
  return {
    suscripcionId: row.suscripcionId,
    configuracion,
    estado,
    ciclo: row.ciclo as SuscripcionUnicaResuelta['ciclo'],
    fechaInicio: row.fechaInicio,
    trialFin: row.trialFin,
    fechaProximoCobro: row.fechaProximoCobro,
    graciaHasta: row.graciaHasta,
    fechaCancelacion: row.fechaCancelacion,
    precioBaseMensual: row.precioBaseMensual?.toString() ?? null,
    montoModulosMensual: row.montoModulosMensual?.toString() ?? null,
    montoTotalMensual: row.montoTotalMensual?.toString() ?? null,
    conAccesoAPago: estado !== null
      && ESTADOS_SUSCRIPCION_CON_ACCESO.includes(estado as (typeof ESTADOS_SUSCRIPCION_CON_ACCESO)[number]),
    sinSuscripcion: false,
    planId: row.planId,
    planCodigo: row.planCodigo,
    planNombre: row.planNombre,
  }
}

/** El paywall es independiente de los entitlements de módulos. */
export function tieneAccesoAlPanelSuscripcion(
  requiereSuscripcion: boolean,
  suscripcion: SuscripcionUnicaResuelta,
): boolean {
  return !requiereSuscripcion || (!suscripcion.sinSuscripcion && suscripcion.conAccesoAPago)
}

/**
 * Shape temporal que conserva el contrato de `/planes/catalogo`: una sola
 * opción sintética. El id legacy se mantiene para que una admin anterior pueda
 * continuar iniciando su checkout hasta que T07 reemplace ese flujo.
 */
export async function catalogoSuscripcionUnica(db: Db) {
  const configuracion = await obtenerConfiguracionSuscripcion(db)
  if (!configuracion || !configuracion.activo) return []

  const [planLegacy] = await db
    .select({ id: PlanTable.id })
    .from(PlanTable)
    .where(and(eq(PlanTable.codigo, 'basico'), eq(PlanTable.activo, true)))
    .limit(1)

  return [{
    // `id` conserva la semántica que espera el checkout legacy.
    id: planLegacy?.id ?? configuracion.id,
    codigo: SUSCRIPCION_UNICA_CODIGO,
    nombre: configuracion.nombre,
    descripcion: configuracion.descripcion,
    precioMensual: configuracion.precioMensual,
    descuentoAnual: configuracion.descuentoAnual,
    mensajesIncluidos: 0,
    mensajesMarketingIncluidos: 0,
    mensajesIlimitados: false,
    orden: 0,
    activo: configuracion.activo,
    features: [],
    configuracionSuscripcionId: configuracion.id,
    tipo: 'suscripcion_unica' as const,
  }]
}
