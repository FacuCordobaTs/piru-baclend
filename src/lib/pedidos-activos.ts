// src/lib/pedidos-activos.ts
import { type MySql2Database } from 'drizzle-orm/mysql2'
import { eq, and, or, not, inArray, notInArray, sql, desc } from 'drizzle-orm'
import {
  pedidoUnificado as PedidoUnificadoTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  producto as ProductoTable,
  ingrediente as IngredienteTable,
  restaurante as RestauranteTable,
  codigoDescuento as CodigoDescuentoTable,
  sucursal as SucursalTable,
  repartidor as RepartidorTable,
} from '../db/schema'
import {
  rowToPagoRow,
  restauranteOcultaPedidosNoPagados,
  resolveMetodosPagoConfig,
  buildMetodosPublicosList,
  METODOS_PAGO_AUTOMATICOS_EN_PEDIDO,
  METODOS_PAGO_MANUAL_VERIFICABLE_EN_PEDIDO,
} from './metodos-pago'
import { wsManager } from '../websocket/manager'

type Db = MySql2Database<Record<string, never>>

export async function enrichItemsWithProductInfo(db: Db, itemsRaw: any[]) {
  return Promise.all(
    itemsRaw.map(async (item) => {
      let ingredientesExcluidosNombres: string[] = []
      if (item.ingredientesExcluidos && Array.isArray(item.ingredientesExcluidos) && item.ingredientesExcluidos.length > 0) {
        const ingredientes = await db
          .select({ id: IngredienteTable.id, nombre: IngredienteTable.nombre })
          .from(IngredienteTable)
          .where(inArray(IngredienteTable.id, item.ingredientesExcluidos as number[]))
        ingredientesExcluidosNombres = ingredientes.map((ing) => ing.nombre)
      }
      let agregadosParsed: any[] = []
      if (item.agregados) {
        if (typeof item.agregados === 'string') {
          try { agregadosParsed = JSON.parse(item.agregados) } catch {}
        } else if (Array.isArray(item.agregados)) {
          agregadosParsed = item.agregados
        }
      }
      return {
        ...item,
        ingredientesExcluidos: item.ingredientesExcluidos || [],
        ingredientesExcluidosNombres,
        agregados: agregadosParsed,
      }
    })
  )
}

export const PEDIDO_LIST_PROJECTION = {
  id: PedidoUnificadoTable.id,
  tipo: PedidoUnificadoTable.tipo,
  direccion: PedidoUnificadoTable.direccion,
  nombreCliente: PedidoUnificadoTable.nombreCliente,
  telefono: PedidoUnificadoTable.telefono,
  estado: PedidoUnificadoTable.estado,
  total: PedidoUnificadoTable.total,
  notas: PedidoUnificadoTable.notas,
  createdAt: PedidoUnificadoTable.createdAt,
  deliveredAt: PedidoUnificadoTable.deliveredAt,
  pagado: PedidoUnificadoTable.pagado,
  metodoPago: PedidoUnificadoTable.metodoPago,
  impreso: PedidoUnificadoTable.impreso,
  rapiboyTrackingUrl: PedidoUnificadoTable.rapiboyTrackingUrl,
  codigoDescuentoId: PedidoUnificadoTable.codigoDescuentoId,
  montoDescuento: PedidoUnificadoTable.montoDescuento,
  sucursalId: PedidoUnificadoTable.sucursalId,
  sucursalNombre: SucursalTable.nombre,
  codigoDescuentoCodigo: CodigoDescuentoTable.codigo,
  demoraMinutos: PedidoUnificadoTable.demoraMinutos,
  notificarWhatsapp: PedidoUnificadoTable.notificarWhatsapp,
  horarioProgramado: PedidoUnificadoTable.horarioProgramado,
  latitud: PedidoUnificadoTable.latitud,
  longitud: PedidoUnificadoTable.longitud,
  deliveryFee: PedidoUnificadoTable.deliveryFee,
  repartidorId: PedidoUnificadoTable.repartidorId,
  repartidorNombre: RepartidorTable.nombre,
  grupal: PedidoUnificadoTable.grupal,
  creadoPorIa: PedidoUnificadoTable.creadoPorIa,
  anotadoManualmente: PedidoUnificadoTable.anotadoManualmente,
} as const

/** WHERE compartido por /list y /activos (incluye la lógica de ocultar impagos). */
export async function buildPedidosWhere(
  db: Db,
  restauranteId: number,
  tipo: 'delivery' | 'takeaway' | 'all' | undefined,
  sucursalIdParam: string | undefined,
  estado: string | undefined,
  opts?: { excludeArchived?: boolean },
) {
  const restaurante = await db
    .select({
      metodosPagoConfig: RestauranteTable.metodosPagoConfig,
      cardsPaymentsEnabled: RestauranteTable.cardsPaymentsEnabled,
      mpConnected: RestauranteTable.mpConnected,
      mpPublicKey: RestauranteTable.mpPublicKey,
      cucuruConfigurado: RestauranteTable.cucuruConfigurado,
      cucuruEnabled: RestauranteTable.cucuruEnabled,
      proveedorPago: RestauranteTable.proveedorPago,
      taloClientId: RestauranteTable.taloClientId,
      taloClientSecret: RestauranteTable.taloClientSecret,
      taloUserId: RestauranteTable.taloUserId,
      transferenciaAlias: RestauranteTable.transferenciaAlias,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  let whereCondition: any = eq(PedidoUnificadoTable.restauranteId, restauranteId)
  if (tipo && tipo !== 'all') {
    whereCondition = and(whereCondition, eq(PedidoUnificadoTable.tipo, tipo))
  }
  if (
    restaurante.length > 0 &&
    restauranteOcultaPedidosNoPagados(resolveMetodosPagoConfig(rowToPagoRow(restaurante[0])))
  ) {
    const pagoRow = rowToPagoRow(restaurante[0])
    const metodosPublicosIds = buildMetodosPublicosList(pagoRow).map((o) => o.id)
    const esperandoWebhook = and(
      eq(PedidoUnificadoTable.pagado, false),
      inArray(PedidoUnificadoTable.metodoPago, [...METODOS_PAGO_AUTOMATICOS_EN_PEDIDO]),
    )
    const impagoManualNoOfrecido = and(
      eq(PedidoUnificadoTable.pagado, false),
      inArray(PedidoUnificadoTable.metodoPago, [...METODOS_PAGO_MANUAL_VERIFICABLE_EN_PEDIDO]),
      metodosPublicosIds.length === 0
        ? sql`TRUE`
        : notInArray(PedidoUnificadoTable.metodoPago, metodosPublicosIds),
    )
    const ofreceManualEnLinkPublico =
      metodosPublicosIds.length > 0 &&
      metodosPublicosIds.some((id) => (METODOS_PAGO_MANUAL_VERIFICABLE_EN_PEDIDO as readonly string[]).includes(id))
    const metodoAusenteSinCobrarEnMostrador = sql`(
      ${PedidoUnificadoTable.metodoPago} IS NULL
      OR TRIM(COALESCE(${PedidoUnificadoTable.metodoPago}, '')) = ''
    )`
    const impagoAmbiguoViejoConSoloMediosElectronicos =
      metodosPublicosIds.length === 0 || !ofreceManualEnLinkPublico
        ? and(eq(PedidoUnificadoTable.pagado, false), metodoAusenteSinCobrarEnMostrador)
        : sql`FALSE`
    const ocultarPedidoImpagoOperaciones = or(
      esperandoWebhook,
      impagoManualNoOfrecido,
      impagoAmbiguoViejoConSoloMediosElectronicos,
    )
    whereCondition = and(
      whereCondition,
      or(eq(PedidoUnificadoTable.pagado, true), not(ocultarPedidoImpagoOperaciones ?? sql`FALSE`)),
    )
  }
  if (estado) {
    whereCondition = and(whereCondition, eq(PedidoUnificadoTable.estado, estado as any))
  }
  if (opts?.excludeArchived) {
    whereCondition = and(whereCondition, notInArray(PedidoUnificadoTable.estado, ['archived']))
  }
  if (sucursalIdParam !== undefined && sucursalIdParam !== '') {
    const sid = Number(sucursalIdParam)
    if (!Number.isNaN(sid) && sid > 0) {
      whereCondition = and(whereCondition, eq(PedidoUnificadoTable.sucursalId, sid))
    }
  }
  return whereCondition
}

export async function selectPedidosEnriquecidos(
  db: Db,
  whereCondition: any,
  opts?: { limit?: number; offset?: number },
) {
  let q: any = db
    .select(PEDIDO_LIST_PROJECTION)
    .from(PedidoUnificadoTable)
    .leftJoin(CodigoDescuentoTable, eq(PedidoUnificadoTable.codigoDescuentoId, CodigoDescuentoTable.id))
    .leftJoin(SucursalTable, eq(PedidoUnificadoTable.sucursalId, SucursalTable.id))
    .leftJoin(RepartidorTable, eq(PedidoUnificadoTable.repartidorId, RepartidorTable.id))
    .where(whereCondition)
    .orderBy(desc(PedidoUnificadoTable.createdAt))
  if (opts?.limit != null) q = q.limit(opts.limit)
  if (opts?.offset != null) q = q.offset(opts.offset)
  const pedidos = await q

  return Promise.all(
    pedidos.map(async (pedido: any) => {
      const itemsRaw = await db
        .select({
          id: ItemPedidoUnificadoTable.id,
          productoId: ItemPedidoUnificadoTable.productoId,
          varianteId: ItemPedidoUnificadoTable.varianteId,
          varianteNombre: ItemPedidoUnificadoTable.varianteNombre,
          cantidad: ItemPedidoUnificadoTable.cantidad,
          precioUnitario: ItemPedidoUnificadoTable.precioUnitario,
          nombreProducto: ProductoTable.nombre,
          imagenUrl: ProductoTable.imagenUrl,
          ingredientesExcluidos: ItemPedidoUnificadoTable.ingredientesExcluidos,
          agregados: ItemPedidoUnificadoTable.agregados,
          clienteNombre: ItemPedidoUnificadoTable.clienteNombre,
        })
        .from(ItemPedidoUnificadoTable)
        .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
        .where(eq(ItemPedidoUnificadoTable.pedidoId, pedido.id))
      const items = await enrichItemsWithProductInfo(db, itemsRaw)
      return { ...pedido, items, totalItems: items.reduce((s: number, i: any) => s + (i.cantidad || 1), 0) }
    })
  )
}

export async function buildPedidoListRow(db: Db, pedidoId: number) {
  const rows = await selectPedidosEnriquecidos(db, eq(PedidoUnificadoTable.id, pedidoId), { limit: 1 })
  return rows[0] ?? null
}

/**
 * Contexto histórico del cliente detrás de un pedido: cuántas veces pidió, cuánto gastó
 * en total y cuándo fue la última vez. Es el dato que ninguna app de terceros le da al local.
 * Identifica al cliente por teléfono (últimos 8 dígitos, tolerante a formatos) y, si no hay
 * teléfono, cae al nombre exacto (útil para takeaways anotados a mano). Best-effort: null si
 * no hay con qué identificarlo. No cuenta pedidos cancelados.
 */
export async function buildClienteContexto(
  db: Db,
  restauranteId: number,
  pedido: { id: number; telefono: string | null; nombreCliente: string | null; createdAt: Date | string | null },
) {
  const digits = (s: string | null | undefined) => (s ? String(s).replace(/\D/g, '') : '')
  const tel = digits(pedido.telefono)
  const nombre = (pedido.nombreCliente || '').trim()

  let matchCond: any
  let matchedBy: 'telefono' | 'nombre'
  if (tel.length >= 6) {
    const tail = tel.slice(-8)
    matchCond = sql`RIGHT(REGEXP_REPLACE(COALESCE(${PedidoUnificadoTable.telefono}, ''), '[^0-9]', ''), 8) = ${tail}`
    matchedBy = 'telefono'
  } else if (nombre.length >= 2) {
    matchCond = sql`LOWER(TRIM(COALESCE(${PedidoUnificadoTable.nombreCliente}, ''))) = ${nombre.toLowerCase()}`
    matchedBy = 'nombre'
  } else {
    return null
  }

  const rows = await db
    .select({
      id: PedidoUnificadoTable.id,
      total: PedidoUnificadoTable.total,
      createdAt: PedidoUnificadoTable.createdAt,
    })
    .from(PedidoUnificadoTable)
    .where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId),
      notInArray(PedidoUnificadoTable.estado, ['cancelled']),
      matchCond,
    ))

  if (rows.length === 0) return null

  const toTime = (d: any) => new Date(d).getTime()
  const sorted = [...rows].sort((a, b) => {
    const ta = toTime(a.createdAt)
    const tb = toTime(b.createdAt)
    return ta !== tb ? ta - tb : a.id - b.id
  })

  const idx = sorted.findIndex((r) => r.id === pedido.id)
  const pedidoNumero = idx >= 0 ? idx + 1 : sorted.length
  const totalPedidos = rows.length
  const totalHistorico = Math.round(rows.reduce((s, r) => s + (parseFloat(String(r.total)) || 0), 0))

  // Última vez = el pedido inmediatamente anterior a este del mismo cliente.
  let ultimaVezAt: string | null = null
  if (idx > 0) {
    ultimaVezAt = new Date(sorted[idx - 1].createdAt as any).toISOString()
  } else if (idx < 0) {
    const prev = sorted.filter((r) => r.id !== pedido.id).pop()
    ultimaVezAt = prev ? new Date(prev.createdAt as any).toISOString() : null
  }

  // El nivel refleja el "standing" del cliente en el momento de ESTE pedido.
  const nivel: 'nuevo' | 'recurrente' | 'frecuente' =
    pedidoNumero <= 1 ? 'nuevo' : pedidoNumero === 2 ? 'recurrente' : 'frecuente'

  return {
    identificado: true,
    matchedBy,
    nombre: nombre || null,
    totalPedidos,
    pedidoNumero,
    totalHistorico,
    ultimaVezAt,
    primeraVez: pedidoNumero <= 1,
    nivel,
  }
}

export type ReasonEventoPedido = 'created' | 'paid' | 'estado' | 'updated' | 'deleted'

/**
 * Emite el evento granular al admin: ADMIN_UPDATE (retrocompat) + ADMIN_ORDER_EVENT (board incremental).
 * Para 'upsert' adjunta la fila enriquecida (lista para imprimir). Best-effort: nunca rompe el request.
 */
export async function emitirEventoPedido(
  db: Db,
  opts: {
    restauranteId: number
    pedidoId: number
    tipo: 'delivery' | 'takeaway'
    sucursalId?: number | null
    event: 'upsert' | 'remove'
    reason: ReasonEventoPedido
    shouldPrint?: boolean
  },
) {
  const { restauranteId, pedidoId, tipo, sucursalId, event, reason, shouldPrint } = opts
  try {
    wsManager.broadcastAdminUpdate(restauranteId, tipo, { sucursalId: sucursalId ?? null }) // retrocompat
    let pedido: any = undefined
    if (event === 'upsert') {
      pedido = await buildPedidoListRow(db, pedidoId)
    }
    wsManager.broadcastAdminOrderEvent(restauranteId, {
      event, reason, tipo, pedidoId,
      sucursalId: sucursalId ?? null,
      shouldPrint: !!shouldPrint,
      pedido,
    })
  } catch (e) {
    console.error('Error emitiendo evento de pedido:', e)
  }
}
