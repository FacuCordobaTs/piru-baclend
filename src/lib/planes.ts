/**
 * COMPATIBILIDAD LEGACY para admins instalados y el único gate rezagado.
 * El modelo vigente es suscripción única + módulos: código nuevo debe usar
 * lib/suscripcion.ts, lib/modulos.ts y requireModulo. Ver docs/BILLING_AND_MODULES.md.
 */
import { type MySql2Database } from 'drizzle-orm/mysql2'
import { and, eq } from 'drizzle-orm'
import {
  plan as PlanTable,
  planFeature as PlanFeatureTable,
  suscripcion as SuscripcionTable,
} from '../db/schema'

type Db = MySql2Database<Record<string, never>>

/** Códigos de las filas legacy de plan; no crear planes nuevos. */
export const PLAN_CODES = {
  BASICO: 'basico',
  INTERMEDIO: 'intermedio',
  AVANZADO: 'avanzado',
} as const

export type PlanCode = (typeof PLAN_CODES)[keyof typeof PLAN_CODES]

/**
 * Claves legacy de plan_feature. Se conservan para serializar respuestas viejas;
 * no son el catálogo canónico de capacidades.
 */
export const FEATURE_KEYS = {
  /** Avisos automáticos al cliente por WhatsApp ("en camino" / "listo para retirar") con marca del local. */
  AVISOS_WHATSAPP_CLIENTE: 'avisos_whatsapp_cliente',
  /** Facturación electrónica ARCA (AFIP). */
  FACTURACION_ARCA: 'facturacion_arca',
  /** Integración con Rapiboy (cadetes). */
  RAPIBOY: 'rapiboy',
  /** Alias legacy de múltiples sucursales. */
  MULTISUCURSAL: 'multisucursal',
  /** Estadísticas avanzadas. */
  ESTADISTICAS_AVANZADAS: 'estadisticas_avanzadas',
  /** Alias legacy de dominio propio / landing propia. */
  DOMINIO_PROPIO: 'dominio_propio',
  /** Alias legacy de feature. El acceso nuevo se resuelve mediante módulos. */
  MOTOR_RECOMPRA: 'motor_recompra',
} as const

export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS]

/** Matriz histórica usada sólo por compatibilidad de planes. */
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
  /** Prueba: acceso a la suscripción base; módulos pagos se resuelven aparte. */
  TRIAL: 'trial',
  /** Al día: acceso completo. */
  ACTIVA: 'activa',
  /** Venció el cobro pero está en período de gracia: sigue operando con normalidad. */
  PAGO_PENDIENTE: 'pago_pendiente',
  /** Agotada la gracia sin pagar: acceso comercial bloqueado; no corta operaciones ya iniciadas. */
  SUSPENDIDA: 'suspendida',
  /** Baja voluntaria: sin acceso comercial. */
  CANCELADA: 'cancelada',
} as const

export type SuscripcionEstado =
  (typeof SUSCRIPCION_ESTADOS)[keyof typeof SUSCRIPCION_ESTADOS]

/** Estados que el resolver legacy considera con acceso. */
export const ESTADOS_CON_ACCESO_COMPLETO: SuscripcionEstado[] = [
  SUSCRIPCION_ESTADOS.TRIAL,
  SUSCRIPCION_ESTADOS.ACTIVA,
  SUSCRIPCION_ESTADOS.PAGO_PENDIENTE, // en gracia: no se corta nada
]

// ============================================================================
// Chequeo legacy de acceso. Código nuevo usa tieneModuloActivo/requireModulo.
// ============================================================================

/**
 * Fallback histórico de features para cuentas sin fila. No equivale a acceso a
 * módulos pagos y no debe consultarse desde código nuevo.
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
  /** Acceso calculado por el resolvedor legacy. */
  conAccesoAPago: boolean
  /** Features legacy habilitadas para responses/gates antiguos. */
  features: Set<string>
  /** Snapshot legacy de cupo utility por plan. */
  mensajesIncluidos: number
  /** Snapshot legacy de cupo marketing por plan. */
  mensajesMarketingIncluidos: number
  /** LEGACY (Modelo 2): ya ningún plan es ilimitado. Se conserva por retrocompat; siempre false. */
  mensajesIlimitados: boolean
  /** true si es el fallback por no tener fila de suscripción (cuenta pre-planes). */
  sinSuscripcion: boolean
}

/**
 * Resuelve aliases de plan/features para compatibilidad. No usar como dominio
 * canónico de suscripción o módulos.
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
 *  - Cuentas nuevas con hard paywall: sólo con suscripción en estado con acceso
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
