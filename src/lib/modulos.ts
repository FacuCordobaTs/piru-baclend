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
  restauranteModulo as RestauranteModuloTable,
  suscripcion as SuscripcionTable,
} from '../db/schema'

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
} as const

export type ModuleKey = (typeof MODULE_KEYS)[keyof typeof MODULE_KEYS]

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
  // si una fila incoherente llegara a quedar activa. La única excepción al
  // requisito de suscripción es el entitlement legacy
  // bonificado de Alfajor: fila explícita, activa y precio congelado en cero.
  const esLegacyBonificado = input.origen === 'legacy'
    && Number(input.precioMensualCongelado ?? NaN) === 0
  const suscripcionPermiteModuloPago = input.estadoSuscripcion !== null
    && ESTADOS_SUSCRIPCION_CON_MODULOS_PAGOS.includes(input.estadoSuscripcion as (typeof ESTADOS_SUSCRIPCION_CON_MODULOS_PAGOS)[number])
  return esLegacyBonificado || suscripcionPermiteModuloPago
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
}

/** Devuelve el catálogo completo enriquecido con el entitlement del restaurante. */
export async function resolverModulosRestaurante(
  db: Db,
  restauranteId: number,
  ahora = new Date(),
): Promise<ModuloResuelto[]> {
  const [sub] = await db
    .select({ estado: SuscripcionTable.estado })
    .from(SuscripcionTable)
    .where(eq(SuscripcionTable.restauranteId, restauranteId))
    .limit(1)

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

  return rows.map((row) => {
    const estado = (row.estado ?? null) as EstadoModulo
    const origen = (row.origen ?? null) as OrigenModulo
    const precioMensualCongelado = row.precioMensualCongelado?.toString() ?? null
    const vigenteHasta = row.vigenteHasta ?? null
    return {
      ...row,
      tipo: row.tipo as TipoModulo,
      precioMensual: row.precioMensual.toString(),
      estado,
      origen,
      precioMensualCongelado,
      vigenteHasta,
      activoAhora: Boolean(row.activoCatalogo) && moduloEstaActivoAhora({
        tipo: row.tipo as TipoModulo,
        estado,
        origen,
        precioMensualCongelado,
        vigenteHasta,
        estadoSuscripcion: (sub?.estado ?? null) as EstadoSuscripcion,
      }, ahora),
    }
  })
}

export async function tieneModuloActivo(
  db: Db,
  restauranteId: number,
  modulo: ModuleKey,
): Promise<boolean> {
  const modulos = await resolverModulosRestaurante(db, restauranteId)
  return modulos.some((item) => item.codigo === modulo && item.activoAhora)
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
  modulos: Array<Pick<ModuloResuelto, 'activoAhora' | 'mensajesUtilityIncluidos' | 'mensajesMarketingIncluidos'>>,
): CuposMensajesPorModulo {
  return modulos.reduce<CuposMensajesPorModulo>((cupos, item) => {
    if (!item.activoAhora) return cupos
    cupos.utility += item.mensajesUtilityIncluidos
    cupos.marketing += item.mensajesMarketingIncluidos
    return cupos
  }, { utility: 0, marketing: 0 })
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

  const modulos = await resolverModulosRestaurante(db, restauranteId)
  const modulosFacturables = modulos
    .filter((item) => item.tipo === 'pago' && item.estado === 'activo' && item.activoAhora)
    .map((item) => ({
      codigo: item.codigo,
      montoMensual: Number(item.precioMensualCongelado ?? item.precioMensual),
    }))
    .filter((item) => item.montoMensual > 0)

  const montoBaseMensual = Number(configuracion?.precioMensual ?? 0)
  const montoModulosMensual = modulosFacturables.reduce((total, item) => total + item.montoMensual, 0)
  return {
    montoBaseMensual,
    montoModulosMensual,
    montoTotalMensual: montoBaseMensual + montoModulosMensual,
    modulosFacturables,
  }
}
