import { and, desc, eq, sql } from 'drizzle-orm'
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
  puntosEnvioGratis: number
  permitirCanjeDescuento: boolean
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
  puntosEnvioGratis: 300,
  permitirCanjeDescuento: false,
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
      puntosEnvioGratis: row.puntosEnvioGratis,
      permitirCanjeDescuento: row.permitirCanjeDescuento,
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
  const existente = await db
    .select({ id: ConfiguracionPuntosTable.id })
    .from(ConfiguracionPuntosTable)
    .where(eq(ConfiguracionPuntosTable.restauranteId, restauranteId))
    .limit(1)

  if (existente.length > 0) {
    await db
      .update(ConfiguracionPuntosTable)
      .set(config)
      .where(eq(ConfiguracionPuntosTable.restauranteId, restauranteId))
  } else {
    await db.insert(ConfiguracionPuntosTable).values({
      ...DEFAULT_CONFIG_PUNTOS,
      ...config,
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
): Promise<{ saldoResultante: number; transaccionId: number }> {
  return db.transaction(async (tx: any) => {
    return registrarTransaccionPuntos(tx, {
      restauranteId,
      clienteId,
      tipo: 'ajuste_manual',
      puntos,
      motivo: motivo.trim() || 'Ajuste manual de administración',
    })
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
