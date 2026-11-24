/**
 * Planes de tienda (Inicial, Esencial, Impulso, Escala, Evolución), al estilo Tiendanube.
 *
 * Un plan es un paquete de módulos: no hay un sistema de permisos paralelo. El gate sigue siendo
 * `requireModulo` y `resolverModulosRestaurante` consulta este archivo para decidir qué módulos
 * tiene el local. Las capacidades que sólo da un plan (diseño, código, estadísticas avanzadas,
 * repositorio propio) también son filas de `modulo`, con `activable = false`.
 *
 * Evolución es el plan "legado": los locales que ya existían (y los que arma interno) están ahí y
 * conservan EXACTAMENTE la lógica anterior de suscripción y módulos. Ver docs/PLANES_TIENDA.md.
 */
import { asc, eq } from 'drizzle-orm'
import { type MySql2Database } from 'drizzle-orm/mysql2'
import { planTienda as PlanTiendaTable, restaurante as RestauranteTable } from '../db/schema'

type Db = MySql2Database<Record<string, never>>

export const PLAN_CODIGOS = ['inicial', 'esencial', 'impulso', 'escala', 'evolucion'] as const
export type PlanCodigo = (typeof PLAN_CODIGOS)[number]

/** Plan de los locales anteriores a los planes: todo como estaba. */
export const PLAN_LEGADO: PlanCodigo = 'evolucion'
/** Plan gratuito y plan al que se vuelve cuando vence un plan pago. */
export const PLAN_GRATIS: PlanCodigo = 'inicial'

/** Módulos que sólo da un plan. Viven en la categoría `capacidades_plan`. */
export const CAPACIDADES_PLAN = [
  'diseno_personalizado',
  'codigo_fuente',
  'estadisticas_avanzadas',
  'repositorio_propio',
] as const
export type CapacidadPlan = (typeof CAPACIDADES_PLAN)[number]
export const CATEGORIA_CAPACIDADES_PLAN = 'capacidades_plan'

/** Código del ítem base de una factura de plan: `plan_tienda:impulso`. */
export const PREFIJO_ITEM_PLAN = 'plan_tienda:'

export function esCapacidadPlan(codigo: string): codigo is CapacidadPlan {
  return (CAPACIDADES_PLAN as readonly string[]).includes(codigo)
}

export interface PlanTiendaCatalogo {
  codigo: PlanCodigo
  nombre: string
  descripcion: string | null
  /** null = a medida. 0 = gratis. */
  precioMensual: number | null
  descuentoAnual: number
  orden: number
  destacado: boolean
  modulos: string[]
  beneficios: string[]
}

export function normalizarPlanCodigo(valor: unknown): PlanCodigo {
  return (PLAN_CODIGOS as readonly unknown[]).includes(valor) ? (valor as PlanCodigo) : PLAN_LEGADO
}

export function esPlanPago(plan: Pick<PlanTiendaCatalogo, 'precioMensual'>): boolean {
  return plan.precioMensual !== null && plan.precioMensual > 0
}

/**
 * Plan con el que el local opera ahora. Evolución nunca baja (su acceso lo sigue decidiendo el
 * paywall de siempre). Un plan pago sin suscripción con acceso (vencida, cancelada, nunca pagada)
 * opera como Inicial, igual que Tiendanube cuando no se renueva: la tienda sigue vendiendo.
 */
export function planEfectivo(input: {
  contratado: PlanCodigo
  catalogo: PlanTiendaCatalogo[]
  suscripcionConAcceso: boolean
}): PlanCodigo {
  if (input.contratado === PLAN_LEGADO) return PLAN_LEGADO
  const plan = input.catalogo.find((p) => p.codigo === input.contratado)
  if (!plan) return PLAN_GRATIS
  if (!esPlanPago(plan)) return plan.codigo
  return input.suscripcionConAcceso ? plan.codigo : PLAN_GRATIS
}

/** Evolución incluye todo; el resto, lo que diga su lista. */
export function planIncluyeModulo(plan: PlanCodigo, catalogo: PlanTiendaCatalogo[], codigoModulo: string): boolean {
  if (plan === PLAN_LEGADO) return true
  return catalogo.find((p) => p.codigo === plan)?.modulos.includes(codigoModulo) ?? false
}

/** El plan más barato que incluye el módulo (para "Disponible desde el plan X"). */
export function planMinimoParaModulo(catalogo: PlanTiendaCatalogo[], codigoModulo: string): PlanCodigo | null {
  const ordenados = [...catalogo].sort((a, b) => a.orden - b.orden)
  return ordenados.find((p) => p.codigo !== PLAN_LEGADO && p.modulos.includes(codigoModulo))?.codigo
    ?? (ordenados.some((p) => p.codigo === PLAN_LEGADO) ? PLAN_LEGADO : null)
}

type EstadoFilaModulo = 'inactivo' | 'pendiente_pago' | 'activo' | 'cancelacion_programada' | 'suspendido' | null

/**
 * Política de un módulo para un local con plan (no Evolución). Lo incluido en el plan no se cobra
 * aparte: una capacidad del plan está siempre encendida y una herramienta (POS, mesas…) se usa
 * cuando el dueño la activa en Módulos, como antes. Lo que el plan no incluye, no está.
 */
export function moduloActivoEnPlan(input: {
  codigo: string
  incluidoEnPlan: boolean
  estadoFila: EstadoFilaModulo
  vigenteHasta: Date | null
}, ahora = new Date()): boolean {
  if (!input.incluidoEnPlan) return false
  if (esCapacidadPlan(input.codigo)) return true
  const operativo = input.estadoFila === 'activo' || input.estadoFila === 'cancelacion_programada'
  if (!operativo) return false
  return !input.vigenteHasta || input.vigenteHasta.getTime() > ahora.getTime()
}

// ── Lectura ────────────────────────────────────────────────────────────────

/**
 * La migración `add_planes_tienda.sql` tiene que aplicarse antes del deploy. Si igual falta la
 * tabla o la columna, todos los locales se tratan como Evolución: es exactamente el
 * comportamiento anterior a los planes, así que un deploy adelantado no cambia nada.
 */
export function esEsquemaPendiente(error: unknown): boolean {
  const codigos = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'])
  let actual: any = error
  for (let i = 0; i < 4 && actual; i++) {
    if (codigos.has(actual.code)) return true
    actual = actual.cause
  }
  return false
}

const CACHE_CATALOGO_MS = 60_000
let cacheCatalogo: { hasta: number; planes: PlanTiendaCatalogo[] } | null = null

/** Se vacía al cambiar el catálogo desde código (tests o interno). */
export function invalidarCatalogoPlanes() {
  cacheCatalogo = null
}

const aLista = (valor: unknown): string[] => {
  const v = typeof valor === 'string' ? (() => { try { return JSON.parse(valor) } catch { return [] } })() : valor
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export async function obtenerCatalogoPlanes(db: Db): Promise<PlanTiendaCatalogo[]> {
  if (cacheCatalogo && cacheCatalogo.hasta > Date.now()) return cacheCatalogo.planes
  const filas = await db
    .select()
    .from(PlanTiendaTable)
    .where(eq(PlanTiendaTable.activo, true))
    .orderBy(asc(PlanTiendaTable.orden), asc(PlanTiendaTable.id))
  const planes = filas
    .filter((f) => (PLAN_CODIGOS as readonly string[]).includes(f.codigo))
    .map((f): PlanTiendaCatalogo => ({
      codigo: f.codigo as PlanCodigo,
      nombre: f.nombre,
      descripcion: f.descripcion,
      precioMensual: f.precioMensual === null ? null : Number(f.precioMensual),
      descuentoAnual: f.descuentoAnual,
      orden: f.orden,
      destacado: Boolean(f.destacado),
      modulos: aLista(f.modulos),
      beneficios: aLista(f.beneficios),
    }))
  cacheCatalogo = { hasta: Date.now() + CACHE_CATALOGO_MS, planes }
  return planes
}

export interface PlanRestauranteResuelto {
  contratado: PlanCodigo
  efectivo: PlanCodigo
  /** true = Evolución: módulos y suscripción como siempre. */
  esLegado: boolean
  catalogo: PlanTiendaCatalogo[]
}

const PLAN_RESUELTO_LEGADO: PlanRestauranteResuelto = {
  contratado: PLAN_LEGADO,
  efectivo: PLAN_LEGADO,
  esLegado: true,
  catalogo: [],
}

/**
 * Plan a partir del valor de `restaurante.plan_tienda` ya leído (por ejemplo, junto con la
 * suscripción en una sola consulta). Evolución no lee el catálogo: no lo necesita.
 */
export async function planDesdeValor(
  db: Db,
  valor: unknown,
  suscripcionConAcceso: boolean,
): Promise<PlanRestauranteResuelto> {
  const contratado = normalizarPlanCodigo(valor)
  if (contratado === PLAN_LEGADO) return PLAN_RESUELTO_LEGADO
  try {
    const catalogo = await obtenerCatalogoPlanes(db)
    return { contratado, efectivo: planEfectivo({ contratado, catalogo, suscripcionConAcceso }), esLegado: false, catalogo }
  } catch (error) {
    if (esEsquemaPendiente(error)) return PLAN_RESUELTO_LEGADO
    throw error
  }
}

/**
 * Resuelve el plan del local. `suscripcionConAcceso` lo pasa quien ya leyó la suscripción
 * (estados `trial`, `activa` o `pago_pendiente`).
 */
export async function resolverPlanRestaurante(
  db: Db,
  restauranteId: number,
  suscripcionConAcceso: boolean,
): Promise<PlanRestauranteResuelto> {
  try {
    const [fila] = await db
      .select({ planTienda: RestauranteTable.planTienda })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)
    return await planDesdeValor(db, fila?.planTienda, suscripcionConAcceso)
  } catch (error) {
    if (esEsquemaPendiente(error)) return PLAN_RESUELTO_LEGADO
    throw error
  }
}

// ── Cambio de plan desde interno ───────────────────────────────────────────

/**
 * Qué escribe interno en `restaurante` al cambiarle el plan a un local (null = ya está en ese plan).
 * No toca la suscripción ni los módulos: sólo el plan y el paywall que corresponde a ese plan.
 *  - A Evolución: `requiereSuscripcion = true`, igual que un alta de interno o prospección. Así un
 *    local self-serve (que nace sin paywall) queda con la política vieja completa y no con todo
 *    gratis; su suscripción a medida se asigna desde interno como siempre.
 *  - A cualquier otro plan: `requiereSuscripcion = false`, igual que el alta self-serve (Inicial es
 *    gratis y un plan pago vencido opera como Inicial; el paywall viejo lo bloquearía).
 */
export function cambioPlanInterno(
  actual: unknown,
  nuevo: PlanCodigo,
): { planTienda: PlanCodigo; requiereSuscripcion: boolean } | null {
  if (normalizarPlanCodigo(actual) === nuevo) return null
  return { planTienda: nuevo, requiereSuscripcion: nuevo === PLAN_LEGADO }
}
