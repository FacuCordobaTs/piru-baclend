import { and, asc, desc, eq, gte, inArray, like, or, sql } from 'drizzle-orm'
import {
  cliente as ClienteTable,
  configuracionPuntos as ConfiguracionPuntosTable,
  pedidoUnificado as PedidoUnificadoTable,
  transaccionPuntos as TransaccionPuntosTable,
} from '../db/schema'
import { MODULE_KEYS, tieneModuloActivo } from './modulos'

export type ModoAcumulacion = 'monto' | 'producto' | 'ambos'
export type TipoDescuentoPuntos = 'fijo' | 'porcentaje'
export type TipoTransaccionPuntos =
  | 'suma_compra'
  | 'canje_producto'
  | 'canje_envio'
  | 'canje_descuento'
  | 'bonus_bienvenida'
  | 'ajuste_manual'
  | 'devolucion_cancelacion'
  | 'expiracion'

export interface ConfiguracionPuntosData {
  id?: number
  restauranteId: number
  activo: boolean
  modoAcumulacion: ModoAcumulacion
  pesosPorPunto: number
  puntosPrimerPedido: number
  puntosMinimosCanje: number
  permitirCanjeEnvioGratis: boolean
  permiteCanjeEnvioGratis?: boolean
  puntosEnvioGratis: number
  permitirCanjeDescuento: boolean
  permiteCanjeDescuento?: boolean
  descuentoTipo: TipoDescuentoPuntos
  descuentoValor: string
  descuentoPuntosCosto: number
  descuentoMontoMinimo: string
  descuentoTope: string
  vencimientoDias: number | null
}

export const DEFAULT_CONFIG_PUNTOS: Omit<ConfiguracionPuntosData, 'restauranteId'> = {
  activo: true,
  modoAcumulacion: 'monto',
  pesosPorPunto: 100,
  puntosPrimerPedido: 0,
  puntosMinimosCanje: 0,
  permitirCanjeEnvioGratis: false,
  permiteCanjeEnvioGratis: false,
  puntosEnvioGratis: 300,
  permitirCanjeDescuento: false,
  permiteCanjeDescuento: false,
  descuentoTipo: 'fijo',
  descuentoValor: '0.00',
  descuentoPuntosCosto: 0,
  descuentoMontoMinimo: '0.00',
  descuentoTope: '0.00',
  vencimientoDias: null,
}

/**
 * Obtiene la configuración del programa de puntos de un restaurante.
 * Si no existe en base de datos, devuelve la configuración predeterminada.
 */
export async function obtenerConfiguracionPuntos(db: any, restauranteId: number): Promise<ConfiguracionPuntosData> {
  const [row] = await db
    .select()
    .from(ConfiguracionPuntosTable)
    .where(eq(ConfiguracionPuntosTable.restauranteId, restauranteId))
    .limit(1)

  if (row) {
    return {
      id: row.id,
      restauranteId: row.restauranteId,
      activo: row.activo,
      modoAcumulacion: row.modoAcumulacion,
      pesosPorPunto: row.pesosPorPunto,
      puntosPrimerPedido: row.puntosPrimerPedido,
      puntosMinimosCanje: row.puntosMinimosCanje,
      permitirCanjeEnvioGratis: row.permitirCanjeEnvioGratis,
      permiteCanjeEnvioGratis: row.permitirCanjeEnvioGratis,
      puntosEnvioGratis: row.puntosEnvioGratis,
      permitirCanjeDescuento: row.permitirCanjeDescuento,
      permiteCanjeDescuento: row.permitirCanjeDescuento,
      descuentoTipo: row.descuentoTipo,
      descuentoValor: row.descuentoValor,
      descuentoPuntosCosto: row.descuentoPuntosCosto,
      descuentoMontoMinimo: row.descuentoMontoMinimo,
      descuentoTope: row.descuentoTope,
      vencimientoDias: row.vencimientoDias,
    }
  }

  return {
    ...DEFAULT_CONFIG_PUNTOS,
    restauranteId,
  }
}

/**
 * Guarda o actualiza la configuración de puntos del restaurante.
 */
export async function guardarConfiguracionPuntos(
  db: any,
  restauranteId: number,
  config: Partial<Omit<ConfiguracionPuntosData, 'id' | 'restauranteId'>>
): Promise<ConfiguracionPuntosData> {
  const {
    permiteCanjeEnvioGratis,
    permiteCanjeDescuento,
    ...cleanConfig
  } = config as any

  const dataToSave: any = {
    ...cleanConfig,
    ...(permiteCanjeEnvioGratis !== undefined && { permitirCanjeEnvioGratis: Boolean(permiteCanjeEnvioGratis) }),
    ...(permiteCanjeDescuento !== undefined && { permitirCanjeDescuento: Boolean(permiteCanjeDescuento) }),
  }

  const existente = await db
    .select({ id: ConfiguracionPuntosTable.id })
    .from(ConfiguracionPuntosTable)
    .where(eq(ConfiguracionPuntosTable.restauranteId, restauranteId))
    .limit(1)

  if (existente.length > 0) {
    await db
      .update(ConfiguracionPuntosTable)
      .set(dataToSave)
      .where(eq(ConfiguracionPuntosTable.restauranteId, restauranteId))
  } else {
    await db.insert(ConfiguracionPuntosTable).values({
      ...DEFAULT_CONFIG_PUNTOS,
      ...dataToSave,
      restauranteId,
    })
  }

  return obtenerConfiguracionPuntos(db, restauranteId)
}

/**
 * Calcula cuántos puntos otorga una compra según la configuración activa.
 * - En modo 'monto': Math.floor(subtotal / pesosPorPunto)
 * - En modo 'producto': suma de puntosGanados de los productos comprados (no canjeados)
 * - En modo 'ambos': suma de ambos métodos
 */
export function calcularPuntosGanados(
  config: ConfiguracionPuntosData,
  subtotalEfectivo: number,
  items: Array<{ productoId: number; cantidad: number; esCanjePuntos?: boolean }>,
  puntosPorProductoMap: Map<number, { puntosGanados: number; puntosNecesarios: number }>
): number {
  if (!config.activo) return 0

  let puntosPorMonto = 0
  if (config.modoAcumulacion === 'monto' || config.modoAcumulacion === 'ambos') {
    const divisor = config.pesosPorPunto > 0 ? config.pesosPorPunto : 100
    puntosPorMonto = Math.floor(Math.max(0, subtotalEfectivo) / divisor)
  }

  let puntosPorProducto = 0
  if (config.modoAcumulacion === 'producto' || config.modoAcumulacion === 'ambos') {
    for (const item of items) {
      if (item.esCanjePuntos) continue
      const prodPuntos = puntosPorProductoMap.get(item.productoId)
      if (prodPuntos && prodPuntos.puntosGanados > 0) {
        puntosPorProducto += prodPuntos.puntosGanados * item.cantidad
      }
    }
  }

  return puntosPorMonto + puntosPorProducto
}

/**
 * Asienta un movimiento de puntos de forma atómica en una transacción y actualiza
 * el saldo del cliente en ClienteTable.
 */
export async function registrarTransaccionPuntos(
  tx: any,
  params: {
    restauranteId: number
    clienteId: number
    pedidoUnificadoId?: number | null
    tipo: TipoTransaccionPuntos
    puntos: number // Positivo para sumar, negativo para restar
    motivo: string
  }
): Promise<{ saldoResultante: number; transaccionId: number }> {
  const [cliente] = await tx
    .select({ id: ClienteTable.id, puntos: ClienteTable.puntos })
    .from(ClienteTable)
    .where(and(eq(ClienteTable.id, params.clienteId), eq(ClienteTable.restauranteId, params.restauranteId)))
    .limit(1)

  if (!cliente) {
    throw new Error('Cliente no encontrado para registrar puntos')
  }

  const saldoPrevio = cliente.puntos || 0
  const nuevoSaldo = saldoPrevio + params.puntos

  if (nuevoSaldo < 0 && params.puntos < 0) {
    throw new Error(`Puntos insuficientes: saldo actual ${saldoPrevio}, requeridos ${Math.abs(params.puntos)}`)
  }

  await tx
    .update(ClienteTable)
    .set({ puntos: nuevoSaldo })
    .where(eq(ClienteTable.id, params.clienteId))

  const [insertRes] = await tx.insert(TransaccionPuntosTable).values({
    restauranteId: params.restauranteId,
    clienteId: params.clienteId,
    pedidoUnificadoId: params.pedidoUnificadoId ?? null,
    tipo: params.tipo,
    puntos: params.puntos,
    saldoResultante: nuevoSaldo,
    motivo: params.motivo,
  })

  return {
    saldoResultante: nuevoSaldo,
    transaccionId: Number(insertRes.insertId),
  }
}

/**
 * Acredita de manera idempotente los puntos ganados por un pedido cuyo pago fue confirmado.
 */
export async function acreditarPuntosPedidoAprobado(db: any, pedidoId: number): Promise<boolean> {
  return db.transaction(async (tx: any) => {
    const [pedido] = await tx
      .select({
        id: PedidoUnificadoTable.id,
        restauranteId: PedidoUnificadoTable.restauranteId,
        clienteId: PedidoUnificadoTable.clienteId,
        puntosGanados: PedidoUnificadoTable.puntosGanados,
      })
      .from(PedidoUnificadoTable)
      .where(eq(PedidoUnificadoTable.id, pedidoId))
      .limit(1)

    if (!pedido || !pedido.clienteId || !pedido.puntosGanados || pedido.puntosGanados <= 0) {
      return false
    }

    // Verificar si el restaurante tiene el módulo activo
    const tieneModulo = await tieneModuloActivo(tx, pedido.restauranteId, MODULE_KEYS.PUNTOS_CLIENTES)
    if (!tieneModulo) return false

    // Idempotencia: verificar si ya se acreditaron puntos por este pedido
    const [existente] = await tx
      .select({ id: TransaccionPuntosTable.id })
      .from(TransaccionPuntosTable)
      .where(
        and(
          eq(TransaccionPuntosTable.pedidoUnificadoId, pedidoId),
          eq(TransaccionPuntosTable.tipo, 'suma_compra')
        )
      )
      .limit(1)

    if (existente) {
      return false // Ya fue acreditado previamente
    }

    await registrarTransaccionPuntos(tx, {
      restauranteId: pedido.restauranteId,
      clienteId: pedido.clienteId,
      pedidoUnificadoId: pedido.id,
      tipo: 'suma_compra',
      puntos: pedido.puntosGanados,
      motivo: `Puntos ganados en pedido #${pedido.id}`,
    })

    // Chequear si corresponde bonus de bienvenida por primer pedido
    const config = await obtenerConfiguracionPuntos(tx, pedido.restauranteId)
    if (config.puntosPrimerPedido > 0) {
      const [comprasPrevias] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(TransaccionPuntosTable)
        .where(
          and(
            eq(TransaccionPuntosTable.clienteId, pedido.clienteId),
            eq(TransaccionPuntosTable.tipo, 'suma_compra')
          )
        )

      if (Number(comprasPrevias?.count || 0) <= 1) {
        // Solo la compra actual: otorgar bonus
        await registrarTransaccionPuntos(tx, {
          restauranteId: pedido.restauranteId,
          clienteId: pedido.clienteId,
          pedidoUnificadoId: pedido.id,
          tipo: 'bonus_bienvenida',
          puntos: config.puntosPrimerPedido,
          motivo: `Bono de bienvenida primer pedido`,
        })
      }
    }

    return true
  })
}

/**
 * Reinvierte los puntos cuando un pedido es cancelado o rechazado:
 * - Devuelve los puntos usados en el canje al cliente.
 * - Descuenta los puntos ganados si ya habían sido acreditados.
 */
export async function revertirPuntosPedidoCancelado(db: any, pedidoId: number): Promise<void> {
  await db.transaction(async (tx: any) => {
    const [pedido] = await tx
      .select({
        id: PedidoUnificadoTable.id,
        restauranteId: PedidoUnificadoTable.restauranteId,
        clienteId: PedidoUnificadoTable.clienteId,
        puntosGanados: PedidoUnificadoTable.puntosGanados,
        puntosUsados: PedidoUnificadoTable.puntosUsados,
      })
      .from(PedidoUnificadoTable)
      .where(eq(PedidoUnificadoTable.id, pedidoId))
      .limit(1)

    if (!pedido || !pedido.clienteId) return

    // 1. Devolver puntos canjeados si los hubo
    if (pedido.puntosUsados > 0) {
      const [reversionCanjeExistente] = await tx
        .select({ id: TransaccionPuntosTable.id })
        .from(TransaccionPuntosTable)
        .where(
          and(
            eq(TransaccionPuntosTable.pedidoUnificadoId, pedidoId),
            eq(TransaccionPuntosTable.tipo, 'devolucion_cancelacion')
          )
        )
        .limit(1)

      if (!reversionCanjeExistente) {
        await registrarTransaccionPuntos(tx, {
          restauranteId: pedido.restauranteId,
          clienteId: pedido.clienteId,
          pedidoUnificadoId: pedido.id,
          tipo: 'devolucion_cancelacion',
          puntos: pedido.puntosUsados,
          motivo: `Devolución por cancelación de pedido #${pedido.id}`,
        })
      }
    }

    // 2. Si se habían sumado puntos por la compra, deducirlos para no dejar saldo indebido
    if (pedido.puntosGanados > 0) {
      const [ganadosRegistrados] = await tx
        .select({ id: TransaccionPuntosTable.id })
        .from(TransaccionPuntosTable)
        .where(
          and(
            eq(TransaccionPuntosTable.pedidoUnificadoId, pedidoId),
            eq(TransaccionPuntosTable.tipo, 'suma_compra')
          )
        )
        .limit(1)

      if (ganadosRegistrados) {
        // Verificar si ya se canceló la suma
        const [ajusteReversion] = await tx
          .select({ id: TransaccionPuntosTable.id })
          .from(TransaccionPuntosTable)
          .where(
            and(
              eq(TransaccionPuntosTable.pedidoUnificadoId, pedidoId),
              eq(TransaccionPuntosTable.tipo, 'ajuste_manual'),
              eq(TransaccionPuntosTable.puntos, -pedido.puntosGanados)
            )
          )
          .limit(1)

        if (!ajusteReversion) {
          await registrarTransaccionPuntos(tx, {
            restauranteId: pedido.restauranteId,
            clienteId: pedido.clienteId,
            pedidoUnificadoId: pedido.id,
            tipo: 'ajuste_manual',
            puntos: -pedido.puntosGanados,
            motivo: `Anulación de puntos ganados por cancelación de pedido #${pedido.id}`,
          })
        }
      }
    }
  })
}

/**
 * Permite a un administrador hacer un ajuste manual de puntos a un cliente (sumar o restar).
 */
export async function ajusteManualPuntos(
  db: any,
  restauranteId: number,
  clienteId: number,
  puntos: number,
  motivo: string
): Promise<{ saldoResultante: number; puntosActuales: number; transaccionId: number }> {
  return db.transaction(async (tx: any) => {
    const resultado = await registrarTransaccionPuntos(tx, {
      restauranteId,
      clienteId,
      tipo: 'ajuste_manual',
      puntos,
      motivo: motivo.trim() || 'Ajuste manual de administración',
    })
    // `puntosActuales` es el nombre que ya consume el admin; `saldoResultante`
    // se conserva porque describe lo mismo desde el lado del ledger.
    return { ...resultado, puntosActuales: resultado.saldoResultante }
  })
}

/**
 * Lista los movimientos de puntos de un cliente.
 */
export async function listarTransaccionesCliente(
  db: any,
  restauranteId: number,
  clienteId: number,
  limit = 50
) {
  return db
    .select({
      id: TransaccionPuntosTable.id,
      pedidoUnificadoId: TransaccionPuntosTable.pedidoUnificadoId,
      tipo: TransaccionPuntosTable.tipo,
      puntos: TransaccionPuntosTable.puntos,
      saldoResultante: TransaccionPuntosTable.saldoResultante,
      motivo: TransaccionPuntosTable.motivo,
      createdAt: TransaccionPuntosTable.createdAt,
    })
    .from(TransaccionPuntosTable)
    .where(
      and(
        eq(TransaccionPuntosTable.restauranteId, restauranteId),
        eq(TransaccionPuntosTable.clienteId, clienteId)
      )
    )
    .orderBy(desc(TransaccionPuntosTable.createdAt))
    .limit(limit)
}

// ─── Lectura agregada del Club de Puntos ────────────────────────────────────
// Lo que sigue alimenta la mitad "Puntos" de la pantalla de Retención: totales
// del programa, clientes con saldo y el ledger global de movimientos.

/** Canjes: los tres tipos que consumen puntos del saldo del cliente. */
export const TIPOS_CANJE_PUNTOS: readonly TipoTransaccionPuntos[] = [
  'canje_producto',
  'canje_envio',
  'canje_descuento',
]

const MS_POR_DIA = 24 * 60 * 60 * 1000

/** mysql2 devuelve SUM()/COUNT() sobre DECIMAL como string. */
function aNumero(valor: unknown): number {
  const numero = Number(valor ?? 0)
  return Number.isFinite(numero) ? numero : 0
}

function iso(valor: Date | string | null | undefined): string | null {
  if (!valor) return null
  const fecha = valor instanceof Date ? valor : new Date(valor)
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString()
}

/** `tipo IN (...)` de canjes, parametrizado, reutilizable dentro de un CASE. */
function condicionCanjeSql() {
  return sql`${TransaccionPuntosTable.tipo} IN (${sql.join(
    TIPOS_CANJE_PUNTOS.map((tipo) => sql`${tipo}`),
    sql`, `
  )})`
}

export interface ResumenPuntosData {
  clientesConPuntos: number
  clientesConHistorial: number
  puntosEnCirculacion: number
  puntosOtorgados: number
  puntosCanjeados: number
  canjes: number
  movimientos: number
  canjesProducto: number
  canjesEnvio: number
  canjesDescuento: number
  puntosOtorgados30Dias: number
  canjes30Dias: number
  ultimoMovimientoAt: string | null
}

/**
 * Totales del programa de puntos del restaurante.
 * `puntosEnCirculacion` es el saldo vivo (lo que el local debe en canjes);
 * `puntosOtorgados`/`puntosCanjeados` son histórico acumulado del ledger.
 */
export async function resumenPuntos(db: any, restauranteId: number): Promise<ResumenPuntosData> {
  const hace30Dias = new Date(Date.now() - 30 * MS_POR_DIA)
  const canje = condicionCanjeSql()

  const [clientes] = await db
    .select({
      clientesConPuntos: sql<number>`count(CASE WHEN ${ClienteTable.puntos} > 0 THEN 1 END)`,
      puntosEnCirculacion: sql<number>`coalesce(sum(CASE WHEN ${ClienteTable.puntos} > 0 THEN ${ClienteTable.puntos} ELSE 0 END), 0)`,
      clientesConHistorial: sql<number>`count(CASE WHEN ${ClienteTable.puntos} <> 0 THEN 1 END)`,
    })
    .from(ClienteTable)
    .where(eq(ClienteTable.restauranteId, restauranteId))

  const [ledger] = await db
    .select({
      movimientos: sql<number>`count(*)`,
      clientesConLedger: sql<number>`count(distinct ${TransaccionPuntosTable.clienteId})`,
      puntosOtorgados: sql<number>`coalesce(sum(CASE WHEN ${TransaccionPuntosTable.puntos} > 0 THEN ${TransaccionPuntosTable.puntos} ELSE 0 END), 0)`,
      puntosCanjeados: sql<number>`coalesce(sum(CASE WHEN ${canje} THEN -${TransaccionPuntosTable.puntos} ELSE 0 END), 0)`,
      canjes: sql<number>`count(CASE WHEN ${canje} THEN 1 END)`,
      canjesProducto: sql<number>`count(CASE WHEN ${TransaccionPuntosTable.tipo} = 'canje_producto' THEN 1 END)`,
      canjesEnvio: sql<number>`count(CASE WHEN ${TransaccionPuntosTable.tipo} = 'canje_envio' THEN 1 END)`,
      canjesDescuento: sql<number>`count(CASE WHEN ${TransaccionPuntosTable.tipo} = 'canje_descuento' THEN 1 END)`,
      ultimoMovimientoAt: sql`max(${TransaccionPuntosTable.createdAt})`,
    })
    .from(TransaccionPuntosTable)
    .where(eq(TransaccionPuntosTable.restauranteId, restauranteId))

  const [ultimos30] = await db
    .select({
      puntosOtorgados30Dias: sql<number>`coalesce(sum(CASE WHEN ${TransaccionPuntosTable.puntos} > 0 THEN ${TransaccionPuntosTable.puntos} ELSE 0 END), 0)`,
      canjes30Dias: sql<number>`count(CASE WHEN ${canje} THEN 1 END)`,
    })
    .from(TransaccionPuntosTable)
    .where(
      and(
        eq(TransaccionPuntosTable.restauranteId, restauranteId),
        gte(TransaccionPuntosTable.createdAt, hace30Dias)
      )
    )

  return {
    clientesConPuntos: aNumero(clientes?.clientesConPuntos),
    clientesConHistorial: Math.max(
      aNumero(clientes?.clientesConHistorial),
      aNumero(ledger?.clientesConLedger)
    ),
    puntosEnCirculacion: aNumero(clientes?.puntosEnCirculacion),
    puntosOtorgados: aNumero(ledger?.puntosOtorgados),
    puntosCanjeados: aNumero(ledger?.puntosCanjeados),
    canjes: aNumero(ledger?.canjes),
    movimientos: aNumero(ledger?.movimientos),
    canjesProducto: aNumero(ledger?.canjesProducto),
    canjesEnvio: aNumero(ledger?.canjesEnvio),
    canjesDescuento: aNumero(ledger?.canjesDescuento),
    puntosOtorgados30Dias: aNumero(ultimos30?.puntosOtorgados30Dias),
    canjes30Dias: aNumero(ultimos30?.canjes30Dias),
    ultimoMovimientoAt: iso(ledger?.ultimoMovimientoAt),
  }
}

export type AlcanceClientesPuntos = 'saldo' | 'historial'
export type OrdenClientesPuntos = 'puntos' | 'reciente' | 'nombre'

export interface ClienteConPuntosData {
  id: number
  nombre: string
  telefono: string
  telefonoNormalizado: string | null
  puntos: number
  puntosOtorgados: number
  puntosCanjeados: number
  canjes: number
  movimientos: number
  ultimoMovimientoAt: string | null
}

export interface FiltrosClientesPuntos {
  busqueda?: string | null
  /** `saldo` = sólo clientes con puntos disponibles; `historial` = con saldo o con movimientos. */
  alcance?: AlcanceClientesPuntos
  orden?: OrdenClientesPuntos
  pagina?: number
  limite?: number
}

/**
 * Clientes del restaurante con puntos, con su actividad agregada.
 * Devuelve el saldo cacheado de `cliente.puntos` más los totales del ledger.
 */
export async function listarClientesConPuntos(
  db: any,
  restauranteId: number,
  filtros: FiltrosClientesPuntos = {}
): Promise<{
  items: ClienteConPuntosData[]
  pagina: number
  limite: number
  total: number
  paginas: number
}> {
  const limite = Math.min(Math.max(Number(filtros.limite ?? 25) || 25, 1), 100)
  const pagina = Math.max(Number(filtros.pagina ?? 1) || 1, 1)
  const offset = (pagina - 1) * limite
  const busqueda = filtros.busqueda?.trim()

  // Se resuelve con EXISTS en vez de GROUP BY + HAVING para que el conteo total
  // y la página compartan exactamente el mismo WHERE.
  const alcanceSql =
    filtros.alcance === 'historial'
      ? sql`(${ClienteTable.puntos} <> 0 OR EXISTS (SELECT 1 FROM ${TransaccionPuntosTable} AS tx_puntos WHERE tx_puntos.cliente_id = ${ClienteTable.id} AND tx_puntos.restaurante_id = ${restauranteId}))`
      : sql`${ClienteTable.puntos} > 0`

  const condiciones: any[] = [eq(ClienteTable.restauranteId, restauranteId), alcanceSql]
  if (busqueda) {
    const patron = `%${busqueda}%`
    condiciones.push(
      or(
        like(ClienteTable.nombre, patron),
        like(ClienteTable.telefono, patron),
        like(ClienteTable.telefonoNormalizado, patron)
      )
    )
  }
  const where = and(...condiciones)

  const ordenSql =
    filtros.orden === 'nombre'
      ? [asc(ClienteTable.nombre)]
      : filtros.orden === 'reciente'
        ? [
            sql`max(${TransaccionPuntosTable.createdAt}) IS NULL`,
            desc(sql`max(${TransaccionPuntosTable.createdAt})`),
            desc(ClienteTable.puntos),
          ]
        : [desc(ClienteTable.puntos), asc(ClienteTable.nombre)]

  const canje = condicionCanjeSql()

  const [[conteo], filas] = await Promise.all([
    db.select({ total: sql<number>`count(*)` }).from(ClienteTable).where(where),
    db
      .select({
        id: ClienteTable.id,
        nombre: ClienteTable.nombre,
        telefono: ClienteTable.telefono,
        telefonoNormalizado: ClienteTable.telefonoNormalizado,
        puntos: ClienteTable.puntos,
        movimientos: sql<number>`count(${TransaccionPuntosTable.id})`,
        puntosOtorgados: sql<number>`coalesce(sum(CASE WHEN ${TransaccionPuntosTable.puntos} > 0 THEN ${TransaccionPuntosTable.puntos} ELSE 0 END), 0)`,
        puntosCanjeados: sql<number>`coalesce(sum(CASE WHEN ${canje} THEN -${TransaccionPuntosTable.puntos} ELSE 0 END), 0)`,
        canjes: sql<number>`count(CASE WHEN ${canje} THEN 1 END)`,
        ultimoMovimientoAt: sql`max(${TransaccionPuntosTable.createdAt})`,
      })
      .from(ClienteTable)
      .leftJoin(
        TransaccionPuntosTable,
        and(
          eq(TransaccionPuntosTable.clienteId, ClienteTable.id),
          eq(TransaccionPuntosTable.restauranteId, restauranteId)
        )
      )
      .where(where)
      .groupBy(ClienteTable.id)
      .orderBy(...ordenSql)
      .limit(limite)
      .offset(offset),
  ])

  const items: ClienteConPuntosData[] = filas.map((fila: any) => ({
    id: Number(fila.id),
    nombre: fila.nombre,
    telefono: fila.telefono,
    telefonoNormalizado: fila.telefonoNormalizado ?? null,
    puntos: aNumero(fila.puntos),
    puntosOtorgados: aNumero(fila.puntosOtorgados),
    puntosCanjeados: aNumero(fila.puntosCanjeados),
    canjes: aNumero(fila.canjes),
    movimientos: aNumero(fila.movimientos),
    ultimoMovimientoAt: iso(fila.ultimoMovimientoAt),
  }))

  const total = aNumero(conteo?.total)
  return {
    items,
    pagina,
    limite,
    total,
    paginas: Math.ceil(total / limite),
  }
}

export interface MovimientoPuntosData {
  id: number
  clienteId: number
  clienteNombre: string
  telefono: string | null
  pedidoUnificadoId: number | null
  tipo: TipoTransaccionPuntos
  puntos: number
  saldoResultante: number
  motivo: string
  createdAt: string | null
}

export interface FiltrosMovimientosPuntos {
  clienteId?: number | null
  /** Un tipo concreto, o `canje` para los tres tipos de canje juntos. */
  tipo?: TipoTransaccionPuntos | 'canje' | null
  busqueda?: string | null
  pagina?: number
  limite?: number
}

/**
 * Ledger global de puntos: quién ganó o gastó puntos, cuándo y por qué.
 */
export async function listarMovimientosPuntos(
  db: any,
  restauranteId: number,
  filtros: FiltrosMovimientosPuntos = {}
): Promise<{
  items: MovimientoPuntosData[]
  pagina: number
  limite: number
  total: number
  paginas: number
}> {
  const limite = Math.min(Math.max(Number(filtros.limite ?? 25) || 25, 1), 100)
  const pagina = Math.max(Number(filtros.pagina ?? 1) || 1, 1)
  const offset = (pagina - 1) * limite
  const busqueda = filtros.busqueda?.trim()

  const condiciones: any[] = [eq(TransaccionPuntosTable.restauranteId, restauranteId)]
  if (filtros.clienteId) condiciones.push(eq(TransaccionPuntosTable.clienteId, filtros.clienteId))
  if (filtros.tipo === 'canje') {
    condiciones.push(inArray(TransaccionPuntosTable.tipo, TIPOS_CANJE_PUNTOS as TipoTransaccionPuntos[]))
  } else if (filtros.tipo) {
    condiciones.push(eq(TransaccionPuntosTable.tipo, filtros.tipo))
  }
  if (busqueda) {
    const patron = `%${busqueda}%`
    condiciones.push(
      or(
        like(ClienteTable.nombre, patron),
        like(ClienteTable.telefono, patron),
        like(TransaccionPuntosTable.motivo, patron)
      )
    )
  }
  const where = and(...condiciones)

  const [[conteo], filas] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)` })
      .from(TransaccionPuntosTable)
      .innerJoin(ClienteTable, eq(ClienteTable.id, TransaccionPuntosTable.clienteId))
      .where(where),
    db
      .select({
        id: TransaccionPuntosTable.id,
        clienteId: TransaccionPuntosTable.clienteId,
        clienteNombre: ClienteTable.nombre,
        telefono: ClienteTable.telefono,
        pedidoUnificadoId: TransaccionPuntosTable.pedidoUnificadoId,
        tipo: TransaccionPuntosTable.tipo,
        puntos: TransaccionPuntosTable.puntos,
        saldoResultante: TransaccionPuntosTable.saldoResultante,
        motivo: TransaccionPuntosTable.motivo,
        createdAt: TransaccionPuntosTable.createdAt,
      })
      .from(TransaccionPuntosTable)
      .innerJoin(ClienteTable, eq(ClienteTable.id, TransaccionPuntosTable.clienteId))
      .where(where)
      .orderBy(desc(TransaccionPuntosTable.createdAt), desc(TransaccionPuntosTable.id))
      .limit(limite)
      .offset(offset),
  ])

  const items: MovimientoPuntosData[] = filas.map((fila: any) => ({
    id: Number(fila.id),
    clienteId: Number(fila.clienteId),
    clienteNombre: fila.clienteNombre,
    telefono: fila.telefono ?? null,
    pedidoUnificadoId:
      fila.pedidoUnificadoId === null || fila.pedidoUnificadoId === undefined
        ? null
        : Number(fila.pedidoUnificadoId),
    tipo: fila.tipo,
    puntos: aNumero(fila.puntos),
    saldoResultante: aNumero(fila.saldoResultante),
    motivo: fila.motivo,
    createdAt: iso(fila.createdAt),
  }))

  const total = aNumero(conteo?.total)
  return { items, pagina, limite, total, paginas: Math.ceil(total / limite) }
}

/** Saldo y datos mínimos de un cliente, para el detalle de puntos. */
export async function obtenerClienteConPuntos(db: any, restauranteId: number, clienteId: number) {
  const [fila] = await db
    .select({
      id: ClienteTable.id,
      nombre: ClienteTable.nombre,
      telefono: ClienteTable.telefono,
      puntos: ClienteTable.puntos,
    })
    .from(ClienteTable)
    .where(and(eq(ClienteTable.restauranteId, restauranteId), eq(ClienteTable.id, clienteId)))
    .limit(1)

  if (!fila) return null
  return {
    id: Number(fila.id),
    nombre: fila.nombre,
    telefono: fila.telefono,
    puntos: aNumero(fila.puntos),
  }
}
