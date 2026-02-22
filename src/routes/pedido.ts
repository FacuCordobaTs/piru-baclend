// pedido.ts
import { Hono } from 'hono'
import { pool } from '../db'
import { pedido as PedidoTable, itemPedido as ItemPedidoTable, producto as ProductoTable, mesa as MesaTable, pago as PagoTable, pagoSubtotal as PagoSubtotalTable, ingrediente as IngredienteTable, pedidoDelivery as PedidoDeliveryTable, itemPedidoDelivery as ItemPedidoDeliveryTable, pedidoTakeaway as PedidoTakeawayTable, itemPedidoTakeaway as ItemPedidoTakeawayTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, desc, and, inArray, gte, lt, sql } from 'drizzle-orm'
import { wsManager } from '../websocket/manager'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

// Schemas de validación
const createManualSchema = z.object({
  mesaId: z.number().int().positive()
})

const addItemSchema = z.object({
  productoId: z.number().int().positive(),
  cantidad: z.number().int().positive().default(1),
  clienteNombre: z.string().default('Mozo'),
  ingredientesExcluidos: z.array(z.number().int().positive()).optional()
})

const updateItemSchema = z.object({
  cantidad: z.number().int().positive()
})

const pedidoRoute = new Hono()

  .use('*', authMiddleware)

  // Obtener todos los pedidos del restaurante con paginación
  .get('/list', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const page = Number(c.req.query('page')) || 1
    const limit = Number(c.req.query('limit')) || 20
    const estado = c.req.query('estado') // Filtro opcional por estado
    const offset = (page - 1) * limit

    // Construir query base
    let whereCondition = eq(PedidoTable.restauranteId, restauranteId)

    // Obtener pedidos con info de mesa
    const pedidos = await db
      .select({
        id: PedidoTable.id,
        mesaId: PedidoTable.mesaId,
        nombrePedido: PedidoTable.nombrePedido,
        estado: PedidoTable.estado,
        total: PedidoTable.total,
        createdAt: PedidoTable.createdAt,
        closedAt: PedidoTable.closedAt,
        pagado: PedidoTable.pagado,
        mesaNombre: MesaTable.nombre,
      })
      .from(PedidoTable)
      .leftJoin(MesaTable, eq(PedidoTable.mesaId, MesaTable.id))
      .where(estado
        ? and(whereCondition, eq(PedidoTable.estado, estado as any))
        : whereCondition
      )
      .orderBy(desc(PedidoTable.createdAt))
      .limit(limit)
      .offset(offset)

    // Para cada pedido, obtener los items
    const pedidosConItems = await Promise.all(pedidos.map(async (pedido) => {
      const itemsRaw = await db
        .select({
          id: ItemPedidoTable.id,
          productoId: ItemPedidoTable.productoId,
          clienteNombre: ItemPedidoTable.clienteNombre,
          cantidad: ItemPedidoTable.cantidad,
          precioUnitario: ItemPedidoTable.precioUnitario,
          nombreProducto: ProductoTable.nombre,
          imagenUrl: ProductoTable.imagenUrl,
          ingredientesExcluidos: ItemPedidoTable.ingredientesExcluidos,
          postConfirmacion: ItemPedidoTable.postConfirmacion,
          estado: ItemPedidoTable.estado,
          createdAt: ItemPedidoTable.createdAt,
        })
        .from(ItemPedidoTable)
        .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
        .where(eq(ItemPedidoTable.pedidoId, pedido.id))
        .orderBy(desc(ItemPedidoTable.createdAt))

      // Obtener nombres de ingredientes excluidos para cada item
      const items = await Promise.all(
        itemsRaw.map(async (item) => {
          let ingredientesExcluidosNombres: string[] = []

          if (item.ingredientesExcluidos && Array.isArray(item.ingredientesExcluidos) && item.ingredientesExcluidos.length > 0) {
            const ingredientes = await db
              .select({
                id: IngredienteTable.id,
                nombre: IngredienteTable.nombre,
              })
              .from(IngredienteTable)
              .where(inArray(IngredienteTable.id, item.ingredientesExcluidos as number[]))

            ingredientesExcluidosNombres = ingredientes.map(ing => ing.nombre)
          }

          return {
            ...item,
            ingredientesExcluidos: item.ingredientesExcluidos || [],
            ingredientesExcluidosNombres,
            postConfirmacion: item.postConfirmacion || false,
            estado: item.estado || 'pending',
            createdAt: item.createdAt
          }
        })
      )

      // Para pedidos de mesa, calcular la fecha del último item agregado
      // Si hay items, usar la fecha del más reciente; si no, usar la fecha de creación del pedido
      const lastItemDate = items.length > 0 && items[0].createdAt
        ? new Date(items[0].createdAt)
        : new Date(pedido.createdAt)

      return {
        ...pedido,
        items,
        totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0),
        // Para pedidos de mesa, usar la fecha del último item como createdAt
        createdAt: pedido.mesaId ? lastItemDate.toISOString() : pedido.createdAt
      }
    }))

    return c.json({
      message: 'Pedidos encontrados correctamente',
      success: true,
      data: pedidosConItems,
      pagination: {
        page,
        limit,
        hasMore: pedidos.length === limit
      }
    }, 200)
  })

  // ==================== CIERRE DE TURNO ====================
  // IMPORTANTE: Esta ruta DEBE estar ANTES de /:id para que no sea capturada como un ID

  // Obtener resumen de ventas del día (cierre de turno)
  .get('/cierre-turno', async (c) => {
    const db = drizzle(pool)
    const rawId = (c as any).user?.id
    const restauranteId = Number(rawId)
    const fechaStr = c.req.query('fecha') // YYYY-MM-DD format

    console.log(`📊 Cierre de turno - rawId: ${rawId}, restauranteId: ${restauranteId}, type: ${typeof rawId}, fecha: ${fechaStr || 'hoy'}`)

    if (!rawId || isNaN(restauranteId)) {
      console.error(`❌ Cierre de turno - restauranteId inválido: rawId=${rawId}, parsed=${restauranteId}`)
      return c.json({ message: 'restauranteId inválido', success: false }, 400)
    }

    // Build date range
    let startOfDay: Date
    let endOfDay: Date

    if (fechaStr) {
      // Validate YYYY-MM-DD format
      const dateMatch = fechaStr.match(/^(\d{4})-(\d{2})-(\d{2})$/)
      if (!dateMatch) {
        return c.json({ message: 'Formato de fecha inválido. Use YYYY-MM-DD', success: false }, 400)
      }
      const [, yearStr, monthStr, dayStr] = dateMatch
      startOfDay = new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr), 0, 0, 0, 0)
      endOfDay = new Date(Number(yearStr), Number(monthStr) - 1, Number(dayStr), 23, 59, 59, 999)
    } else {
      startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      endOfDay = new Date()
      endOfDay.setHours(23, 59, 59, 999)
    }

    // Validate dates are valid
    if (isNaN(startOfDay.getTime()) || isNaN(endOfDay.getTime())) {
      return c.json({ message: 'Fecha inválida', success: false }, 400)
    }

    console.log(`📊 Date range: ${startOfDay.toISOString()} - ${endOfDay.toISOString()}`)

    try {
      // 1. Get all mesa pedidos for the date
      // For mesa pedidos, we filter by the date of the last item added, not the pedido creation date
      const allMesaPedidos = await db
        .select({
          id: PedidoTable.id,
          mesaId: PedidoTable.mesaId,
          nombrePedido: PedidoTable.nombrePedido,
          estado: PedidoTable.estado,
          total: PedidoTable.total,
          createdAt: PedidoTable.createdAt,
          closedAt: PedidoTable.closedAt,
          pagado: PedidoTable.pagado,
          metodoPago: PedidoTable.metodoPago,
          mesaNombre: MesaTable.nombre,
        })
        .from(PedidoTable)
        .leftJoin(MesaTable, eq(PedidoTable.mesaId, MesaTable.id))
        .where(eq(PedidoTable.restauranteId, restauranteId))

      // Get items for all mesa pedidos and filter by last item date
      const mesaPedidosConItems = await Promise.all(allMesaPedidos.map(async (pedido) => {
        const items = await db
          .select({
            id: ItemPedidoTable.id,
            productoId: ItemPedidoTable.productoId,
            clienteNombre: ItemPedidoTable.clienteNombre,
            cantidad: ItemPedidoTable.cantidad,
            precioUnitario: ItemPedidoTable.precioUnitario,
            nombreProducto: ProductoTable.nombre,
            estado: ItemPedidoTable.estado,
            createdAt: ItemPedidoTable.createdAt,
          })
          .from(ItemPedidoTable)
          .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
          .where(eq(ItemPedidoTable.pedidoId, pedido.id))
          .orderBy(desc(ItemPedidoTable.createdAt))

        // Get the date of the last item added (or use pedido createdAt if no items)
        const lastItemDate = items.length > 0 && items[0].createdAt
          ? new Date(items[0].createdAt)
          : new Date(pedido.createdAt)

        return {
          ...pedido,
          tipo: 'mesa' as const,
          items,
          totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0),
          lastItemDate, // Store the date of the last item for filtering
        }
      }))

      // Filter pedidos by last item date
      const mesaPedidosFiltered = mesaPedidosConItems.filter(pedido => {
        const lastItemDate = pedido.lastItemDate
        return lastItemDate >= startOfDay && lastItemDate < endOfDay
      })

      // Get pagos for all filtered mesa pedidos
      const mesaPedidoIds = mesaPedidosFiltered.map(p => p.id)
      let pagosMesa: any[] = []
      let pagosSubtotalMesa: any[] = []
      if (mesaPedidoIds.length > 0) {
        pagosMesa = await db.select().from(PagoTable).where(inArray(PagoTable.pedidoId, mesaPedidoIds))
        pagosSubtotalMesa = await db.select().from(PagoSubtotalTable).where(inArray(PagoSubtotalTable.pedidoId, mesaPedidoIds))
      }

      // Remove the temporary lastItemDate field and update createdAt to use last item date
      const mesaPedidosFinal = mesaPedidosFiltered.map(({ lastItemDate, ...pedido }) => ({
        ...pedido,
        createdAt: lastItemDate.toISOString(), // Use last item date as createdAt for mesa pedidos
        items: pedido.items, // Keep createdAt in items for frontend use
        pagos: pagosMesa.filter(p => p.pedidoId === pedido.id),
        pagosSubtotal: pagosSubtotalMesa.filter(p => p.pedidoId === pedido.id)
      }))

      // 2. Get all delivery pedidos for the date
      const deliveryPedidos = await db
        .select({
          id: PedidoDeliveryTable.id,
          direccion: PedidoDeliveryTable.direccion,
          nombreCliente: PedidoDeliveryTable.nombreCliente,
          telefono: PedidoDeliveryTable.telefono,
          estado: PedidoDeliveryTable.estado,
          total: PedidoDeliveryTable.total,
          notas: PedidoDeliveryTable.notas,
          createdAt: PedidoDeliveryTable.createdAt,
          deliveredAt: PedidoDeliveryTable.deliveredAt,
          pagado: PedidoDeliveryTable.pagado,
          metodoPago: PedidoDeliveryTable.metodoPago,
        })
        .from(PedidoDeliveryTable)
        .where(and(
          eq(PedidoDeliveryTable.restauranteId, restauranteId),
          gte(PedidoDeliveryTable.createdAt, startOfDay),
          lt(PedidoDeliveryTable.createdAt, endOfDay)
        ))
        .orderBy(desc(PedidoDeliveryTable.createdAt))

      const deliveryPedidosConItems = await Promise.all(deliveryPedidos.map(async (pedido) => {
        const items = await db
          .select({
            id: ItemPedidoDeliveryTable.id,
            productoId: ItemPedidoDeliveryTable.productoId,
            cantidad: ItemPedidoDeliveryTable.cantidad,
            precioUnitario: ItemPedidoDeliveryTable.precioUnitario,
            nombreProducto: ProductoTable.nombre,
          })
          .from(ItemPedidoDeliveryTable)
          .leftJoin(ProductoTable, eq(ItemPedidoDeliveryTable.productoId, ProductoTable.id))
          .where(eq(ItemPedidoDeliveryTable.pedidoDeliveryId, pedido.id))

        return {
          ...pedido,
          tipo: 'delivery' as const,
          items,
          totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0)
        }
      }))

      // 3. Get all takeaway pedidos for the date
      const takeawayPedidos = await db
        .select({
          id: PedidoTakeawayTable.id,
          nombreCliente: PedidoTakeawayTable.nombreCliente,
          telefono: PedidoTakeawayTable.telefono,
          estado: PedidoTakeawayTable.estado,
          total: PedidoTakeawayTable.total,
          notas: PedidoTakeawayTable.notas,
          createdAt: PedidoTakeawayTable.createdAt,
          deliveredAt: PedidoTakeawayTable.deliveredAt,
          pagado: PedidoTakeawayTable.pagado,
          metodoPago: PedidoTakeawayTable.metodoPago,
        })
        .from(PedidoTakeawayTable)
        .where(and(
          eq(PedidoTakeawayTable.restauranteId, restauranteId),
          gte(PedidoTakeawayTable.createdAt, startOfDay),
          lt(PedidoTakeawayTable.createdAt, endOfDay)
        ))
        .orderBy(desc(PedidoTakeawayTable.createdAt))

      const takeawayPedidosConItems = await Promise.all(takeawayPedidos.map(async (pedido) => {
        const items = await db
          .select({
            id: ItemPedidoTakeawayTable.id,
            productoId: ItemPedidoTakeawayTable.productoId,
            cantidad: ItemPedidoTakeawayTable.cantidad,
            precioUnitario: ItemPedidoTakeawayTable.precioUnitario,
            nombreProducto: ProductoTable.nombre,
          })
          .from(ItemPedidoTakeawayTable)
          .leftJoin(ProductoTable, eq(ItemPedidoTakeawayTable.productoId, ProductoTable.id))
          .where(eq(ItemPedidoTakeawayTable.pedidoTakeawayId, pedido.id))

        return {
          ...pedido,
          tipo: 'takeaway' as const,
          items,
          totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0)
        }
      }))

      // 4. Get available dates (distinct dates that have orders) - last 90 days
      // For mesa pedidos, use the date of the last item added, not the pedido creation date
      const ninetyDaysAgo = new Date()
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

      // For mesa pedidos, get dates from the last item added to each pedido
      const mesaPedidosForDates = await db
        .select({
          pedidoId: PedidoTable.id,
        })
        .from(PedidoTable)
        .where(and(
          eq(PedidoTable.restauranteId, restauranteId),
          gte(PedidoTable.createdAt, ninetyDaysAgo)
        ))

      const mesaItemDates = await Promise.all(mesaPedidosForDates.map(async (p) => {
        const lastItem = await db
          .select({ createdAt: ItemPedidoTable.createdAt })
          .from(ItemPedidoTable)
          .where(eq(ItemPedidoTable.pedidoId, p.pedidoId))
          .orderBy(desc(ItemPedidoTable.createdAt))
          .limit(1)

        return lastItem[0]?.createdAt || null
      }))

      const mesaDates = mesaItemDates
        .filter(date => date !== null)
        .map(date => ({ fecha: sql<string>`DATE(${date})` }))

      const [deliveryDates, takeawayDates] = await Promise.all([
        db.select({ fecha: sql<string>`DATE(${PedidoDeliveryTable.createdAt})` })
          .from(PedidoDeliveryTable)
          .where(and(
            eq(PedidoDeliveryTable.restauranteId, restauranteId),
            gte(PedidoDeliveryTable.createdAt, ninetyDaysAgo)
          ))
          .groupBy(sql`DATE(${PedidoDeliveryTable.createdAt})`),
        db.select({ fecha: sql<string>`DATE(${PedidoTakeawayTable.createdAt})` })
          .from(PedidoTakeawayTable)
          .where(and(
            eq(PedidoTakeawayTable.restauranteId, restauranteId),
            gte(PedidoTakeawayTable.createdAt, ninetyDaysAgo)
          ))
          .groupBy(sql`DATE(${PedidoTakeawayTable.createdAt})`)
      ])

      const allDatesSet = new Set<string>()
        ;[...mesaDates, ...deliveryDates, ...takeawayDates].forEach(d => {
          if (d.fecha) allDatesSet.add(d.fecha.toString().split('T')[0])
        })
      const fechasDisponibles = Array.from(allDatesSet).sort().reverse()

      // 5. Calculate totals
      const totalMesa = mesaPedidosFinal
        .filter(p => p.estado !== 'archived' && p.totalItems > 0)
        .reduce((sum, p) => sum + parseFloat(p.total || '0'), 0)
      const totalDelivery = deliveryPedidosConItems
        .filter(p => p.estado !== 'archived' && p.estado !== 'cancelled')
        .reduce((sum, p) => sum + parseFloat(p.total || '0'), 0)
      const totalTakeaway = takeawayPedidosConItems
        .filter(p => p.estado !== 'archived' && p.estado !== 'cancelled')
        .reduce((sum, p) => sum + parseFloat(p.total || '0'), 0)

      // 6. Product summary: aggregate quantity sold per product
      const productSummary = new Map<string, { nombre: string; cantidad: number; totalVendido: number }>()

      const addToSummary = (items: any[]) => {
        items.forEach(item => {
          const key = item.nombreProducto || `Producto #${item.productoId}`
          const existing = productSummary.get(key) || { nombre: key, cantidad: 0, totalVendido: 0 }
          existing.cantidad += item.cantidad || 1
          existing.totalVendido += parseFloat(item.precioUnitario || '0') * (item.cantidad || 1)
          productSummary.set(key, existing)
        })
      }

      mesaPedidosFinal.filter(p => p.estado !== 'archived' && p.totalItems > 0).forEach(p => addToSummary(p.items))
      deliveryPedidosConItems.filter(p => p.estado !== 'archived' && p.estado !== 'cancelled').forEach(p => addToSummary(p.items))
      takeawayPedidosConItems.filter(p => p.estado !== 'archived' && p.estado !== 'cancelled').forEach(p => addToSummary(p.items))

      const productosVendidos = Array.from(productSummary.values()).sort((a, b) => b.cantidad - a.cantidad)

      return c.json({
        success: true,
        data: {
          fecha: fechaStr || `${startOfDay.getFullYear()}-${String(startOfDay.getMonth() + 1).padStart(2, '0')}-${String(startOfDay.getDate()).padStart(2, '0')}`,
          pedidosMesa: mesaPedidosFinal,
          pedidosDelivery: deliveryPedidosConItems,
          pedidosTakeaway: takeawayPedidosConItems,
          totales: {
            mesa: totalMesa.toFixed(2),
            delivery: totalDelivery.toFixed(2),
            takeaway: totalTakeaway.toFixed(2),
            general: (totalMesa + totalDelivery + totalTakeaway).toFixed(2),
          },
          cantidades: {
            mesa: mesaPedidosFinal.filter(p => p.totalItems > 0).length,
            delivery: deliveryPedidosConItems.length,
            takeaway: takeawayPedidosConItems.length,
            total: mesaPedidosFinal.filter(p => p.totalItems > 0).length + deliveryPedidosConItems.length + takeawayPedidosConItems.length,
          },
          productosVendidos,
          fechasDisponibles,
        }
      }, 200)
    } catch (error) {
      console.error('Error en cierre de turno:', error)
      return c.json({
        message: 'Error al obtener cierre de turno',
        success: false,
        error: (error as Error).message
      }, 500)
    }
  })

  // ==================== MARCAR PEDIDO COMO PAGADO ====================
  // IMPORTANTE: Esta ruta DEBE estar ANTES de /:id para evitar conflictos

  .put('/marcar-pagado/:id', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))

    // Verificar que el pedido pertenece al restaurante
    const pedido = await db
      .select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.id, pedidoId),
        eq(PedidoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    // Toggle pagado
    const body = await c.req.json().catch(() => ({}))
    const metodoPagoStr = body.metodoPago || null

    const newPagado = !pedido[0].pagado

    await db
      .update(PedidoTable)
      .set({
        pagado: newPagado,
        metodoPago: newPagado ? metodoPagoStr : null
      })
      .where(eq(PedidoTable.id, pedidoId))

    // Notificar a admins conectados para actualizar UI en tiempo real
    if (pedido[0].mesaId) {
      wsManager.broadcastEstadoToAdmins(pedido[0].mesaId)
    }

    return c.json({
      message: newPagado ? 'Pedido marcado como pagado' : 'Pedido marcado como no pagado',
      success: true,
      data: { pagado: newPagado }
    }, 200)
  })

  // Obtener un pedido específico con todos sus detalles
  .get('/:id', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))

    // Obtener pedido con info de mesa
    const pedido = await db
      .select({
        id: PedidoTable.id,
        mesaId: PedidoTable.mesaId,
        nombrePedido: PedidoTable.nombrePedido,
        estado: PedidoTable.estado,
        total: PedidoTable.total,
        createdAt: PedidoTable.createdAt,
        closedAt: PedidoTable.closedAt,
        mesaNombre: MesaTable.nombre,
        mesaQrToken: MesaTable.qrToken,
      })
      .from(PedidoTable)
      .leftJoin(MesaTable, eq(PedidoTable.mesaId, MesaTable.id))
      .where(and(
        eq(PedidoTable.id, pedidoId),
        eq(PedidoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    // Obtener items del pedido
    const itemsRaw = await db
      .select({
        id: ItemPedidoTable.id,
        productoId: ItemPedidoTable.productoId,
        clienteNombre: ItemPedidoTable.clienteNombre,
        cantidad: ItemPedidoTable.cantidad,
        precioUnitario: ItemPedidoTable.precioUnitario,
        nombreProducto: ProductoTable.nombre,
        imagenUrl: ProductoTable.imagenUrl,
        descripcion: ProductoTable.descripcion,
        ingredientesExcluidos: ItemPedidoTable.ingredientesExcluidos,
        postConfirmacion: ItemPedidoTable.postConfirmacion,
        estado: ItemPedidoTable.estado
      })
      .from(ItemPedidoTable)
      .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
      .where(eq(ItemPedidoTable.pedidoId, pedidoId))

    // Helper para parsear JSON si viene como string
    const parseJsonField = (value: any): number[] | null => {
      if (!value) return null
      if (Array.isArray(value)) return value
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value)
          return Array.isArray(parsed) ? parsed : null
        } catch {
          return null
        }
      }
      return null
    }

    // Obtener nombres de ingredientes excluidos para cada item
    const items = await Promise.all(
      itemsRaw.map(async (item) => {
        let ingredientesExcluidosNombres: string[] = []
        const ingredientesExcluidosParsed = parseJsonField(item.ingredientesExcluidos)

        if (ingredientesExcluidosParsed && ingredientesExcluidosParsed.length > 0) {
          const ingredientes = await db
            .select({
              id: IngredienteTable.id,
              nombre: IngredienteTable.nombre,
            })
            .from(IngredienteTable)
            .where(inArray(IngredienteTable.id, ingredientesExcluidosParsed))

          ingredientesExcluidosNombres = ingredientes.map(ing => ing.nombre)
        }

        return {
          ...item,
          ingredientesExcluidos: ingredientesExcluidosParsed || [],
          ingredientesExcluidosNombres,
          postConfirmacion: item.postConfirmacion || false,
          estado: item.estado || 'pending'
        }
      })
    )

    // Agrupar items por cliente
    const itemsPorCliente = items.reduce((acc, item) => {
      const cliente = item.clienteNombre || 'Sin nombre'
      if (!acc[cliente]) {
        acc[cliente] = []
      }
      acc[cliente].push(item)
      return acc
    }, {} as Record<string, typeof items>)

    // Obtener información de pago del pedido
    const pagos = await db
      .select({
        id: PagoTable.id,
        metodo: PagoTable.metodo,
        estado: PagoTable.estado,
        monto: PagoTable.monto,
        mpPaymentId: PagoTable.mpPaymentId,
        createdAt: PagoTable.createdAt
      })
      .from(PagoTable)
      .where(eq(PagoTable.pedidoId, pedidoId))
      .orderBy(desc(PagoTable.createdAt))

    // Determinar el pago principal (el más reciente con estado 'paid', o el más reciente)
    const pagoPrincipal = pagos.find(p => p.estado === 'paid') || pagos[0] || null

    return c.json({
      message: 'Pedido encontrado correctamente',
      success: true,
      data: {
        ...pedido[0],
        items,
        itemsPorCliente,
        totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0),
        pago: pagoPrincipal,
        pagos: pagos // Todos los intentos de pago por si hay múltiples
      }
    }, 200)
  })

  // Actualizar estado del pedido
  .put('/:id/estado', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const body = await c.req.json()
    const { estado } = body

    const validEstados = ['pending', 'preparing', 'delivered', 'served', 'closed', 'archived']
    if (!validEstados.includes(estado)) {
      return c.json({ message: 'Estado inválido', success: false }, 400)
    }

    // Verificar que el pedido pertenece al restaurante
    const pedido = await db
      .select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.id, pedidoId),
        eq(PedidoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    // Actualizar estado
    const updateData: any = { estado }
    if (estado === 'closed' || estado === 'archived') {
      updateData.closedAt = new Date()
    }

    await db
      .update(PedidoTable)
      .set(updateData)
      .where(eq(PedidoTable.id, pedidoId))

    // Notificar a clientes conectados via WebSocket
    if (pedido[0].mesaId) {
      const estadoActual = await wsManager.getEstadoInicial(pedidoId)
      wsManager.broadcast(pedido[0].mesaId, {
        type: 'PEDIDO_ACTUALIZADO',
        payload: {
          items: estadoActual.items,
          pedido: estadoActual.pedido
        }
      })

      // Si el estado es 'delivered', también notificar que el pedido está listo
      // Esto es especialmente importante para el modo Carrito
      if (estado === 'delivered') {
        await wsManager.marcarPedidoListo(pedidoId, pedido[0].mesaId)
      }

      // Notificar a admins
      wsManager.broadcastEstadoToAdmins(pedido[0].mesaId)
    }

    return c.json({
      message: 'Estado actualizado correctamente',
      success: true
    }, 200)
  })

  // ==================== ENDPOINTS MANUALES PARA ADMIN ====================

  // Crear pedido manual para una mesa
  .post('/create-manual', zValidator('json', createManualSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const { mesaId } = c.req.valid('json')

    // Verificar que la mesa pertenece al restaurante
    const mesa = await db
      .select()
      .from(MesaTable)
      .where(and(
        eq(MesaTable.id, mesaId),
        eq(MesaTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!mesa || mesa.length === 0) {
      return c.json({ message: 'Mesa no encontrada', success: false }, 404)
    }

    // Verificar si ya existe un pedido activo (no cerrado) para esta mesa
    const pedidoActivo = await db
      .select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.mesaId, mesaId),
        eq(PedidoTable.estado, 'pending')
      ))
      .orderBy(desc(PedidoTable.createdAt))
      .limit(1)

    // Si ya existe un pedido pending, retornarlo
    if (pedidoActivo && pedidoActivo.length > 0) {
      return c.json({
        message: 'Ya existe un pedido activo para esta mesa',
        success: true,
        data: {
          pedidoId: pedidoActivo[0].id,
          mesaId,
          estado: pedidoActivo[0].estado,
          existing: true
        }
      }, 200)
    }

    // También verificar si hay un pedido en 'preparing' o 'delivered'
    const pedidoEnCurso = await db
      .select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.mesaId, mesaId)
      ))
      .orderBy(desc(PedidoTable.createdAt))
      .limit(1)

    if (pedidoEnCurso && pedidoEnCurso.length > 0 && pedidoEnCurso[0].estado !== 'closed' && pedidoEnCurso[0].estado !== 'archived') {
      return c.json({
        message: 'Ya existe un pedido en curso para esta mesa',
        success: true,
        data: {
          pedidoId: pedidoEnCurso[0].id,
          mesaId,
          estado: pedidoEnCurso[0].estado,
          existing: true
        }
      }, 200)
    }

    // Crear nuevo pedido
    const nuevoPedido = await db.insert(PedidoTable).values({
      mesaId,
      restauranteId,
      estado: 'pending',
      total: '0.00'
    })

    const pedidoId = Number(nuevoPedido[0].insertId)

    // Notificar a admins del nuevo pedido
    wsManager.broadcastEstadoToAdmins(mesaId)

    return c.json({
      message: 'Pedido creado correctamente',
      success: true,
      data: {
        pedidoId,
        mesaId,
        estado: 'pending',
        existing: false
      }
    }, 201)
  })

  // Agregar item a un pedido (desde admin/mozo)
  .post('/:id/items', zValidator('json', addItemSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const { productoId, cantidad, clienteNombre, ingredientesExcluidos } = c.req.valid('json')

    // Verificar que el pedido pertenece al restaurante
    const pedido = await db
      .select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.id, pedidoId),
        eq(PedidoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    if (pedido[0].estado === 'closed' || pedido[0].estado === 'archived') {
      return c.json({ message: 'No se puede agregar items a un pedido cerrado o archivado', success: false }, 400)
    }

    // Obtener el producto para el precio
    const producto = await db
      .select()
      .from(ProductoTable)
      .where(and(
        eq(ProductoTable.id, productoId),
        eq(ProductoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!producto || producto.length === 0) {
      return c.json({ message: 'Producto no encontrado', success: false }, 404)
    }

    if (!producto[0].activo) {
      return c.json({ message: 'El producto no está disponible', success: false }, 400)
    }

    // Usar wsManager para agregar el item (esto hace broadcast automáticamente)
    const nuevoItem = await wsManager.agregarItem(pedidoId, pedido[0].mesaId!, {
      productoId,
      cantidad,
      clienteNombre,
      precioUnitario: producto[0].precio,
      ingredientesExcluidos
    })

    // Notificar a admins
    wsManager.broadcastEstadoToAdmins(pedido[0].mesaId!)

    return c.json({
      message: 'Item agregado correctamente',
      success: true,
      data: nuevoItem
    }, 201)
  })

  // Eliminar item de un pedido
  .delete('/:id/items/:itemId', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const itemId = Number(c.req.param('itemId'))

    // Verificar que el pedido pertenece al restaurante
    const pedido = await db
      .select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.id, pedidoId),
        eq(PedidoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    if (pedido[0].estado === 'closed' || pedido[0].estado === 'archived') {
      return c.json({ message: 'No se puede eliminar items de un pedido cerrado o archivado', success: false }, 400)
    }

    // Verificar que el item pertenece al pedido
    const item = await db
      .select()
      .from(ItemPedidoTable)
      .where(and(
        eq(ItemPedidoTable.id, itemId),
        eq(ItemPedidoTable.pedidoId, pedidoId)
      ))
      .limit(1)

    if (!item || item.length === 0) {
      return c.json({ message: 'Item no encontrado', success: false }, 404)
    }

    // Usar wsManager para eliminar el item (esto hace broadcast automáticamente)
    await wsManager.eliminarItem(itemId, pedidoId, pedido[0].mesaId!)

    // Notificar a admins
    wsManager.broadcastEstadoToAdmins(pedido[0].mesaId!)

    return c.json({
      message: 'Item eliminado correctamente',
      success: true
    }, 200)
  })

  // Actualizar cantidad de un item
  .put('/:id/items/:itemId', zValidator('json', updateItemSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const itemId = Number(c.req.param('itemId'))
    const { cantidad } = c.req.valid('json')

    // Verificar que el pedido pertenece al restaurante
    const pedido = await db
      .select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.id, pedidoId),
        eq(PedidoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    if (pedido[0].estado === 'closed' || pedido[0].estado === 'archived') {
      return c.json({ message: 'No se puede modificar items de un pedido cerrado o archivado', success: false }, 400)
    }

    // Verificar que el item pertenece al pedido
    const item = await db
      .select()
      .from(ItemPedidoTable)
      .where(and(
        eq(ItemPedidoTable.id, itemId),
        eq(ItemPedidoTable.pedidoId, pedidoId)
      ))
      .limit(1)

    if (!item || item.length === 0) {
      return c.json({ message: 'Item no encontrado', success: false }, 404)
    }

    // Usar wsManager para actualizar la cantidad (esto hace broadcast automáticamente)
    await wsManager.actualizarCantidad(itemId, cantidad, pedidoId, pedido[0].mesaId!)

    // Notificar a admins
    wsManager.broadcastEstadoToAdmins(pedido[0].mesaId!)

    return c.json({
      message: 'Cantidad actualizada correctamente',
      success: true
    }, 200)
  })

  // Actualizar estado de un item
  .put('/:id/items/:itemId/estado', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))
    const itemId = Number(c.req.param('itemId'))
    const body = await c.req.json()
    const { estado } = body

    const validEstados = ['pending', 'preparing', 'delivered', 'served', 'cancelled']
    if (!validEstados.includes(estado)) {
      return c.json({ message: 'Estado inválido', success: false }, 400)
    }

    // Verificar que el pedido pertenece al restaurante
    const pedido = await db
      .select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.id, pedidoId),
        eq(PedidoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    // Usar wsManager para actualizar el estado del item
    await wsManager.actualizarEstadoItem(itemId, estado, pedidoId, pedido[0].mesaId!)

    return c.json({
      message: 'Estado de item actualizado correctamente',
      success: true
    }, 200)
  })

  // Confirmar pedido (cambiar a 'preparing')
  .post('/:id/confirmar', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))

    // Verificar que el pedido pertenece al restaurante
    const pedido = await db
      .select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.id, pedidoId),
        eq(PedidoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    if (pedido[0].estado !== 'pending') {
      return c.json({ message: 'Solo se pueden confirmar pedidos pendientes', success: false }, 400)
    }

    // Usar wsManager para confirmar (esto notifica a clientes y admins)
    await wsManager.confirmarPedido(pedidoId, pedido[0].mesaId!)

    return c.json({
      message: 'Pedido confirmado correctamente',
      success: true
    }, 200)
  })

  // Cerrar pedido
  .post('/:id/cerrar', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))

    // Verificar que el pedido pertenece al restaurante
    const pedido = await db
      .select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.id, pedidoId),
        eq(PedidoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    if (pedido[0].estado === 'closed' || pedido[0].estado === 'archived') {
      return c.json({ message: 'El pedido ya está cerrado o archivado', success: false }, 400)
    }

    // Usar wsManager para cerrar (esto notifica a clientes y admins)
    await wsManager.cerrarPedido(pedidoId, pedido[0].mesaId!)

    return c.json({
      message: 'Pedido cerrado correctamente',
      success: true
    }, 200)
  })

  // Eliminar pedido completamente
  .delete('/delete/:id', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const pedidoId = Number(c.req.param('id'))

    // Verificar que el pedido pertenece al restaurante
    const pedido = await db
      .select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.id, pedidoId),
        eq(PedidoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ message: 'Pedido no encontrado', success: false }, 404)
    }

    const mesaId = pedido[0].mesaId

    try {
      // Eliminar pagos asociados primero
      await db
        .delete(PagoTable)
        .where(eq(PagoTable.pedidoId, pedidoId))

      // Eliminar items del pedido
      await db
        .delete(ItemPedidoTable)
        .where(eq(ItemPedidoTable.pedidoId, pedidoId))

      // Eliminar el pedido
      await db
        .delete(PedidoTable)
        .where(eq(PedidoTable.id, pedidoId))

      // Notificar a clientes conectados via WebSocket
      if (mesaId) {
        wsManager.broadcast(mesaId, {
          type: 'PEDIDO_ELIMINADO',
          payload: { pedidoId }
        })
        // Notificar a admins
        wsManager.broadcastEstadoToAdmins(mesaId)
      }

      return c.json({
        message: 'Pedido eliminado correctamente',
        success: true
      }, 200)
    } catch (error) {
      console.error('Error al eliminar pedido:', error)
      return c.json({
        message: 'Error al eliminar el pedido',
        success: false,
        error: (error as Error).message
      }, 500)
    }
  })

export { pedidoRoute }

