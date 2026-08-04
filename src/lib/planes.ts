/**
 * Fuente única de verdad para los códigos de plan, las claves de feature y el
 * chequeo de acceso (tieneAcceso). El modelo de datos vive en las tablas
 * plan / plan_feature / suscripcion (ver db/schema.ts); acá están las constantes
 * estables y la ÚNICA función que decide si un local tiene acceso a una feature.
 * Todo el código pregunta por acá y en ningún otro lado.
 */
import { type MySql2Database } from 'drizzle-orm/mysql2'
import { and, eq } from 'drizzle-orm'
import {
  plan as PlanTable,
  planFeature as PlanFeatureTable,
  suscripcion as SuscripcionTable,
} from '../db/schema'

type Db = MySql2Database<Record<string, never>>

/** Códigos estables de plan (columna plan.codigo). El nombre comercial puede cambiar; el código no. */
export const PLAN_CODES = {
  BASICO: 'basico',
  INTERMEDIO: 'intermedio',
  AVANZADO: 'avanzado',
} as const

export type PlanCode = (typeof PLAN_CODES)[keyof typeof PLAN_CODES]

/**
 * Claves canónicas de feature (columna plan_feature.feature_key).
 * Gating por plan (según el modelo de negocio):
 *   Básico+     : MULTISUCURSAL, DOMINIO_PROPIO
 *   Intermedio+ : AVISOS_WHATSAPP_CLIENTE, FACTURACION_ARCA, RAPIBOY, ESTADISTICAS_AVANZADAS
 *   Avanzado    : MOTOR_RECOMPRA
 * Todo lo demás (recepción de pedidos, impresión, cupones, etc.) NO se gatea: está en todos los planes.
 */
export const FEATURE_KEYS = {
  /** Avisos automáticos al cliente por WhatsApp ("en camino" / "listo para retirar") con marca del local. */
  AVISOS_WHATSAPP_CLIENTE: 'avisos_whatsapp_cliente',
  /** Facturación electrónica ARCA (AFIP). */
  FACTURACION_ARCA: 'facturacion_arca',
  /** Integración con Rapiboy (cadetes). */
  RAPIBOY: 'rapiboy',
  /** Múltiples sucursales (Básico+). */
  MULTISUCURSAL: 'multisucursal',
  /** Estadísticas avanzadas. */
  ESTADISTICAS_AVANZADAS: 'estadisticas_avanzadas',
  /** Dominio propio / landing propia (Básico+). */
  DOMINIO_PROPIO: 'dominio_propio',
  /** Motor de Recompra (CRM gastronómico). ROADMAP: aún no construido. */
  MOTOR_RECOMPRA: 'motor_recompra',
} as const

export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS]

/** Features que habilita cada plan por default (el plan superior incluye todo lo del inferior). */
export const PLAN_FEATURES: Record<PlanCode, FeatureKey[]> = {
  [PLAN_CODES.BASICO]: [
    FEATURE_KEYS.MULTISUCURSAL,
    FEATURE_KEYS.DOMINIO_PROPIO,
  ],
  [PLAN_CODES.INTERMEDIO]: [
    FEATURE_KEYS.MULTISUCURSAL,
    FEATURE_KEYS.DOMINIO_PROPIO,
    FEATURE_KEYS.AVISOS_WHATSAPP_CLIENTE,
    FEATURE_KEYS.FACTURACION_ARCA,
    FEATURE_KEYS.RAPIBOY,
    FEATURE_KEYS.ESTADISTICAS_AVANZADAS,
  ],
  [PLAN_CODES.AVANZADO]: [
    FEATURE_KEYS.MULTISUCURSAL,
    FEATURE_KEYS.DOMINIO_PROPIO,
    FEATURE_KEYS.AVISOS_WHATSAPP_CLIENTE,
    FEATURE_KEYS.FACTURACION_ARCA,
    FEATURE_KEYS.RAPIBOY,
    FEATURE_KEYS.ESTADISTICAS_AVANZADAS,
    FEATURE_KEYS.MOTOR_RECOMPRA,
  ],
}

/**
 * Estados de suscripción y qué puede hacer el local en cada uno.
 * Regla dura del negocio: NUNCA cortar en seco por un pago fallido → período de gracia primero.
 */
export const SUSCRIPCION_ESTADOS = {
  /** Prueba: acceso completo al plan contratado. */
  TRIAL: 'trial',
  /** Al día: acceso completo. */
  ACTIVA: 'activa',
  /** Venció el cobro pero está en período de gracia: sigue operando con normalidad. */
  PAGO_PENDIENTE: 'pago_pendiente',
  /** Agotada la gracia sin pagar: features de pago bloqueadas (los pedidos/avisos en curso NO se cortan). */
  SUSPENDIDA: 'suspendida',
  /** Baja voluntaria: sin acceso a features de pago. */
  CANCELADA: 'cancelada',
} as const

export type SuscripcionEstado =
  (typeof SUSCRIPCION_ESTADOS)[keyof typeof SUSCRIPCION_ESTADOS]

/** Estados en los que el local conserva acceso completo a las features de su plan. */
export const ESTADOS_CON_ACCESO_COMPLETO: SuscripcionEstado[] = [
  SUSCRIPCION_ESTADOS.TRIAL,
  SUSCRIPCION_ESTADOS.ACTIVA,
  SUSCRIPCION_ESTADOS.PAGO_PENDIENTE, // en gracia: no se corta nada
]

// ============================================================================
// Chequeo de acceso — la ÚNICA verdad. tieneAcceso(db, localId, 'feature').
// ============================================================================

/**
 * Cuentas anteriores a los planes no tienen fila en `suscripcion`. Para NO romper
 * producción, mientras no tengan suscripción se les da acceso total (fail-open):
 * el gating recién aplica cuando se les asigna un plan (backfill/onboarding).
 * Poné en false cuando todos los restaurantes tengan suscripción para gatear
 * también a los que no la tengan.
 */
export const SIN_SUSCRIPCION_ACCESO_TOTAL = true

/** Todas las feature keys conocidas (usado como acceso total del fallback). */
export const TODAS_LAS_FEATURES: FeatureKey[] = Object.values(FEATURE_KEYS)

export interface SuscripcionResuelta {
  suscripcionId: number | null
  estado: SuscripcionEstado | null
  planId: number | null
  planCodigo: string | null
  planNombre: string | null
  /** Estados trial/activa/pago_pendiente: conserva las features de pago del plan. */
  conAccesoAPago: boolean
  /** Features de pago efectivamente habilitadas ahora mismo. */
  features: Set<string>
  /** Mensajes utility (avisos de pedido) incluidos por ciclo por el plan (0 si no aplica). */
  mensajesIncluidos: number
  /** Mensajes marketing (Motor de Recompra) incluidos por ciclo por el plan (0 si no aplica). */
  mensajesMarketingIncluidos: number
  /** LEGACY (Modelo 2): ya ningún plan es ilimitado. Se conserva por retrocompat; siempre false. */
  mensajesIlimitados: boolean
  /** true si es el fallback por no tener fila de suscripción (cuenta pre-planes). */
  sinSuscripcion: boolean
}

/**
 * Resuelve la suscripción vigente de un restaurante y qué features de pago tiene
 * habilitadas AHORA (según el estado). Fuente para tieneAcceso y para la UI.
 */
export async function resolverSuscripcion(
  db: Db,
  restauranteId: number,
): Promise<SuscripcionResuelta> {
  const [sub] = await db
    .select({
      suscripcionId: SuscripcionTable.id,
      estado: SuscripcionTable.estado,
      planId: PlanTable.id,
      planCodigo: PlanTable.codigo,
      planNombre: PlanTable.nombre,
      mensajesIncluidos: PlanTable.mensajesIncluidos,
      mensajesMarketingIncluidos: PlanTable.mensajesMarketingIncluidos,
      mensajesIlimitados: PlanTable.mensajesIlimitados,
    })
    .from(SuscripcionTable)
    .innerJoin(PlanTable, eq(SuscripcionTable.planId, PlanTable.id))
    .where(eq(SuscripcionTable.restauranteId, restauranteId))
    .limit(1)

  // Sin suscripción: fallback (por defecto, acceso total para no romper prod).
  if (!sub) {
    return {
      suscripcionId: null,
      estado: null,
      planId: null,
      planCodigo: null,
      planNombre: null,
      conAccesoAPago: SIN_SUSCRIPCION_ACCESO_TOTAL,
      features: new Set(SIN_SUSCRIPCION_ACCESO_TOTAL ? TODAS_LAS_FEATURES : []),
      // Cuenta pre-planes: tratada como ilimitada para que el wallet no le restrinja avisos.
      mensajesIncluidos: 0,
      mensajesMarketingIncluidos: 0,
      mensajesIlimitados: SIN_SUSCRIPCION_ACCESO_TOTAL,
      sinSuscripcion: true,
    }
  }

  const estado = sub.estado as SuscripcionEstado
  const conAccesoAPago = ESTADOS_CON_ACCESO_COMPLETO.includes(estado)

  // Suspendida/cancelada: se bloquean las features de pago (los pedidos/avisos en
  // curso no se cortan; eso lo maneja quien envía, no el gate).
  let features = new Set<string>()
  if (conAccesoAPago) {
    const rows = await db
      .select({ featureKey: PlanFeatureTable.featureKey })
      .from(PlanFeatureTable)
      .where(
        and(
          eq(PlanFeatureTable.planId, sub.planId),
          eq(PlanFeatureTable.habilitado, true),
        ),
      )
    features = new Set(rows.map((r) => r.featureKey))
  }

  return {
    suscripcionId: sub.suscripcionId,
    estado,
    planId: sub.planId,
    planCodigo: sub.planCodigo,
    planNombre: sub.planNombre,
    conAccesoAPago,
    features,
    mensajesIncluidos: sub.mensajesIncluidos ?? 0,
    mensajesMarketingIncluidos: sub.mensajesMarketingIncluidos ?? 0,
    mensajesIlimitados: !!sub.mensajesIlimitados,
    sinSuscripcion: false,
  }
}

/**
 * Hard paywall: ¿el local puede USAR el panel? Distinto del gating por feature (tieneAcceso):
 * acá decidimos acceso a TODO el admin, no a una función puntual.
 *  - Cuentas grandfathered (`requiereSuscripcion = false`, p. ej. pre-planes): siempre pueden.
 *  - Cuentas nuevas (bajo el modelo de planes): sólo con suscripción en estado con acceso
 *    (activa / pago_pendiente en gracia). Sin fila de suscripción (nunca pagaron) → bloqueadas.
 * El `SIN_SUSCRIPCION_ACCESO_TOTAL` (fail-open de features) NO aplica acá: una cuenta paywalled
 * sin suscripción queda fuera aunque el fail-open de features siga en true.
 */
export function tieneAccesoAlPanel(
  requiereSuscripcion: boolean,
  sub: SuscripcionResuelta,
): boolean {
  if (!requiereSuscripcion) return true
  if (sub.sinSuscripcion) return false
  return sub.conAccesoAPago
}

/**
 * ÚNICA función de verdad para el gating. Todo el backend pregunta acá:
 *   if (await tieneAcceso(db, restauranteId, FEATURE_KEYS.AVISOS_WHATSAPP_CLIENTE)) { ... }
 * Ocultar un botón en la UI no es seguridad: el chequeo real va SIEMPRE en el backend.
 */
export async function tieneAcceso(
  db: Db,
  restauranteId: number,
  feature: FeatureKey,
): Promise<boolean> {
  const s = await resolverSuscripcion(db, restauranteId)
  return s.features.has(feature)
}
