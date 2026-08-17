// pedido-unificado.ts - Gestión unificada de pedidos delivery, takeaway y mesa
import { Hono, type Context, type Next } from 'hono'
import { pool } from '../db'
import {
  pedidoUnificado as PedidoUnificadoTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  producto as ProductoTable,
  ingrediente as IngredienteTable,
  agregado as AgregadoTable,
  productoIngrediente as ProductoIngredienteTable,
  productoAgregado as ProductoAgregadoTable,
  pedidoUnificadoAuditoria as PedidoUnificadoAuditoriaTable,
  restaurante as RestauranteTable,
  codigoDescuento as CodigoDescuentoTable,
  mensajeWhatsapp as MensajeWhatsappTable,
  whatsappConversacion as WhatsappConversacionTable,
  varianteProducto as VarianteProductoTable,
  sucursal as SucursalTable,
  repartidor as RepartidorTable,
  mesaLocal as MesaLocalTable,
} from '../db/schema'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, desc, and, or, not, inArray, notInArray, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { wsManager } from '../websocket/manager'
import { sendClientOrderDispatchedWhatsApp, sendClientPaymentConfirmedWhatsApp, sendOrderWhatsApp, resolverCredsRestaurante } from '../services/whatsapp'
import {
  rowToPagoRow,
  restauranteOcultaPedidosNoPagados,
  resolveMetodosPagoConfig,
  buildMetodosPublicosList,
  METODOS_PAGO_AUTOMATICOS_EN_PEDIDO,
  METODOS_PAGO_MANUAL_VERIFICABLE_EN_PEDIDO,
} from '../lib/metodos-pago'
import {
  emitirEventoPedido,
  buildPedidosWhere,
  selectPedidosEnriquecidos,
  enrichItemsWithProductInfo,
  buildClienteContexto,
} from '../lib/pedidos-activos'
import { requireModulo } from '../middleware/modulo'
import { MODULE_KEYS } from '../lib/modulos'
import { consumirMensaje, estadoEnvioUtility, avisarSaldoBajoSiCorresponde } from '../lib/mensajes-wallet'
import { asegurarOwnerStaff } from '../lib/staff'

const itemSchema = z.object({
  productoId: z.number().int().positive(),
  varianteId: z.number().int().positive().optional(),
  cantidad: z.number().int().positive().default(1),
  ingredientesExcluidos: z.array(z.number().int().positive()).optional(),
  agregados: z.array(z.object({
    id: z.number().int(),
    nombre: z.string(),
    precio: z.union([z.string(), z.number()]),
  })).optional(),
})

// Campos comunes para pedidos anotados manualmente desde el POS del local
const manualFields = {
  // Si viene true, el pedido se marca como anotado manualmente (POS) y por defecto pagado en el local
  anotadoManualmente: z.boolean().optional(),
  pagado: z.boolean().optional(),
  metodoPago: z.string().optional(),
  sucursalId: z.number().int().positive().optional(),
  // `consumoEnLocal` se conserva como campo aditivo para clientes anteriores.
  mesaLocalId: z.number().int().positive().optional(),
  consumoEnLocal: z.boolean().optional(),
  // Onboarding: si viene true, además de crear el pedido se envía al WhatsApp del dueño
  // para que vea cómo le llega un pedido real (pedido de prueba). Aditivo/retrocompatible.
  notificarWhatsappPrueba: z.boolean().optional(),
}

const createDeliverySchema = z.object({
  tipo: z.literal('delivery'),
  direccion: z.string().min(5, 'La dirección es requerida'),
  nombreCliente: z.string().optional(),
  telefono: z.string().optional(),
  notas: z.string().optional(),
  latitud: z.union([z.string(), z.number()]).optional(),
  longitud: z.union([z.string(), z.number()]).optional(),
  deliveryFee: z.union([z.string(), z.number()]).optional(),
  ...manualFields,
  items: z.array(itemSchema).min(1, 'Debe agregar al menos un producto'),
})

const createTakeawaySchema = z.object({
  tipo: z.literal('takeaway'),
  nombreCliente: z.string().optional(),
  telefono: z.string().optional(),
  notas: z.string().optional(),
  ...manualFields,
  items: z.array(itemSchema).min(1, 'Debe agregar al menos un producto'),
})

const createMesaSchema = z.object({
  tipo: z.literal('mesa'),
  mesaLocalId: z.number().int().positive(),
  consumoEnLocal: z.literal(true).optional().default(true),
  nombreCliente: z.string().optional(),
  telefono: z.string().optional(),
  notas: z.string().optional(),
  anotadoManualmente: z.boolean().optional(),
  pagado: z.boolean().optional(),
  metodoPago: z.string().optional(),
  sucursalId: z.number().int().positive().optional(),
  notificarWhatsappPrueba: z.boolean().optional(),
  items: z.array(itemSchema).min(1, 'Debe agregar al menos un producto'),
})

const createSchema = z.discriminatedUnion('tipo', [createDeliverySchema, createTakeawaySchema, createMesaSchema])
type CreatePedidoInput = z.infer<typeof createSchema>

const updateEstadoSchema = z.object({
  estado: z.enum(['pending', 'preparing', 'ready', 'dispatched', 'delivered', 'cancelled', 'archived']),
})

const posItemSchema = z.object({
  productoId: z.number().int().positive(),
  varianteId: z.number().int().positive().nullable().optional(),
  cantidad: z.number().int().positive(),
  ingredientesExcluidos: z.array(z.number().int().positive()).default([]),
  // Sólo el id del agregado es confiable; nombre y precio se resuelven en servidor.
  agregados: z.array(z.object({ id: z.number().int().positive() })).default([]),
  version: z.number().int().positive(),
})

const deletePosItemSchema = z.object({ version: z.number().int().positive() })
const datosPosSchema = z.object({
  nombreCliente: z.string().trim().max(255).nullable().optional(),
  telefono: z.string().trim().max(50).nullable().optional(),
  notas: z.string().trim().max(500).nullable().optional(),
  tipo: z.enum(['delivery', 'takeaway']).optional(),
  direccion: z.string().trim().max(255).nullable().optional(),
  latitud: z.union([z.string(), z.number()]).nullable().optional(),
  longitud: z.union([z.string(), z.number()]).nullable().optional(),
  deliveryFee: z.union([z.string(), z.number()]).nullable().optional(),
  metodoPago: z.string().trim().max(64).nullable().optional(),
  pagado: z.boolean().optional(),
  version: z.number().int().positive(),
})

const POS_ESTADOS_EDITABLES = ['pending', 'received', 'preparing'] as const
const ESTADOS_PEDIDO_CERRADOS = ['archived', 'cancelled', 'delivered'] as const

/**
 * Serializa las altas por mesa bloqueando primero la propia mesa. MySQL no
 * ofrece índices únicos parciales, por lo que el lock de esa fila es la
 * exclusión mutua que evita que dos POS creen pedidos abiertos a la vez.
 */
export async function reservarMesaLocal(tx: any, restauranteId: number, mesaLocalId: number, sucursalId: number | null | undefined) {
  await tx.execute(sql`SELECT id FROM mesa_local WHERE id = ${mesaLocalId} AND restaurante_id = ${restauranteId} FOR UPDATE`)
  const [mesa] = await tx.select({ id: MesaLocalTable.id, sucursalId: MesaLocalTable.sucursalId, activo: MesaLocalTable.activo })
    .from(MesaLocalTable)
    .where(and(eq(MesaLocalTable.id, mesaLocalId), eq(MesaLocalTable.restauranteId, restauranteId)))
    .limit(1)
  if (!mesa || !mesa.activo) return { error: 'MESA_NO_DISPONIBLE' as const, message: 'La mesa seleccionada no está disponible' }
  if (mesa.sucursalId != null && sucursalId != null && mesa.sucursalId !== sucursalId) {
    return { error: 'MESA_SUCURSAL_INVALIDA' as const, message: 'La mesa no pertenece a la sucursal seleccionada' }
  }

  const abiertos = await tx.select({ id: PedidoUnificadoTable.id })
    .from(PedidoUnificadoTable)
    .where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId),
      eq(PedidoUnificadoTable.mesaLocalId, mesaLocalId),
      notInArray(PedidoUnificadoTable.estado, [...ESTADOS_PEDIDO_CERRADOS]),
    ))
    .limit(1)
  if (abiertos.length) return { error: 'MESA_OCUPADA' as const, message: 'Esta mesa ya tiene un pedido abierto' }
  return { mesa }
}

/**
 * `/create` es el endpoint autenticado del pedido anotado desde el POS. El
 * único caso que puede usarlo sin el módulo es el pedido de prueba durante el
 * onboarding, antes de que el restaurante entre al panel. No se usa el flag
 * como un bypass general: debe ser el pedido de prueba explícito y el
 * onboarding debe seguir incompleto.
 */
async function requirePosOPruebaOnboarding(c: Context, next: Next) {
  const restauranteId = (c as any).user?.id
  const body = c.req.valid('json') as CreatePedidoInput
  const esPedidoPruebaOnboarding = body.anotadoManualmente === true
    && body.notificarWhatsappPrueba === true

  if (esPedidoPruebaOnboarding && restauranteId) {
    const db = drizzle(pool)
    const [restaurante] = await db
      .select({ completedOnboarding: RestauranteTable.completedOnboarding })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)

    if (restaurante && !restaurante.completedOnboarding) {
      return next()
    }
  }

  return requireModulo(MODULE_KEYS.POS)(c, next)
}

function esMetodoAutomatico(metodo: string | null) {
  return !!metodo && (
    (METODOS_PAGO_AUTOMATICOS_EN_PEDIDO as readonly string[]).includes(metodo) ||
    metodo.startsWith('transferencia_automatica_')
  )
}

/**
 * La identidad de staff es trazabilidad adicional del POS, no un requisito para
 * tomar un pedido. Durante el despliegue escalonado puede existir un backend
 * nuevo contra una base que todavía no recibió `add_staff_restaurante.sql`.
 * En ese caso preservamos el alta del pedido y dejamos la atribución vacía; la
 * migración vuelve a habilitarla automáticamente en las siguientes altas.
 */
function faltaEsquemaStaff(error: unknown) {
  const code = (error as { code?: string } | null)?.code
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR'
}

async function resolverCreadorPos(db: any, restauranteId: number) {
  try {
    return await asegurarOwnerStaff(db, restauranteId)
  } catch (error) {
    if (!faltaEsquemaStaff(error)) throw error
    console.warn(
      `[POS] Alta sin actor de staff para restaurante ${restauranteId}: falta aplicar add_staff_restaurante.sql`,
    )
    return null
  }
}

function motivosPedidoNoEditable(pedido: any): string[] {
  const motivos: string[] = []
  if (!pedido.anotadoManualmente) motivos.push('El pedido no fue creado desde el POS')
  if (!(POS_ESTADOS_EDITABLES as readonly string[]).includes(pedido.estado)) motivos.push('El estado del pedido no permite edición')
  if (pedido.afipFacturado) motivos.push('El pedido ya fue facturado')
  if (pedido.rapiboyTripId) motivos.push('El pedido ya fue enviado a Rapiboy')
  if (pedido.grupal || pedido.creadoPorIa) motivos.push('El pedido pertenece a un flujo no editable desde POS')
  if (esMetodoAutomatico(pedido.metodoPago)) motivos.push('El pedido tiene un cobro automático')
  return motivos
}

export async function resolverItemPos(tx: any, restauranteId: number, input: z.infer<typeof posItemSchema>) {
  const [producto] = await tx.select().from(ProductoTable).where(and(
    eq(ProductoTable.id, input.productoId),
    eq(ProductoTable.restauranteId, restauranteId),
  )).limit(1)
  if (!producto) return { error: 'ITEM_INVALIDO', message: 'El producto no pertenece al restaurante' } as const

  let variante: any = null
  if (input.varianteId) {
    ;[variante] = await tx.select().from(VarianteProductoTable).where(and(
      eq(VarianteProductoTable.id, input.varianteId),
      eq(VarianteProductoTable.productoId, producto.id),
      eq(VarianteProductoTable.activo, true),
    )).limit(1)
    if (!variante) return { error: 'ITEM_INVALIDO', message: 'La variante no pertenece al producto' } as const
  }

  const ingredienteIds = [...new Set(input.ingredientesExcluidos)]
  if (ingredienteIds.length) {
    const validos = await tx.select({ id: IngredienteTable.id }).from(ProductoIngredienteTable)
      .innerJoin(IngredienteTable, eq(ProductoIngredienteTable.ingredienteId, IngredienteTable.id))
      .where(and(eq(ProductoIngredienteTable.productoId, producto.id), eq(IngredienteTable.restauranteId, restauranteId), inArray(IngredienteTable.id, ingredienteIds)))
    if (validos.length !== ingredienteIds.length) return { error: 'ITEM_INVALIDO', message: 'Hay ingredientes inválidos para el producto' } as const
  }

  const agregadoIds = [...new Set(input.agregados.map((a) => a.id))]
  let agregados: Array<{ id: number; nombre: string; precio: string }> = []
  if (agregadoIds.length) {
    const validos = await tx.select({ id: AgregadoTable.id, nombre: AgregadoTable.nombre, precio: AgregadoTable.precio })
      .from(ProductoAgregadoTable)
      .innerJoin(AgregadoTable, eq(ProductoAgregadoTable.agregadoId, AgregadoTable.id))
      .where(and(eq(ProductoAgregadoTable.productoId, producto.id), eq(AgregadoTable.restauranteId, restauranteId), eq(AgregadoTable.activo, true), inArray(AgregadoTable.id, agregadoIds)))
    if (validos.length !== agregadoIds.length) return { error: 'ITEM_INVALIDO', message: 'Hay agregados inválidos para el producto' } as const
    const byId = new Map(validos.map((ag: any) => [ag.id, ag]))
    // Conserva el orden y las repeticiones pedidos por la comanda, pero nunca precio/nombre del cliente.
    agregados = input.agregados.map(({ id }) => byId.get(id)!)
  }

  const precioBase = Number(variante ? variante.precio : producto.precio)
  const precioUnitario = precioBase + agregados.reduce((sum, ag) => sum + Number(ag.precio), 0)
  return {
    productoId: producto.id,
    varianteId: variante?.id ?? null,
    varianteNombre: variante?.nombre ?? null,
    cantidad: input.cantidad,
    precioUnitario: precioUnitario.toFixed(2),
    ingredientesExcluidos: ingredienteIds.length ? ingredienteIds : null,
    agregados: agregados.length ? agregados : null,
  } as const
}

export async function respuestaPedidoEditable(db: any, restauranteId: number, pedidoId: number) {
  const [pedido] = await db.select().from(PedidoUnificadoTable).where(and(
    eq(PedidoUnificadoTable.id, pedidoId), eq(PedidoUnificadoTable.restauranteId, restauranteId),
  )).limit(1)
  if (!pedido) return null
  const itemsRaw = await db.select({
    id: ItemPedidoUnificadoTable.id, productoId: ItemPedidoUnificadoTable.productoId,
    varianteId: ItemPedidoUnificadoTable.varianteId, varianteNombre: ItemPedidoUnificadoTable.varianteNombre,
    cantidad: ItemPedidoUnificadoTable.cantidad, precioUnitario: ItemPedidoUnificadoTable.precioUnitario,
    nombreProducto: ProductoTable.nombre, imagenUrl: ProductoTable.imagenUrl,
    ingredientesExcluidos: ItemPedidoUnificadoTable.ingredientesExcluidos, agregados: ItemPedidoUnificadoTable.agregados,
    clienteNombre: ItemPedidoUnificadoTable.clienteNombre,
  }).from(ItemPedidoUnificadoTable).leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
    .where(eq(ItemPedidoUnificadoTable.pedidoId, pedidoId))
  const items = await enrichItemsWithProductInfo(db, itemsRaw)
  const motivosNoEditable = motivosPedidoNoEditable(pedido)
  return { ...pedido, items, totalItems: items.reduce((sum, item: any) => sum + (item.cantidad || 1), 0), version: pedido.version, editable: motivosNoEditable.length === 0, motivosNoEditable }
}

export async function ejecutarMutacionPos(
  db: any,
  restauranteId: number,
  pedidoId: number,
  version: number,
  mutar: (tx: any, pedido: any, items: any[]) => Promise<{ error?: string; message?: string; operacion?: 'agregar_item' | 'editar_item' | 'eliminar_item' | 'editar_datos_pos'; itemPedidoId?: number | null; antes?: any; despues?: any; reimprimeCocina?: boolean }>,
  actor?: { id: number; tipo: string },
): Promise<any> {
  return db.transaction(async (tx: any) => {
    // Bloquea la comanda completa hasta asentar ítem, total, versión y auditoría.
    await tx.execute(sql`SELECT id FROM pedido_unificado WHERE id = ${pedidoId} AND restaurante_id = ${restauranteId} FOR UPDATE`)
    const [pedido] = await tx.select().from(PedidoUnificadoTable).where(and(
      eq(PedidoUnificadoTable.id, pedidoId), eq(PedidoUnificadoTable.restauranteId, restauranteId),
    )).limit(1)
    if (!pedido) return { error: 'NOT_FOUND' as const }
    const motivos = motivosPedidoNoEditable(pedido)
    if (motivos.length) return { error: 'PEDIDO_NO_EDITABLE' as const, message: motivos[0] }
    if (pedido.version !== version) return { error: 'VERSION_CONFLICT' as const }
    // T37: las mutaciones que llegan desde el admin del dueño se atribuyen a
    // su identidad owner. T38 inyecta el staff ya autenticado, sin aceptar un
    // actor elegido por el cliente.
    const actorAuditoria = actor ?? { id: (await asegurarOwnerStaff(tx, restauranteId)).id, tipo: 'restaurante_admin' }

    const items = await tx.select().from(ItemPedidoUnificadoTable).where(eq(ItemPedidoUnificadoTable.pedidoId, pedidoId))
    const cambio = await mutar(tx, pedido, items)
    if (cambio.error) return cambio

    const [pedidoActual] = await tx.select().from(PedidoUnificadoTable).where(eq(PedidoUnificadoTable.id, pedidoId)).limit(1)
    const itemsFinales = await tx.select().from(ItemPedidoUnificadoTable).where(eq(ItemPedidoUnificadoTable.pedidoId, pedidoId))
    const subtotal = itemsFinales.reduce((sum: number, item: any) => sum + Number(item.precioUnitario) * item.cantidad, 0)
    const total = subtotal + Number(pedidoActual.deliveryFee || 0) - Number(pedidoActual.montoDescuento || 0)
    const shouldPrint = !!cambio.reimprimeCocina && pedido.impreso
    await tx.update(PedidoUnificadoTable).set({
      total: total.toFixed(2),
      version: sql`${PedidoUnificadoTable.version} + 1`,
      updatedAt: new Date(),
      ...(shouldPrint ? { impreso: false } : {}),
    }).where(eq(PedidoUnificadoTable.id, pedidoId))
    await tx.insert(PedidoUnificadoAuditoriaTable).values({
      pedidoId, restauranteId, itemPedidoId: cambio.itemPedidoId ?? null,
      usuarioRestauranteId: actorAuditoria.id, operacion: cambio.operacion!, actorTipo: actorAuditoria.tipo, antes: cambio.antes ?? null, despues: cambio.despues ?? null,
    })
    return { pedido, shouldPrint }
  })
}

async function responderErrorMutacion(c: any, db: any, restauranteId: number, pedidoId: number, resultado: any) {
  if (resultado.error === 'NOT_FOUND') return c.json({ success: false, message: 'Pedido no encontrado' }, 404)
  const pedido = await respuestaPedidoEditable(db, restauranteId, pedidoId)
  const code = resultado.error || 'ITEM_INVALIDO'
  const status = code === 'VERSION_CONFLICT' || code === 'PEDIDO_NO_EDITABLE' ? 409 : 422
  return c.json({ success: false, code, message: resultado.message || 'No se pudo editar el pedido', data: { pedido } }, status)
}

const pedidoUnificadoRoute = new Hono()
  .use('*', authMiddleware)

  // Listar pedidos (tipo=delivery|takeaway|mesa|all)
  .get('/list', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const page = Number(c.req.query('page')) || 1
    const limit = Number(c.req.query('limit')) || 20
    const estado = c.req.query('estado')
    const tipo = c.req.query('tipo') as 'delivery' | 'takeaway' | 'mesa' | 'all' | undefined
    const offset = (page - 1) * limit
    const sucursalIdParam = c.req.query('sucursalId')

    const whereCondition = await buildPedidosWhere(db, restauranteId, tipo, sucursalIdParam, estado)
    const pedidosConItems = await selectPedidosEnriquecidos(db, whereCondition, { limit, offset })

    return c.json({
      message: 'Pedidos encontrados',
      success: true,
      data: pedidosConItems,
      pagination: { page, limit, hasMore: pedidosConItems.length === limit },
    }, 200)
  })

  // Listar pedidos de un solo día (día calendario AR, por defecto hoy).
  // Endpoint nuevo aparte de /list para no romper apps no actualizadas.
  // Mismos datos y forma que /list; agrega el filtro `dia` (YYYY-MM-DD).
  .get('/list-dia', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const page = Number(c.req.query('page')) || 1
    const limit = Number(c.req.query('limit')) || 50
    const estado = c.req.query('estado')
    const tipo = c.req.query('tipo') as 'delivery' | 'takeaway' | 'mesa' | 'all' | undefined
    const offset = (page - 1) * limit
    const sucursalIdParam = c.req.query('sucursalId')

    const diaParam = c.req.query('dia')
    const dia = diaParam && /^\d{4}-\d{2}-\d{2}$/.test(diaParam)
      ? diaParam
      : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })

    const whereCondition = await buildPedidosWhere(db, restauranteId, tipo, sucursalIdParam, estado, { dia })
    const pedidosConItems = await selectPedidosEnriquecidos(db, whereCondition, { limit, offset })

    return c.json({
      message: 'Pedidos del día encontrados',
      success: true,
      data: pedidosConItems,
      dia,
      pagination: { page, limit, hasMore: pedidosConItems.length === limit },
    }, 200)
  })

  // Obtener pedidos activos (hidratación inicial) — DEBE ir antes de /:id
  .get('/activos', async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number((c as any).user?.id)
    if (!Number.isInteger(restauranteId)) {
      return c.json({ success: false, message: 'No autenticado' }, 401)
    }
    const tipo = c.req.query('tipo') as 'delivery' | 'takeaway' | 'mesa' | 'all' | undefined
    const sucursalIdParam = c.req.query('sucursalId')

    const whereCondition = await buildPedidosWhere(db, restauranteId, tipo, sucursalIdParam, undefined, { excludeArchived: true })
    const pedidos = await selectPedidosEnriquecidos(db, whereCondition, { limit: 100 })

    return c.json({
      message: 'Pedidos activos recuperados',
      success: true,
      data: pedidos,
    }, 200)
  })

  // Obtener un pedido por ID
  .get('/:id', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))

    const pedido = await db
      .select()
      .from(PedidoUnificadoTable)
      .where(and(
        eq(PedidoUnificadoTable.id, pedidoId),
        eq(PedidoUnificadoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

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
      .where(eq(ItemPedidoUnificadoTable.pedidoId, pedidoId))

    const items = await enrichItemsWithProductInfo(db, itemsRaw)

    let sucursalNombre: string | null = null
    if (pedido[0].sucursalId) {
      const suc = await db
        .select({ nombre: SucursalTable.nombre })
        .from(SucursalTable)
        .where(eq(SucursalTable.id, pedido[0].sucursalId))
        .limit(1)
      sucursalNombre = suc[0]?.nombre ?? null
    }

    return c.json({
      message: 'Pedido encontrado',
      success: true,
      data: {
        ...pedido[0],
        sucursalNombre,
        items,
        totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0),
        version: pedido[0].version,
        editable: motivosPedidoNoEditable(pedido[0]).length === 0,
        motivosNoEditable: motivosPedidoNoEditable(pedido[0]),
      },
    }, 200)
  })

  // Contexto histórico del cliente detrás del pedido (quién es, cuánto pidió, última vez)
  .get('/:id/cliente-contexto', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))

    const [pedido] = await db
      .select({
        id: PedidoUnificadoTable.id,
        telefono: PedidoUnificadoTable.telefono,
        nombreCliente: PedidoUnificadoTable.nombreCliente,
        createdAt: PedidoUnificadoTable.createdAt,
      })
      .from(PedidoUnificadoTable)
      .where(and(
        eq(PedidoUnificadoTable.id, pedidoId),
        eq(PedidoUnificadoTable.restauranteId, restauranteId),
      ))
      .limit(1)

    if (!pedido) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    const contexto = await buildClienteContexto(db, restauranteId, pedido)
    return c.json({ message: 'Contexto del cliente', success: true, data: contexto }, 200)
  })

  // Edición transaccional de comandas POS. No modifica los flujos web, sala ni IA.
  .post('/:id/items', requireModulo(MODULE_KEYS.POS), zValidator('json', posItemSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const body = c.req.valid('json')
    const resultado = await ejecutarMutacionPos(db, restauranteId, pedidoId, body.version, async (tx) => {
      const item = await resolverItemPos(tx, restauranteId, body)
      if ('error' in item) return item
      const inserted = await tx.insert(ItemPedidoUnificadoTable).values(item)
      return { operacion: 'agregar_item' as const, itemPedidoId: Number(inserted[0].insertId), despues: item, reimprimeCocina: true }
    })
    if (resultado.error) return responderErrorMutacion(c, db, restauranteId, pedidoId, resultado)
    const data = await respuestaPedidoEditable(db, restauranteId, pedidoId)
    await emitirEventoPedido(db, { restauranteId, pedidoId, tipo: resultado.pedido.tipo, sucursalId: resultado.pedido.sucursalId, event: 'upsert', reason: 'updated', shouldPrint: resultado.shouldPrint })
    return c.json({ success: true, data }, 200)
  })

  .put('/:id/items/:itemId', requireModulo(MODULE_KEYS.POS), zValidator('json', posItemSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const itemId = Number(c.req.param('itemId'))
    const body = c.req.valid('json')
    const resultado = await ejecutarMutacionPos(db, restauranteId, pedidoId, body.version, async (tx, _pedido, items) => {
      const anterior = items.find((item: any) => item.id === itemId)
      if (!anterior) return { error: 'ITEM_NO_ENCONTRADO', message: 'El ítem no pertenece al pedido' }
      const item = await resolverItemPos(tx, restauranteId, body)
      if ('error' in item) return item
      await tx.update(ItemPedidoUnificadoTable).set(item).where(and(eq(ItemPedidoUnificadoTable.id, itemId), eq(ItemPedidoUnificadoTable.pedidoId, pedidoId)))
      return { operacion: 'editar_item' as const, itemPedidoId: itemId, antes: anterior, despues: item, reimprimeCocina: true }
    })
    if (resultado.error) return responderErrorMutacion(c, db, restauranteId, pedidoId, resultado)
    const data = await respuestaPedidoEditable(db, restauranteId, pedidoId)
    await emitirEventoPedido(db, { restauranteId, pedidoId, tipo: resultado.pedido.tipo, sucursalId: resultado.pedido.sucursalId, event: 'upsert', reason: 'updated', shouldPrint: resultado.shouldPrint })
    return c.json({ success: true, data }, 200)
  })

  .delete('/:id/items/:itemId', requireModulo(MODULE_KEYS.POS), zValidator('json', deletePosItemSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const itemId = Number(c.req.param('itemId'))
    const { version } = c.req.valid('json')
    const resultado = await ejecutarMutacionPos(db, restauranteId, pedidoId, version, async (tx, _pedido, items) => {
      const anterior = items.find((item: any) => item.id === itemId)
      if (!anterior) return { error: 'ITEM_NO_ENCONTRADO', message: 'El ítem no pertenece al pedido' }
      if (items.length <= 1) return { error: 'PEDIDO_SIN_ITEMS', message: 'El pedido debe conservar al menos un ítem' }
      await tx.delete(ItemPedidoUnificadoTable).where(and(eq(ItemPedidoUnificadoTable.id, itemId), eq(ItemPedidoUnificadoTable.pedidoId, pedidoId)))
      return { operacion: 'eliminar_item' as const, itemPedidoId: itemId, antes: anterior, reimprimeCocina: true }
    })
    if (resultado.error) return responderErrorMutacion(c, db, restauranteId, pedidoId, resultado)
    const data = await respuestaPedidoEditable(db, restauranteId, pedidoId)
    await emitirEventoPedido(db, { restauranteId, pedidoId, tipo: resultado.pedido.tipo, sucursalId: resultado.pedido.sucursalId, event: 'upsert', reason: 'updated', shouldPrint: resultado.shouldPrint })
    return c.json({ success: true, data }, 200)
  })

  .put('/:id/datos-pos', requireModulo(MODULE_KEYS.POS), zValidator('json', datosPosSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const body = c.req.valid('json')
    const resultado = await ejecutarMutacionPos(db, restauranteId, pedidoId, body.version, async (tx, pedido) => {
      const tipo = body.tipo ?? pedido.tipo
      const direccion = body.direccion !== undefined ? body.direccion : pedido.direccion
      if (tipo === 'delivery' && (!direccion || direccion.trim().length < 5)) return { error: 'ITEM_INVALIDO', message: 'La dirección es requerida para delivery' }
      if (body.metodoPago !== undefined && body.metodoPago !== null && esMetodoAutomatico(body.metodoPago)) return { error: 'ITEM_INVALIDO', message: 'El POS no puede asignar un medio de pago automático' }
      const antes = { nombreCliente: pedido.nombreCliente, telefono: pedido.telefono, notas: pedido.notas, tipo: pedido.tipo, direccion: pedido.direccion, latitud: pedido.latitud, longitud: pedido.longitud, deliveryFee: pedido.deliveryFee, metodoPago: pedido.metodoPago, pagado: pedido.pagado }
      const cambios: any = {}
      for (const campo of ['nombreCliente', 'telefono', 'notas', 'metodoPago'] as const) if (body[campo] !== undefined) cambios[campo] = body[campo] || null
      if (body.pagado !== undefined) cambios.pagado = body.pagado
      if (body.tipo !== undefined) cambios.tipo = tipo
      if (tipo === 'delivery') {
        cambios.direccion = direccion
        if (body.latitud !== undefined) cambios.latitud = body.latitud == null ? null : String(body.latitud)
        if (body.longitud !== undefined) cambios.longitud = body.longitud == null ? null : String(body.longitud)
        if (body.deliveryFee !== undefined) cambios.deliveryFee = (Number(body.deliveryFee) || 0).toFixed(2)
      } else if (body.tipo === 'takeaway') {
        cambios.direccion = null; cambios.latitud = null; cambios.longitud = null; cambios.deliveryFee = null
      }
      await tx.update(PedidoUnificadoTable).set(cambios).where(eq(PedidoUnificadoTable.id, pedidoId))
      return { operacion: 'editar_datos_pos' as const, antes, despues: cambios, reimprimeCocina: body.notas !== undefined && body.notas !== pedido.notas }
    })
    if (resultado.error) return responderErrorMutacion(c, db, restauranteId, pedidoId, resultado)
    const data = await respuestaPedidoEditable(db, restauranteId, pedidoId)
    await emitirEventoPedido(db, { restauranteId, pedidoId, tipo: data!.tipo, sucursalId: data!.sucursalId, event: 'upsert', reason: 'updated', shouldPrint: resultado.shouldPrint })
    return c.json({ success: true, data }, 200)
  })

  // Crear pedido (delivery, takeaway o mesa)
  .post('/create', zValidator('json', createSchema), requirePosOPruebaOnboarding, async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const body = c.req.valid('json')
    const { items } = body

    const uniqueProductosIds = [...new Set(items.map((i) => i.productoId))]
    const productos = await db
      .select()
      .from(ProductoTable)
      .where(and(
        inArray(ProductoTable.id, uniqueProductosIds),
        eq(ProductoTable.restauranteId, restauranteId)
      ))

    if (productos.length !== uniqueProductosIds.length) {
      return c.json({ message: 'Algunos productos no fueron encontrados', success: false }, 400)
    }

    const productosMap = new Map(productos.map((p) => [p.id, p]))

    const uniqueVariantesIds = [...new Set(items.map((i) => i.varianteId).filter(Boolean))] as number[]
    let variantesMap = new Map();
    if (uniqueVariantesIds.length > 0) {
      const variantesRaw = await db.select().from(VarianteProductoTable).where(inArray(VarianteProductoTable.id, uniqueVariantesIds));
      variantesMap = new Map(variantesRaw.map(v => [v.id, v]));
    }

    // precioUnitario incluye los agregados (consistente con el flujo público)
    const computeItemPrecio = (item: typeof items[number]) => {
      const producto = productosMap.get(item.productoId)!
      let precio = parseFloat(producto.precio)
      if (item.varianteId && variantesMap.has(item.varianteId)) {
        precio = parseFloat(variantesMap.get(item.varianteId).precio)
      }
      if (item.agregados?.length) {
        for (const ag of item.agregados) {
          precio += parseFloat(String(ag.precio ?? 0)) || 0
        }
      }
      return precio
    }

    let total = 0
    for (const item of items) {
      total += computeItemPrecio(item) * item.cantidad
    }

    const anotadoManualmente = body.anotadoManualmente === true
    const creadorStaff = anotadoManualmente ? await resolverCreadorPos(db, restauranteId) : null
    // En el POS del local el pedido se crea ya pagado por defecto
    const pagado = body.pagado != null ? body.pagado === true : anotadoManualmente
    const metodoPago = body.metodoPago && String(body.metodoPago).trim() !== '' ? String(body.metodoPago) : null

    if (body.tipo === 'mesa' && body.mesaLocalId == null) {
      return c.json({ message: 'Los pedidos de mesa deben tener una mesa asignada', success: false }, 422)
    }
    if (body.tipo !== 'mesa' && body.mesaLocalId != null) {
      return c.json({ message: 'Sólo los pedidos de tipo mesa pueden tener una mesa asignada', success: false }, 422)
    }

    let deliveryFee = 0
    if (body.tipo === 'delivery' && body.deliveryFee != null) {
      deliveryFee = parseFloat(String(body.deliveryFee)) || 0
      total += deliveryFee
    }

    const baseValues: any = {
      restauranteId,
      tipo: body.tipo,
      estado: 'pending',
      total: total.toFixed(2),
      nombreCliente: body.nombreCliente || null,
      telefono: body.telefono || null,
      notas: body.notas || null,
      anotadoManualmente,
      pagado,
      metodoPago,
      sucursalId: body.sucursalId ?? null,
      mesaLocalId: body.mesaLocalId ?? null,
      consumoEnLocal: body.tipo === 'mesa' || body.consumoEnLocal === true,
      // Omitir la columna cuando la migración de staff todavía no existe. Pasar
      // `null` la incluiría igualmente en el INSERT y rompería el pedido.
      ...(creadorStaff ? { creadoPorUsuarioId: creadorStaff.id } : {}),
    }

    if (body.tipo === 'delivery') {
      baseValues.direccion = body.direccion
      baseValues.latitud = body.latitud != null ? String(body.latitud) : null
      baseValues.longitud = body.longitud != null ? String(body.longitud) : null
      baseValues.deliveryFee = deliveryFee.toFixed(2)
    }

    const creado = await db.transaction(async (tx: any) => {
      if (body.mesaLocalId != null) {
        const reserva = await reservarMesaLocal(tx, restauranteId, body.mesaLocalId, body.sucursalId)
        if ('error' in reserva) return reserva
      }
      const nuevoPedido = await tx.insert(PedidoUnificadoTable).values(baseValues)
      const pedidoId = Number(nuevoPedido[0].insertId)
      for (const item of items) {
        await tx.insert(ItemPedidoUnificadoTable).values({
          pedidoId,
          productoId: item.productoId,
          varianteId: item.varianteId || null,
          varianteNombre: item.varianteId && variantesMap.has(item.varianteId) ? variantesMap.get(item.varianteId).nombre : null,
          cantidad: item.cantidad,
          precioUnitario: computeItemPrecio(item).toFixed(2),
          ingredientesExcluidos: item.ingredientesExcluidos?.length ? item.ingredientesExcluidos : null,
          agregados: item.agregados?.length ? item.agregados : null,
        })
      }
      return { pedidoId }
    })
    if (!('pedidoId' in creado)) {
      const status = creado.error === 'MESA_OCUPADA' ? 409 : 422
      return c.json({ message: creado.message, code: creado.error, success: false }, status)
    }
    const pedidoId = creado.pedidoId

    // Realtime + impresión para otros dispositivos del local
    await emitirEventoPedido(db, {
      restauranteId,
      pedidoId,
      tipo: body.tipo,
      sucursalId: body.sucursalId ?? null,
      event: 'upsert',
      reason: 'created',
      shouldPrint: pagado,
    })

    // ── Onboarding: enviar el pedido de prueba al WhatsApp del dueño ──
    // Solo se dispara con el flag explícito (no afecta al POS ni a otros clientes del backend).
    // Se hace await para que el frontend sepa que el envío ya se intentó antes de festejar.
    if ((body as any).notificarWhatsappPrueba === true) {
      try {
        const [rest] = await db
          .select({
            nombre: RestauranteTable.nombre,
            direccion: RestauranteTable.direccion,
            telefono: RestauranteTable.telefono,
            whatsappNumber: RestauranteTable.whatsappNumber,
            comprobantesWhatsapp: RestauranteTable.comprobantesWhatsapp,
            whatsappPhoneId: RestauranteTable.whatsappPhoneId,
            whatsappAccessToken: RestauranteTable.whatsappAccessToken,
          })
          .from(RestauranteTable)
          .where(eq(RestauranteTable.id, restauranteId))
          .limit(1)

        // El restaurante puede tener hasta 3 números (notificaciones / comprobantes / contacto).
        // Para el pedido de prueba usamos el primero disponible, sanitizado a dígitos.
        const rawPhone = rest?.whatsappNumber || rest?.comprobantesWhatsapp || rest?.telefono || null
        const phone = rawPhone ? String(rawPhone).replace(/\D/g, '') : null

        if (phone) {
          const creds = resolverCredsRestaurante(rest)
          const itemsForWa = items.map((it) => ({
            name: productosMap.get(it.productoId)!.nombre,
            quantity: it.cantidad,
          }))
          console.log('⏳ [Onboarding] Enviando pedido de prueba al WhatsApp del dueño:', phone)
          await sendOrderWhatsApp(c, {
            restauranteId,
            phone,
            customerName: body.nombreCliente || 'Pedido de prueba',
            address: body.tipo === 'delivery' ? (body.direccion || 'Sin dirección') : 'Retiro en el local',
            total: total.toFixed(2),
            items: itemsForWa,
            orderId: pedidoId.toString(),
          }, creds)
        } else {
          console.log('ℹ️ [Onboarding] Pedido de prueba sin WhatsApp: el restaurante no tiene número configurado')
        }
      } catch (err) {
        console.error('❌ [Onboarding] Error enviando WhatsApp de prueba:', err)
      }
    }

    return c.json({
      message: `Pedido de ${body.tipo} creado correctamente`,
      success: true,
      data: {
        id: pedidoId,
        tipo: body.tipo,
        direccion: body.tipo === 'delivery' ? body.direccion : undefined,
        nombreCliente: body.nombreCliente,
        telefono: body.telefono,
        total: total.toFixed(2),
        estado: 'pending',
        anotadoManualmente,
        pagado,
      },
    }, 201)
  })

  // Actualizar estado
  .put('/:id/estado', zValidator('json', updateEstadoSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const { estado } = c.req.valid('json')

    const pedidos = await db
      .select()
      .from(PedidoUnificadoTable)
      .where(and(
        eq(PedidoUnificadoTable.id, pedidoId),
        eq(PedidoUnificadoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedidos || pedidos.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    const pedido = pedidos[0]

    const updateData: any = { estado }
    if (estado === 'delivered') {
      updateData.deliveredAt = new Date()
    }

    await db
      .update(PedidoUnificadoTable)
      .set(updateData)
      .where(eq(PedidoUnificadoTable.id, pedidoId))

    // La mesa se libera por estado cerrado, sin borrar mesa_local_id: el pedido
    // conserva su historial y todos los grids conectados reciben el cambio.
    await emitirEventoPedido(db, {
      restauranteId,
      pedidoId,
      tipo: pedido.tipo,
      sucursalId: pedido.sucursalId,
      event: 'upsert',
      reason: 'updated',
    })

    const tipo = pedido.tipo
    wsManager.notifyPublicClientEstado(tipo, pedidoId, estado)
    if (pedido.telefono) {
      wsManager.notifyTrackingClients(restauranteId, pedido.telefono, pedidoId, tipo, estado)
    }

    console.log(`[estado] pedido=${pedidoId} restaurante=${restauranteId} estado=${estado} t=${Date.now()}`)

    return c.json({ message: 'Estado actualizado correctamente', success: true }, 200)
  })

  // Marcar/desmarcar pagado (admin verifica pago manual → dispara impresión vía cliente)
  .put('/:id/pagado', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))

    const pedido = await db
      .select()
      .from(PedidoUnificadoTable)
      .where(and(
        eq(PedidoUnificadoTable.id, pedidoId),
        eq(PedidoUnificadoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    const body = await c.req.json().catch(() => ({}))
    const explicitPagado = body.pagado
    const newPagado =
      typeof explicitPagado === 'boolean' ? explicitPagado : !pedido[0].pagado
    const metodoPagoStr =
      body.metodoPago != null && body.metodoPago !== ''
        ? String(body.metodoPago)
        : pedido[0].metodoPago

    await db
      .update(PedidoUnificadoTable)
      .set({
        pagado: newPagado,
        metodoPago: newPagado ? metodoPagoStr : null,
      })
      .where(eq(PedidoUnificadoTable.id, pedidoId))

    const tipo = pedido[0].tipo
    const becamePaid = newPagado && !pedido[0].pagado
    if (becamePaid) {
      wsManager.broadcastAdminUpdate(restauranteId, tipo, { sucursalId: pedido[0].sucursalId ?? null })
    }

    return c.json({
      message: newPagado ? 'Pedido marcado como pagado' : 'Pedido marcado como no pagado',
      success: true,
      data: { pagado: newPagado },
    }, 200)
  })

  // Eliminar pedido
  .delete('/:id', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))

    const pedido = await db
      .select()
      .from(PedidoUnificadoTable)
      .where(and(
        eq(PedidoUnificadoTable.id, pedidoId),
        eq(PedidoUnificadoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    await db
      .delete(ItemPedidoUnificadoTable)
      .where(eq(ItemPedidoUnificadoTable.pedidoId, pedidoId))

    // Borrar mensajes de WhatsApp asociados (FK mensaje_whatsapp_ibfk_1)
    await db
      .delete(MensajeWhatsappTable)
      .where(eq(MensajeWhatsappTable.pedidoUnificadoId, pedidoId))

    // Desvincular la conversación de WhatsApp (FK whatsapp_conversacion) sin borrarla
    await db
      .update(WhatsappConversacionTable)
      .set({ pedidoUnificadoId: null })
      .where(eq(WhatsappConversacionTable.pedidoUnificadoId, pedidoId))

    await db
      .delete(PedidoUnificadoTable)
      .where(eq(PedidoUnificadoTable.id, pedidoId))

    return c.json({ message: 'Pedido eliminado correctamente', success: true }, 200)
  })

  // Asignar Rapiboy (solo delivery) — módulo incluido opt-in.
  .post('/rapiboy/asignar', requireModulo(MODULE_KEYS.RAPIBOY), zValidator('json', z.object({ pedidoId: z.number() })), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const { pedidoId } = c.req.valid('json')

    const res = await db
      .select({
        rapiboyToken: RestauranteTable.rapiboyToken,
        direccion: RestauranteTable.direccion,
      })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)

    if (!res || res.length === 0) {
      return c.json({ message: 'Restaurante no encontrado', success: false }, 400)
    }

    const ped = await db
      .select()
      .from(PedidoUnificadoTable)
      .where(and(
        eq(PedidoUnificadoTable.id, pedidoId),
        eq(PedidoUnificadoTable.restauranteId, restauranteId),
        eq(PedidoUnificadoTable.tipo, 'delivery')
      ))
      .limit(1)

    if (!ped || ped.length === 0) {
      return c.json({ message: 'Pedido no encontrado o no es delivery', success: false }, 404)
    }

    const pedido = ped[0]
    let rapiboyToken = res[0].rapiboyToken
    if (pedido.sucursalId) {
      const [scRb] = await db
        .select({ rapiboyToken: SucursalTable.rapiboyToken })
        .from(SucursalTable)
        .where(and(
          eq(SucursalTable.id, pedido.sucursalId),
          eq(SucursalTable.restauranteId, restauranteId),
        ))
        .limit(1)
      if (scRb?.rapiboyToken) {
        rapiboyToken = scRb.rapiboyToken
      }
    }

    if (!rapiboyToken) {
      return c.json({ message: 'Token de Rapiboy no configurado', success: false }, 400)
    }
    const rapiboyPayload = {
      DireccionOrigen: res[0].direccion || 'Dirección no especificada',
      LatitudOrigen: '0.0',
      LongitudOrigen: '0.0',
      DireccionDestino: pedido.direccion || 'Dirección no especificada',
      LatitudDestino: pedido.latitud?.replace(',', '.') || '0.0',
      LongitudDestino: pedido.longitud?.replace(',', '.') || '0.0',
      ReferenciaExterna: pedido.id.toString(),
      ValorDeclarado: pedido.total || '0',
    }

    try {
      const rapiboyRes = await fetch('https://rapiboy.com/v1/Viaje/Post', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Token: rapiboyToken as string,
        },
        body: JSON.stringify(rapiboyPayload),
      })

      const rapiboyData = await rapiboyRes.json().catch(() => null)
      if (!rapiboyRes.ok) {
        console.error('Error de Rapiboy:', rapiboyData)
        return c.json({ message: 'Error en Rapiboy', details: rapiboyData, success: false }, 400)
      }

      const tripId = rapiboyData?.id || rapiboyData?.Id || rapiboyData?.IdViaje || 'asignado'
      await db
        .update(PedidoUnificadoTable)
        .set({ rapiboyTripId: String(tripId).substring(0, 100) })
        .where(eq(PedidoUnificadoTable.id, pedidoId))

      return c.json({ message: 'Viaje asignado exitosamente', success: true, tripId }, 200)
    } catch (error) {
      console.error('Exception calling rapiboy:', error)
      return c.json({ message: 'Error de conexión con Rapiboy', success: false }, 500)
    }
  })

  // Notificar al cliente por WhatsApp (pedido listo) — módulo de Avisos.
  .post('/:id/notificar-cliente', requireModulo(MODULE_KEYS.AVISOS_AUTOMATICOS_WHATSAPP), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))

    console.log(`📲 [Notificar Cliente] Iniciando para pedido #${pedidoId}, restaurante=${restauranteId}`)

    const result = await db
      .select({
        pedido: PedidoUnificadoTable,
        restaurante: RestauranteTable
      })
      .from(PedidoUnificadoTable)
      .leftJoin(RestauranteTable, eq(PedidoUnificadoTable.restauranteId, RestauranteTable.id))
      .where(and(
        eq(PedidoUnificadoTable.id, pedidoId),
        eq(PedidoUnificadoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!result || result.length === 0) {
      console.log(`📲 [Notificar Cliente] Pedido #${pedidoId} no encontrado`)
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    const { pedido, restaurante } = result[0]

    console.log(`📲 [Notificar Cliente] Pedido #${pedidoId}: tipo=${pedido.tipo}, telefono=${pedido.telefono}, notificarWhatsapp=${pedido.notificarWhatsapp}`)
    console.log(`📲 [Notificar Cliente] Restaurante: notificarClientesWhatsapp=${restaurante?.notificarClientesWhatsapp}, nombre=${restaurante?.nombre}`)

    if (!pedido.telefono) {
      console.log(`📲 [Notificar Cliente] ❌ Sin teléfono en pedido #${pedidoId}`)
      return c.json({ message: 'El pedido no tiene teléfono del cliente', success: false }, 400)
    }

    let dispatchMessage = ''
    if (pedido.tipo === 'delivery') {
      dispatchMessage = 'ya está en camino a tu domicilio'
    } else if (pedido.tipo === 'takeaway') {
      dispatchMessage = 'ya está listo en el mostrador para que pases a retirarlo'
    } else if (pedido.tipo === 'mesa') {
      dispatchMessage = 'ya está listo para servir en tu mesa'
    }

    if (dispatchMessage === '') {
      console.log(`📲 [Notificar Cliente] ❌ Tipo de pedido desconocido: ${pedido.tipo}`)
      return c.json({ message: 'No se pudo determinar el mensaje', success: false }, 400)
    }

    // Modo gracia: si el saldo utility superó el techo de deuda, el aviso NO sale por
    // WhatsApp (degradación). El estado del pedido en la web del comensal sigue vivo, así
    // que nadie queda ciego; el local sólo pierde el "toque de marca" que dejó de pagar.
    // Fail-open: si la evaluación falla, se envía igual (la contabilidad nunca corta un aviso).
    try {
      const gate = await estadoEnvioUtility(db, restauranteId)
      if (!gate.permitido) {
        console.log(`📲 [Notificar Cliente] ⛔ Gracia agotada (deuda ${Math.abs(gate.disponible)}/${gate.deudaMaxima}). No se envía WhatsApp; el estado del pedido sigue activo.`)
        return c.json({
          message: 'Te quedaste sin saldo de avisos. Recargá para reactivar los avisos por WhatsApp; tus clientes siguen viendo el estado del pedido.',
          success: false,
          saldoAgotado: true,
        }, 402)
      }
    } catch (e) {
      console.error('⚠️ [Wallet] Error evaluando gracia (despachado), se envía igual:', e)
    }

    // Aviso de saldo bajo al dueño por WhatsApp (plantilla saldo_bajo_v1, link de packs).
    // Se checa en cada envío de un aviso al cliente; best-effort: si falla, el aviso al
    // comensal sigue su curso (un fallo de contabilidad jamás corta un aviso).
    try {
      await avisarSaldoBajoSiCorresponde(db, restauranteId)
    } catch (e) {
      console.error('⚠️ [Wallet] Error evaluando aviso de saldo bajo (despachado):', e)
    }

    try {
      const restCreds = resolverCredsRestaurante(restaurante)

      console.log(`📲 [Notificar Cliente] Enviando WhatsApp a ${pedido.telefono}...`)
      const waResult = await sendClientOrderDispatchedWhatsApp(c, {
        phone: pedido.telefono,
        customerName: pedido.nombreCliente || 'Cliente',
        restaurantName: restaurante?.nombre || 'El local',
        orderStatus: dispatchMessage
      }, restCreds)

      if (waResult.success) {
        console.log(`📲 [Notificar Cliente] ✅ WhatsApp enviado exitosamente a ${pedido.telefono}`)

        // Registrar en historial
        await db.insert(MensajeWhatsappTable).values({
          pedidoUnificadoId: pedidoId,
          restauranteId,
          telefono: pedido.telefono,
          tipo: 'pedido_despachado',
        })

        // Descontar del wallet (utility). Best-effort: un fallo de contabilidad
        // jamás debe impedir que el aviso al comensal ya enviado se dé por bueno.
        try {
          await consumirMensaje(db, restauranteId, {
            categoria: 'utility',
            tipoMensaje: 'pedido_despachado',
            motivo: 'aviso_pedido_despachado',
            pedidoUnificadoId: pedidoId,
          })
        } catch (e) {
          console.error('⚠️ [Wallet] Error descontando mensaje (despachado):', e)
        }

        return c.json({ message: 'Notificación enviada al cliente', success: true }, 200)
      } else {
        console.error(`📲 [Notificar Cliente] ❌ Error API WhatsApp:`, waResult.error)
        return c.json({ message: 'Error al enviar notificación', success: false, error: waResult.error }, 500)
      }
    } catch (error) {
      console.error('📲 [Notificar Cliente] ❌ Error enviando WhatsApp al cliente:', error)
      return c.json({ message: 'Error al enviar notificación', success: false }, 500)
    }
  })

  // Asignar repartidor al pedido — módulo incluido opt-in.
  .put('/:id/repartidor', requireModulo(MODULE_KEYS.GESTION_CADETES), async (c) => {
    const t0 = Date.now()
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({}))
    const repartidorId = body.repartidorId != null ? Number(body.repartidorId) : null

    console.log(`[repartidor] pedido=${pedidoId} repartidor=${repartidorId} restaurante=${restauranteId}`)

    const pedido = await db
      .select({ id: PedidoUnificadoTable.id })
      .from(PedidoUnificadoTable)
      .where(and(
        eq(PedidoUnificadoTable.id, pedidoId),
        eq(PedidoUnificadoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido.length) {
      console.log(`[repartidor] ❌ pedido no encontrado pedido=${pedidoId}`)
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    await db
      .update(PedidoUnificadoTable)
      .set({ repartidorId })
      .where(eq(PedidoUnificadoTable.id, pedidoId))

    console.log(`[repartidor] ✅ ok pedido=${pedidoId} ms=${Date.now() - t0}`)
    return c.json({ message: 'Repartidor asignado correctamente', success: true }, 200)
  })

  // Confirmar pedido con demora (modo confirmación manual) — módulo de Avisos.
  .post('/:id/confirmar-con-demora', requireModulo(MODULE_KEYS.AVISOS_AUTOMATICOS_WHATSAPP), zValidator('json', z.object({ demoraMinutos: z.number().int().min(0).max(999) })), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const { demoraMinutos } = c.req.valid('json')

    const result = await db
      .select({ pedido: PedidoUnificadoTable, restaurante: RestauranteTable })
      .from(PedidoUnificadoTable)
      .leftJoin(RestauranteTable, eq(PedidoUnificadoTable.restauranteId, RestauranteTable.id))
      .where(and(
        eq(PedidoUnificadoTable.id, pedidoId),
        eq(PedidoUnificadoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!result || result.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    const { pedido, restaurante } = result[0]

    await db
      .update(PedidoUnificadoTable)
      .set({ demoraMinutos })
      .where(eq(PedidoUnificadoTable.id, pedidoId))

    if (!pedido.telefono) {
      return c.json({ message: 'Demora guardada (sin teléfono para notificar)', success: true, demoraMinutos }, 200)
    }

    // Modo gracia: superado el techo de deuda utility, el aviso NO sale por WhatsApp. La
    // demora ya quedó guardada arriba, así que devolvemos éxito (el estado del pedido en la
    // web del comensal la refleja igual). Fail-open ante error de evaluación.
    try {
      const gate = await estadoEnvioUtility(db, restauranteId)
      if (!gate.permitido) {
        console.log(`⛔ [Confirmar demora] Gracia agotada (deuda ${Math.abs(gate.disponible)}/${gate.deudaMaxima}). Demora guardada sin aviso por WhatsApp.`)
        return c.json({
          message: 'Demora guardada. El aviso por WhatsApp está pausado por falta de saldo — recargá para reactivarlo.',
          success: true,
          demoraMinutos,
          saldoAgotado: true,
        }, 200)
      }
    } catch (e) {
      console.error('⚠️ [Wallet] Error evaluando gracia (confirmado), se envía igual:', e)
    }

    // Aviso de saldo bajo al dueño por WhatsApp (ver nota en notificar-cliente).
    try {
      await avisarSaldoBajoSiCorresponde(db, restauranteId)
    } catch (e) {
      console.error('⚠️ [Wallet] Error evaluando aviso de saldo bajo (confirmado):', e)
    }

    try {
      const restCreds = resolverCredsRestaurante(restaurante)

      const waResult = await sendClientPaymentConfirmedWhatsApp(c, {
        phone: pedido.telefono,
        customerName: pedido.nombreCliente || 'Cliente',
        restaurantName: restaurante?.nombre || 'El local',
        total: pedido.total,
        orderId: pedidoId.toString(),
        demoraMinutos,
      }, restCreds)

      if (waResult.success) {
        await db.insert(MensajeWhatsappTable).values({
          pedidoUnificadoId: pedidoId,
          restauranteId,
          telefono: pedido.telefono,
          tipo: 'pedido_confirmado',
        })

        // Descontar del wallet (utility). Best-effort (ver nota en notificar-cliente).
        try {
          await consumirMensaje(db, restauranteId, {
            categoria: 'utility',
            tipoMensaje: 'pedido_confirmado',
            motivo: 'aviso_pedido_confirmado',
            pedidoUnificadoId: pedidoId,
          })
        } catch (e) {
          console.error('⚠️ [Wallet] Error descontando mensaje (confirmado):', e)
        }

        return c.json({ message: 'Confirmación con demora enviada al cliente', success: true, demoraMinutos }, 200)
      } else {
        console.error('❌ Error API WhatsApp al confirmar con demora:', waResult.error)
        return c.json({ message: 'Demora guardada pero falló el envío del mensaje', success: true, demoraMinutos, waError: waResult.error }, 200)
      }
    } catch (error) {
      console.error('❌ Error enviando confirmación con demora:', error)
      return c.json({ message: 'Demora guardada pero falló el envío del mensaje', success: true, demoraMinutos }, 200)
    }
  })



  // Claim atómico de impresión
  .put('/:id/impreso', requireModulo(MODULE_KEYS.IMPRESION_COMANDAS), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))

    const result = await db.execute(sql`
      UPDATE ${PedidoUnificadoTable}
      SET impreso = 1
      WHERE id = ${pedidoId} AND restaurante_id = ${restauranteId} AND impreso = 0
    `)

    // Dependiendo del driver MySQL (mysql2), rows affected está en la respuesta
    const affectedRows = (result as any)?.[0]?.affectedRows ?? 0

    if (affectedRows > 0) {
      return c.json({ message: 'Claim de impresión exitoso', success: true, claimed: true }, 200)
    } else {
      return c.json({ message: 'Pedido ya impreso o no encontrado', success: true, claimed: false }, 200)
    }
  })

export { pedidoUnificadoRoute }
