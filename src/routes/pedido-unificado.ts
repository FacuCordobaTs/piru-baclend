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
} from '../db/schema'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, desc, and, inArray } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { wsManager } from '../websocket/manager'
import { sendClientOrderDispatchedWhatsApp } from '../services/whatsapp'
import { rowToPagoRow, restauranteOcultaPedidosNoPagados, resolveMetodosPagoConfig } from '../lib/metodos-pago'

const createDeliverySchema = z.object({
  tipo: z.literal('delivery'),
  direccion: z.string().min(5, 'La dirección es requerida'),
  nombreCliente: z.string().optional(),
  telefono: z.string().optional(),
  notas: z.string().optional(),
  items: z.array(z.object({
    productoId: z.number().int().positive(),
    cantidad: z.number().int().positive().default(1),
    ingredientesExcluidos: z.array(z.number().int().positive()).optional(),
  })).min(1, 'Debe agregar al menos un producto'),
})

const createTakeawaySchema = z.object({
  tipo: z.literal('takeaway'),
  nombreCliente: z.string().optional(),
  telefono: z.string().optional(),
  notas: z.string().optional(),
  items: z.array(z.object({
    productoId: z.number().int().positive(),
    cantidad: z.number().int().positive().default(1),
    ingredientesExcluidos: z.array(z.number().int().positive()).optional(),
  })).min(1, 'Debe agregar al menos un producto'),
})

const createSchema = z.discriminatedUnion('tipo', [createDeliverySchema, createTakeawaySchema])

const updateEstadoSchema = z.object({
  estado: z.enum(['pending', 'preparing', 'ready', 'dispatched', 'delivered', 'cancelled', 'archived']),
})

async function enrichItemsWithProductInfo(db: MySql2Database<Record<string, never>>, itemsRaw: any[]) {
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
          try {
            agregadosParsed = JSON.parse(item.agregados)
          } catch {}
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
      whereCondition = and(whereCondition, eq(PedidoUnificadoTable.pagado, true))
    }
    if (estado) {
      whereCondition = and(whereCondition, eq(PedidoUnificadoTable.estado, estado as any))
    }

    const pedidos = await db
      .select({
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
        codigoDescuentoCodigo: CodigoDescuentoTable.codigo,
      })
      .from(PedidoUnificadoTable)
      .leftJoin(
        CodigoDescuentoTable,
        eq(PedidoUnificadoTable.codigoDescuentoId, CodigoDescuentoTable.id),
      )
      .where(whereCondition)
      .orderBy(desc(PedidoUnificadoTable.createdAt))
      .limit(limit)
      .offset(offset)

    const pedidosConItems = await Promise.all(
      pedidos.map(async (pedido) => {
        const itemsRaw = await db
          .select({
            id: ItemPedidoUnificadoTable.id,
            productoId: ItemPedidoUnificadoTable.productoId,
            cantidad: ItemPedidoUnificadoTable.cantidad,
            precioUnitario: ItemPedidoUnificadoTable.precioUnitario,
            nombreProducto: ProductoTable.nombre,
            imagenUrl: ProductoTable.imagenUrl,
            ingredientesExcluidos: ItemPedidoUnificadoTable.ingredientesExcluidos,
            agregados: ItemPedidoUnificadoTable.agregados,
          })
          .from(ItemPedidoUnificadoTable)
          .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
          .where(eq(ItemPedidoUnificadoTable.pedidoId, pedido.id))

        const items = await enrichItemsWithProductInfo(db, itemsRaw)
        return {
          ...pedido,
          items,
          totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0),
        }
      })
    )

    return c.json({
      message: 'Pedidos encontrados',
      success: true,
      data: pedidosConItems,
      pagination: { page, limit, hasMore: pedidos.length === limit },
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
        cantidad: ItemPedidoUnificadoTable.cantidad,
        precioUnitario: ItemPedidoUnificadoTable.precioUnitario,
        nombreProducto: ProductoTable.nombre,
        imagenUrl: ProductoTable.imagenUrl,
        ingredientesExcluidos: ItemPedidoUnificadoTable.ingredientesExcluidos,
        agregados: ItemPedidoUnificadoTable.agregados,
      })
      .from(ItemPedidoUnificadoTable)
      .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
      .where(eq(ItemPedidoUnificadoTable.pedidoId, pedidoId))

    const items = await enrichItemsWithProductInfo(db, itemsRaw)

    return c.json({
      message: 'Pedido encontrado',
      success: true,
      data: {
        ...pedido[0],
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
    let total = 0
    for (const item of items) {
      const producto = productosMap.get(item.productoId)!
      total += parseFloat(producto.precio) * item.cantidad
    }

    const baseValues: any = {
      restauranteId,
      tipo: body.tipo,
      estado: 'pending',
      total: total.toFixed(2),
      nombreCliente: body.nombreCliente || null,
      telefono: body.telefono || null,
      notas: body.notas || null,
    }

    if (body.tipo === 'delivery') {
      baseValues.direccion = body.direccion
    }

    const nuevoPedido = await db.insert(PedidoUnificadoTable).values(baseValues)
    const pedidoId = Number(nuevoPedido[0].insertId)

    for (const item of items) {
      const producto = productosMap.get(item.productoId)!
      await db.insert(ItemPedidoUnificadoTable).values({
        pedidoId,
        productoId: item.productoId,
        cantidad: item.cantidad,
        precioUnitario: producto.precio,
        ingredientesExcluidos: item.ingredientesExcluidos?.length ? item.ingredientesExcluidos : null,
      })
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
      wsManager.broadcastAdminUpdate(restauranteId, tipo)
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

    if (!res || res.length === 0 || !res[0].rapiboyToken) {
      return c.json({ message: 'Token de Rapiboy no configurado', success: false }, 400)
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
          Token: res[0].rapiboyToken as string,
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
      console.log(`📲 [Notificar Cliente] Enviando WhatsApp a ${pedido.telefono}...`)
      const waResult = await sendClientOrderDispatchedWhatsApp(c, {
        phone: pedido.telefono,
        customerName: pedido.nombreCliente || 'Cliente',
        restaurantName: restaurante?.nombre || 'El local',
        orderStatus: dispatchMessage
      })

      if (waResult.success) {
        console.log(`📲 [Notificar Cliente] ✅ WhatsApp enviado exitosamente a ${pedido.telefono}`)

        // Registrar en historial
        await db.insert(MensajeWhatsappTable).values({
          pedidoUnificadoId: pedidoId,
          restauranteId,
          telefono: pedido.telefono,
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

export { pedidoUnificadoRoute }
