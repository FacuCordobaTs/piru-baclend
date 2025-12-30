// pedido.ts
import { Hono } from 'hono'
import { pool } from '../db'
import { pedido as PedidoTable, itemPedido as ItemPedidoTable, producto as ProductoTable, mesa as MesaTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, desc, and } from 'drizzle-orm'

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
      estado: PedidoTable.estado,
      total: PedidoTable.total,
      createdAt: PedidoTable.createdAt,
      closedAt: PedidoTable.closedAt,
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
    const items = await db
      .select({
        id: ItemPedidoTable.id,
        productoId: ItemPedidoTable.productoId,
        clienteNombre: ItemPedidoTable.clienteNombre,
        cantidad: ItemPedidoTable.cantidad,
        precioUnitario: ItemPedidoTable.precioUnitario,
        nombreProducto: ProductoTable.nombre,
        imagenUrl: ProductoTable.imagenUrl
      })
      .from(ItemPedidoTable)
      .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
      .where(eq(ItemPedidoTable.pedidoId, pedido.id))

    return {
      ...pedido,
      items,
      totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0)
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
  const items = await db
    .select({
      id: ItemPedidoTable.id,
      productoId: ItemPedidoTable.productoId,
      clienteNombre: ItemPedidoTable.clienteNombre,
      cantidad: ItemPedidoTable.cantidad,
      precioUnitario: ItemPedidoTable.precioUnitario,
      nombreProducto: ProductoTable.nombre,
      imagenUrl: ProductoTable.imagenUrl,
      descripcion: ProductoTable.descripcion
    })
    .from(ItemPedidoTable)
    .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
    .where(eq(ItemPedidoTable.pedidoId, pedidoId))

  // Agrupar items por cliente
  const itemsPorCliente = items.reduce((acc, item) => {
    const cliente = item.clienteNombre || 'Sin nombre'
    if (!acc[cliente]) {
      acc[cliente] = []
    }
    acc[cliente].push(item)
    return acc
  }, {} as Record<string, typeof items>)
  
  return c.json({ 
    message: 'Pedido encontrado correctamente', 
    success: true, 
    data: {
      ...pedido[0],
      items,
      itemsPorCliente,
      totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0)
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

  const validEstados = ['pending', 'preparing', 'delivered', 'closed']
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
  if (estado === 'closed') {
    updateData.closedAt = new Date()
  }

  await db
    .update(PedidoTable)
    .set(updateData)
    .where(eq(PedidoTable.id, pedidoId))
  
  return c.json({ 
    message: 'Estado actualizado correctamente', 
    success: true 
  }, 200)
})

export { pedidoRoute }

