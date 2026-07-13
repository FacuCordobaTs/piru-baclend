// pedido-unificado.ts - Gestión unificada de pedidos delivery y takeaway
import { Hono } from 'hono'
import { pool } from '../db'
import {
  pedidoUnificado as PedidoUnificadoTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  producto as ProductoTable,
  ingrediente as IngredienteTable,
  restaurante as RestauranteTable,
  codigoDescuento as CodigoDescuentoTable,
  mensajeWhatsapp as MensajeWhatsappTable,
  whatsappConversacion as WhatsappConversacionTable,
  varianteProducto as VarianteProductoTable,
  sucursal as SucursalTable,
  repartidor as RepartidorTable,
} from '../db/schema'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, desc, and, or, not, inArray, notInArray, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { wsManager } from '../websocket/manager'
import { sendClientOrderDispatchedWhatsApp, sendClientPaymentConfirmedWhatsApp, sendOrderWhatsApp } from '../services/whatsapp'
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
} from '../lib/pedidos-activos'

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

const createSchema = z.discriminatedUnion('tipo', [createDeliverySchema, createTakeawaySchema])

const updateEstadoSchema = z.object({
  estado: z.enum(['pending', 'preparing', 'ready', 'dispatched', 'delivered', 'cancelled', 'archived']),
})

const pedidoUnificadoRoute = new Hono()
  .use('*', authMiddleware)

  // Listar pedidos (tipo=delivery|takeaway|all)
  .get('/list', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const page = Number(c.req.query('page')) || 1
    const limit = Number(c.req.query('limit')) || 20
    const estado = c.req.query('estado')
    const tipo = c.req.query('tipo') as 'delivery' | 'takeaway' | 'all' | undefined
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

  // Obtener pedidos activos (hidratación inicial) — DEBE ir antes de /:id
  .get('/activos', async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number((c as any).user?.id)
    if (!Number.isInteger(restauranteId)) {
      return c.json({ success: false, message: 'No autenticado' }, 401)
    }
    const tipo = c.req.query('tipo') as 'delivery' | 'takeaway' | 'all' | undefined
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
      },
    }, 200)
  })

  // Crear pedido (delivery o takeaway)
  .post('/create', zValidator('json', createSchema), async (c) => {
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
    // En el POS del local el pedido se crea ya pagado por defecto
    const pagado = body.pagado != null ? body.pagado === true : anotadoManualmente
    const metodoPago = body.metodoPago && String(body.metodoPago).trim() !== '' ? String(body.metodoPago) : null

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
    }

    if (body.tipo === 'delivery') {
      baseValues.direccion = body.direccion
      baseValues.latitud = body.latitud != null ? String(body.latitud) : null
      baseValues.longitud = body.longitud != null ? String(body.longitud) : null
      baseValues.deliveryFee = deliveryFee.toFixed(2)
    }

    const nuevoPedido = await db.insert(PedidoUnificadoTable).values(baseValues)
    const pedidoId = Number(nuevoPedido[0].insertId)

    for (const item of items) {
      await db.insert(ItemPedidoUnificadoTable).values({
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
          const creds = rest?.whatsappPhoneId && rest?.whatsappAccessToken
            ? { phoneId: rest.whatsappPhoneId, token: rest.whatsappAccessToken }
            : undefined
          const itemsForWa = items.map((it) => ({
            name: productosMap.get(it.productoId)!.nombre,
            quantity: it.cantidad,
          }))
          console.log('⏳ [Onboarding] Enviando pedido de prueba al WhatsApp del dueño:', phone)
          await sendOrderWhatsApp(c, {
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

  // Asignar Rapiboy (solo delivery)
  .post('/rapiboy/asignar', zValidator('json', z.object({ pedidoId: z.number() })), async (c) => {
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

  // Notificar al cliente por WhatsApp (pedido listo)
  .post('/:id/notificar-cliente', async (c) => {
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
    }

    if (dispatchMessage === '') {
      console.log(`📲 [Notificar Cliente] ❌ Tipo de pedido desconocido: ${pedido.tipo}`)
      return c.json({ message: 'No se pudo determinar el mensaje', success: false }, 400)
    }

    try {
      const restCreds = restaurante?.whatsappPhoneId && restaurante?.whatsappAccessToken
        ? { phoneId: restaurante.whatsappPhoneId, token: restaurante.whatsappAccessToken }
        : undefined

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

  // Asignar repartidor al pedido
  .put('/:id/repartidor', async (c) => {
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

  // Confirmar pedido con demora (modo confirmación manual)
  .post('/:id/confirmar-con-demora', zValidator('json', z.object({ demoraMinutos: z.number().int().min(0).max(999) })), async (c) => {
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

    try {
      const restCreds = restaurante?.whatsappPhoneId && restaurante?.whatsappAccessToken
        ? { phoneId: restaurante.whatsappPhoneId, token: restaurante.whatsappAccessToken }
        : undefined

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
  .put('/:id/impreso', async (c) => {
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
