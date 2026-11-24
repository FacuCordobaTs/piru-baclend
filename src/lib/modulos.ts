/**
 * Fuente de verdad del dominio de módulos.
 *
 * El acceso al panel se resuelve por separado: este archivo sólo responde si un
 * restaurante tiene una capacidad concreta. En particular, una cuenta sin
 * suscripción nunca recibe módulos pagos por omisión.
 */
import { and, eq } from 'drizzle-orm'
import { type MySql2Database } from 'drizzle-orm/mysql2'
import {
  configuracionSuscripcion as ConfiguracionSuscripcionTable,
  modulo as ModuloTable,
  restaurante as RestauranteTable,
  restauranteModulo as RestauranteModuloTable,
  suscripcion as SuscripcionTable,
} from '../db/schema'
import {
  esCapacidadPlan,
  moduloActivoEnPlan,
  planIncluyeModulo,
  planMinimoParaModulo,
  esEsquemaPendiente,
  planDesdeValor,
  type PlanRestauranteResuelto,
} from './planes-tienda'
import { resolverEstadoPorTiempo, type EstadoSuscripcionTemporal } from './suscripcion-estado'

type Db = MySql2Database<Record<string, never>>

export const MODULE_KEYS = {
  POS: 'pos',
  MESAS: 'mesas',
  PUNTOS_CLIENTES: 'puntos_clientes',
  CODIGOS_DESCUENTO: 'codigos_descuento',
  MERCADOPAGO: 'mercadopago',
  TALO: 'talo',
  RAPIBOY: 'rapiboy',
  FACTURACION_ARCA: 'facturacion_arca',
  GESTION_STOCK: 'gestion_stock',
  GESTION_CADETES: 'gestion_cadetes',
  IMPRESION_COMANDAS: 'impresion_comandas',
  MULTISUCURSAL: 'multisucursal',
  AVISOS_AUTOMATICOS_WHATSAPP: 'avisos_automaticos_whatsapp',
  MOTOR_RECOMPRA: 'motor_recompra',
  CRECIMIENTO: 'crecimiento',
  DIAS_FLOJOS: 'dias_flojos',
  CIERRE_TURNO_MANUAL: 'cierre_turno_manual',
  // Capacidades que sólo da un plan de tienda (ver lib/planes-tienda.ts).
  DISENO_PERSONALIZADO: 'diseno_personalizado',
  CODIGO_FUENTE: 'codigo_fuente',
  ESTADISTICAS_AVANZADAS: 'estadisticas_avanzadas',
  REPOSITORIO_PROPIO: 'repositorio_propio',
} as const

export type ModuleKey = (typeof MODULE_KEYS)[keyof typeof MODULE_KEYS]

/**
 * Cada capacidad exige su entitlement propio. Recompra, Días flojos y Puntos
 * nacieron del desglose de "Retención", pero no son aliases entre sí: un local
 * puede tener el motor de recompra sin el club de puntos, o al revés.
 */
export function codigosQueHabilitanModulo(modulo: ModuleKey): readonly ModuleKey[] {
  return [modulo]
}

export const ESTADOS_SUSCRIPCION_CON_ACCESO = ['trial', 'activa', 'pago_pendiente'] as const
const ESTADOS_SUSCRIPCION_CON_MODULOS_PAGOS = ['activa', 'pago_pendiente'] as const

type EstadoSuscripcion = 'trial' | 'activa' | 'pago_pendiente' | 'suspendida' | 'cancelada' | null
type EstadoModulo = 'inactivo' | 'pendiente_pago' | 'activo' | 'cancelacion_programada' | 'suspendido' | null
type TipoModulo = 'incluido' | 'pago'
type OrigenModulo = 'usuario' | 'interno' | 'migracion' | 'trial' | 'legacy' | null

export interface PoliticaModuloInput {
  tipo: TipoModulo
  estado: EstadoModulo
  origen: OrigenModulo
  precioMensualCongelado: string | number | null
  vigenteHasta: Date | null
  estadoSuscripcion: EstadoSuscripcion
}

/** La política pura permite cubrir la matriz de acceso sin una base de datos. */
export function moduloEstaActivoAhora(input: PoliticaModuloInput, ahora = new Date()): boolean {
  const estadoOperativo = input.estado === 'activo' || input.estado === 'cancelacion_programada'
  if (!estadoOperativo) return false

  // Una baja programada conserva el módulo únicamente hasta el fin ya pagado.
  if (input.vigenteHasta && input.vigenteHasta.getTime() <= ahora.getTime()) return false

  const suscripcionConAcceso = input.estadoSuscripcion !== null
    && ESTADOS_SUSCRIPCION_CON_ACCESO.includes(input.estadoSuscripcion as (typeof ESTADOS_SUSCRIPCION_CON_ACCESO)[number])

  if (input.tipo === 'incluido') {
    // Grandfathered puede optar módulos incluidos sin crear una suscripción. Si
    // sí existe una suscripción, una suspensión/cancelación no los habilita.
    return input.estadoSuscripcion === null || suscripcionConAcceso
  }

  // El trial trae únicamente la base: los módulos pagos no se habilitan ni aun
  // si una fila incoherente llegara a quedar activa. Los entitlements legacy
  // no son una excepción de acceso: toda cuenta debe tener la suscripción
  // vigente para operar un módulo pago.
  const suscripcionPermiteModuloPago = input.estadoSuscripcion !== null
    && ESTADOS_SUSCRIPCION_CON_MODULOS_PAGOS.includes(input.estadoSuscripcion as (typeof ESTADOS_SUSCRIPCION_CON_MODULOS_PAGOS)[number])
  return suscripcionPermiteModuloPago
}

export interface ModuloResuelto {
  id: number
  codigo: string
  categoriaId: number
  nombre: string
  descripcion: string | null
  tipo: TipoModulo
  precioMensual: string
  mensajesUtilityIncluidos: number
  mensajesMarketingIncluidos: number
  estadoProducto: string
  activable: boolean
  icono: string | null
  orden: number
  activoCatalogo: boolean
  estado: EstadoModulo
  origen: OrigenModulo
  precioMensualCongelado: string | null
  vigenteHasta: Date | null
  activoAhora: boolean
  /** Lo incluye el plan efectivo del local. En Evolución, siempre true. */
  incluidoEnPlan: boolean
  /** El plan más barato que lo incluye (para "Disponible desde el plan X"). */
  planMinimo: string | null
}

type ModuloConCodigoYEstado = Pick<ModuloResuelto, 'codigo' | 'activoAhora'>

/** Política pura usada por el runtime para resolver el alias de acceso. */
export function listadoHabilitaModulo(
  modulos: ModuloConCodigoYEstado[],
  modulo: ModuleKey,
): boolean {
  const codigosAceptados = codigosQueHabilitanModulo(modulo)
  return modulos.some((item) => item.activoAhora && codigosAceptados.includes(item.codigo as ModuleKey))
}

export interface SuscripcionYPlan {
  /** Estado guardado de la suscripción (null = sin fila), el que usa la política de siempre. */
  estadoSuscripcion: EstadoSuscripcion
  plan: PlanRestauranteResuelto
}

/**
 * Suscripción y plan del local en UNA consulta (local ⟕ suscripción): Evolución no suma consultas
 * respecto de antes de los planes. Con la migración sin aplicar, cae a la consulta anterior y el
 * local queda en Evolución.
 */
export async function leerSuscripcionYPlan(db: Db, restauranteId: number, ahora = new Date()): Promise<SuscripcionYPlan> {
  type Fila = { estado: string | null; fechaProximoCobro: Date | null; graciaHasta: Date | null; fechaCancelacion: Date | null; planTienda?: string | null }
  let fila: Fila | undefined
  try {
    ;[fila] = await db
      .select({
        estado: SuscripcionTable.estado,
        fechaProximoCobro: SuscripcionTable.fechaProximoCobro,
        graciaHasta: SuscripcionTable.graciaHasta,
        fechaCancelacion: SuscripcionTable.fechaCancelacion,
        planTienda: RestauranteTable.planTienda,
      })
      .from(RestauranteTable)
      .leftJoin(SuscripcionTable, eq(SuscripcionTable.restauranteId, RestauranteTable.id))
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)
  } catch (error) {
    if (!esEsquemaPendiente(error)) throw error
    ;[fila] = await db
      .select({
        estado: SuscripcionTable.estado,
        fechaProximoCobro: SuscripcionTable.fechaProximoCobro,
        graciaHasta: SuscripcionTable.graciaHasta,
        fechaCancelacion: SuscripcionTable.fechaCancelacion,
      })
      .from(SuscripcionTable)
      .where(eq(SuscripcionTable.restauranteId, restauranteId))
      .limit(1)
  }
  const estadoSuscripcion = (fila?.estado ?? null) as EstadoSuscripcion
  // El plan pago vence por fecha aunque nadie haya persistido todavía el cambio de estado.
  const estadoParaPlan = fila?.estado
    ? resolverEstadoPorTiempo({
        estado: fila.estado as EstadoSuscripcionTemporal,
        fechaProximoCobro: fila.fechaProximoCobro,
        graciaHasta: fila.graciaHasta,
        fechaCancelacion: fila.fechaCancelacion,
      }, ahora).estado
    : null
  const conAcceso = estadoParaPlan !== null
    && ESTADOS_SUSCRIPCION_CON_ACCESO.includes(estadoParaPlan as (typeof ESTADOS_SUSCRIPCION_CON_ACCESO)[number])
  return { estadoSuscripcion, plan: await planDesdeValor(db, fila?.planTienda, conAcceso) }
}

/** Devuelve el catálogo completo enriquecido con el entitlement del restaurante. */
export async function resolverModulosRestaurante(
  db: Db,
  restauranteId: number,
  ahora = new Date(),
): Promise<ModuloResuelto[]> {
  return (await resolverModulosYPlan(db, restauranteId, ahora)).modulos
}

/** Igual que `resolverModulosRestaurante`, con el plan y la suscripción que usó para resolver. */
export async function resolverModulosYPlan(
  db: Db,
  restauranteId: number,
  ahora = new Date(),
): Promise<SuscripcionYPlan & { modulos: ModuloResuelto[] }> {
  const { estadoSuscripcion, plan } = await leerSuscripcionYPlan(db, restauranteId, ahora)

  const rows = await db
    .select({
      id: ModuloTable.id,
      codigo: ModuloTable.codigo,
      categoriaId: ModuloTable.categoriaId,
      nombre: ModuloTable.nombre,
      descripcion: ModuloTable.descripcion,
      tipo: ModuloTable.tipo,
      precioMensual: ModuloTable.precioMensual,
      mensajesUtilityIncluidos: ModuloTable.mensajesUtilityIncluidos,
      mensajesMarketingIncluidos: ModuloTable.mensajesMarketingIncluidos,
      estadoProducto: ModuloTable.estadoProducto,
      activable: ModuloTable.activable,
      icono: ModuloTable.icono,
      orden: ModuloTable.orden,
      activoCatalogo: ModuloTable.activo,
      estado: RestauranteModuloTable.estado,
      origen: RestauranteModuloTable.origen,
      precioMensualCongelado: RestauranteModuloTable.precioMensualCongelado,
      vigenteHasta: RestauranteModuloTable.vigenteHasta,
    })
    .from(ModuloTable)
    .leftJoin(
      RestauranteModuloTable,
      and(
        eq(RestauranteModuloTable.moduloId, ModuloTable.id),
        eq(RestauranteModuloTable.restauranteId, restauranteId),
      ),
    )

  const resueltos = rows.map((row) => {
    const estado = (row.estado ?? null) as EstadoModulo
    const origen = (row.origen ?? null) as OrigenModulo
    const precioMensualCongelado = row.precioMensualCongelado?.toString() ?? null
    const vigenteHasta = row.vigenteHasta ?? null
    const incluidoEnPlan = planIncluyeModulo(plan.efectivo, plan.catalogo, row.codigo)
    return {
      ...row,
      tipo: row.tipo as TipoModulo,
      precioMensual: row.precioMensual.toString(),
      estado,
      origen,
      precioMensualCongelado,
      vigenteHasta,
      incluidoEnPlan,
      planMinimo: planMinimoParaModulo(plan.catalogo, row.codigo),
      activoAhora: Boolean(row.activoCatalogo) && moduloActivoParaPlan(plan, {
        codigo: row.codigo,
        incluidoEnPlan,
        politica: {
          tipo: row.tipo as TipoModulo,
          estado,
          origen,
          precioMensualCongelado,
          vigenteHasta,
          estadoSuscripcion,
        },
      }, ahora),
    }
  })

  // Puntos y Días flojos tienen su propio entitlement: ya no se derivan del
  // motor de recompra. `resolverModulosRestaurante` devuelve cada fila tal como
  // quedó en la base.
  return { estadoSuscripcion, plan, modulos: resueltos }
}

/**
 * Evolución (los locales de siempre) resuelve cada módulo con la política anterior, intacta; las
 * capacidades del plan las tiene todas, así nada que antes estaba abierto queda detrás de un plan.
 * Un local con plan nuevo tiene sólo lo que su plan incluye, sin cobro por módulo.
 */
export function moduloActivoParaPlan(
  plan: Pick<PlanRestauranteResuelto, 'esLegado'>,
  modulo: { codigo: string; incluidoEnPlan: boolean; politica: PoliticaModuloInput },
  ahora = new Date(),
): boolean {
  if (plan.esLegado) return esCapacidadPlan(modulo.codigo) || moduloEstaActivoAhora(modulo.politica, ahora)
  return moduloActivoEnPlan({
    codigo: modulo.codigo,
    incluidoEnPlan: modulo.incluidoEnPlan,
    estadoFila: modulo.politica.estado,
    vigenteHasta: modulo.politica.vigenteHasta,
  }, ahora)
}

/** ¿El plan efectivo incluye este módulo? Evolución, todo. */
export function planIncluyeModuloDe(plan: PlanRestauranteResuelto, codigo: string): boolean {
  return planIncluyeModulo(plan.efectivo, plan.catalogo, codigo)
}

export async function tieneModuloActivo(
  db: Db,
  restauranteId: number,
  modulo: ModuleKey,
): Promise<boolean> {
  const modulos = await resolverModulosRestaurante(db, restauranteId)
  return listadoHabilitaModulo(modulos, modulo)
}

export interface ImporteMensualResuelto {
  montoBaseMensual: number
  montoModulosMensual: number
  montoTotalMensual: number
  modulosFacturables: Array<{ codigo: string; montoMensual: number }>
}

/** Cupos de la wallet derivados exclusivamente de entitlements vigentes. */
export interface CuposMensajesPorModulo {
  utility: number
  marketing: number
}

export function sumarCuposMensajesDeModulos(
  modulos: Array<Pick<ModuloResuelto, 'codigo' | 'activoAhora' | 'mensajesUtilityIncluidos' | 'mensajesMarketingIncluidos'>>,
): CuposMensajesPorModulo {
  const modulosActivos = modulos.filter((item) => item.activoAhora)
  return modulosActivos.reduce<CuposMensajesPorModulo>((cupos, item) => {
    cupos.utility += item.mensajesUtilityIncluidos
    cupos.marketing += item.mensajesMarketingIncluidos
    return cupos
  }, { utility: 0, marketing: 0 })
}

type ModuloFacturable = Pick<
  ModuloResuelto,
  'codigo' | 'tipo' | 'estado' | 'precioMensual' | 'precioMensualCongelado'
>

/** Resuelve módulos pagos activos; Recompra, Días flojos, Puntos y Campañas son incluidos y no se facturan. */
export function resolverModulosFacturablesDeListado(
  modulos: ModuloFacturable[],
): Array<{ codigo: string; montoMensual: number }> {
  return modulos.filter((item) => item.tipo === 'pago' && item.estado === 'activo')
    .map((item) => ({
      codigo: item.codigo,
      montoMensual: Number(item.precioMensualCongelado ?? item.precioMensual),
    }))
    .filter((item) => item.montoMensual > 0)
}

/**
 * Los cupos incluidos no pertenecen a la suscripción base ni a un plan legacy:
 * los aporta cada módulo pago que esté operativo en este momento. La suma hace
 * que el dominio siga siendo correcto si el catálogo agrega otro módulo con
 * créditos en el futuro.
 */
export async function resolverCuposMensajesPorModulo(
  db: Db,
  restauranteId: number,
): Promise<CuposMensajesPorModulo> {
  const modulos = await resolverModulosRestaurante(db, restauranteId)
  return sumarCuposMensajesDeModulos(modulos)
}

/**
 * Importe de la próxima factura regular: base vigente + módulos pagos activos.
 * Una baja programada ya no aparece porque no se renueva; el beneficio actual
 * sigue siendo resuelto por `moduloEstaActivoAhora` hasta `vigenteHasta`.
 */
export async function resolverImporteMensual(
  db: Db,
  restauranteId: number,
): Promise<ImporteMensualResuelto> {
  const [configuracion] = await db
    .select({ precioMensual: ConfiguracionSuscripcionTable.precioMensual })
    .from(ConfiguracionSuscripcionTable)
    .where(eq(ConfiguracionSuscripcionTable.codigo, 'piru'))
    .limit(1)

  const { plan, modulos } = await resolverModulosYPlan(db, restauranteId)
  // Con un plan de tienda la cuota es el precio del plan contratado: lo que incluye no se cobra
  // aparte. Evolución sigue con base + módulos pagos, como siempre.
  if (!plan.esLegado) {
    const precioPlan = plan.catalogo.find((p) => p.codigo === plan.contratado)?.precioMensual ?? 0
    return { montoBaseMensual: precioPlan, montoModulosMensual: 0, montoTotalMensual: precioPlan, modulosFacturables: [] }
  }

  // Un módulo activo se factura en la próxima cuota aunque el restaurante no
  // tenga todavía una suscripción activa. Así, el primer checkout incluye los
  // módulos migrados ya normalizados por la migración de separación comercial.
  const modulosFacturables = resolverModulosFacturablesDeListado(modulos)

  const montoBaseMensual = Number(configuracion?.precioMensual ?? 0)
  const montoModulosMensual = modulosFacturables.reduce((total, item) => total + item.montoMensual, 0)
  return {
    montoBaseMensual,
    montoModulosMensual,
    montoTotalMensual: montoBaseMensual + montoModulosMensual,
    modulosFacturables,
  }
}
