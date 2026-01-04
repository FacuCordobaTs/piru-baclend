// mesa.ts
import { Hono } from 'hono'
import { pool } from '../db'
import { mesa as MesaTable, pedido as PedidoTable, producto as ProductoTable, itemPedido as ItemPedidoTable, restaurante as RestauranteTable, categoria as CategoriaTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import UUID = require("uuid-js");
import { authMiddleware } from '../middleware/auth'
import { and, desc, eq, ne, inArray } from 'drizzle-orm'

const createMesaSchema = z.object({
  nombre: z.string().min(3).max(255),
})

const mesaRoute = new Hono()


.post('/create', authMiddleware, zValidator('json', createMesaSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { nombre } = c.req.valid('json')
  const mesa = await db.insert(MesaTable).values({ 
    nombre, 
    restauranteId, 
    qrToken: UUID.create().toString() 
  })
  return c.json({ message: 'Mesa creada correctamente', success: true, data: mesa }, 200)
})

.get('/join/:qrToken', async (c) => {
  const db = drizzle(pool)
  const qrToken = c.req.param('qrToken')
  
  const mesa = await db.select().from(MesaTable).where(eq(MesaTable.qrToken, qrToken))

  if (!mesa || mesa.length === 0) {
    return c.json({ message: 'Mesa no encontrada', success: false }, 404)
  }

  // Obtener información del restaurante (nombre e imagen)
  const restaurante = await db.select({
    id: RestauranteTable.id,
    nombre: RestauranteTable.nombre,
    imagenUrl: RestauranteTable.imagenUrl,
  }).from(RestauranteTable).where(eq(RestauranteTable.id, mesa[0].restauranteId!)).limit(1)

   let ultimoPedido = await db.select().
  from(PedidoTable).
  where(eq(PedidoTable.mesaId, mesa[0].id)).
  orderBy(desc(PedidoTable.createdAt))
  .limit(1)
  
  const productos = await db
    .select({
      id: ProductoTable.id,
      restauranteId: ProductoTable.restauranteId,
      categoriaId: ProductoTable.categoriaId,
      nombre: ProductoTable.nombre,
      descripcion: ProductoTable.descripcion,
      precio: ProductoTable.precio,
      activo: ProductoTable.activo,
      imagenUrl: ProductoTable.imagenUrl,
      createdAt: ProductoTable.createdAt,
      categoria: {
        id: CategoriaTable.id,
        nombre: CategoriaTable.nombre,
      }
    })
    .from(ProductoTable)
    .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
    .where(and(eq(ProductoTable.restauranteId, mesa[0].restauranteId!), eq(ProductoTable.activo, true)))
  
  // Transformar los resultados para incluir categoria como string
  const productosConCategoria = productos.map(p => ({
    ...p,
    categoria: p.categoria?.nombre || null,
  }))

  let pedidoActual = ultimoPedido[0];
  if (!pedidoActual || pedidoActual.estado === 'closed') {
    const nuevoPedido = await db.insert(PedidoTable).values({ 
      mesaId: mesa[0].id,
      restauranteId: mesa[0].restauranteId,
      estado: 'pending',
      total: '0.00'
    })
    
    // Obtener el pedido recién creado
    ultimoPedido = await db.select().from(PedidoTable).
    where(eq(PedidoTable.id, Number(nuevoPedido[0].insertId))).
    orderBy(desc(PedidoTable.createdAt))
    .limit(1)

  return c.json({ 
    message: 'Mesa encontrada correctamente', 
    success: true, 
    data: {
      mesa: mesa[0],
      pedido: ultimoPedido[0], 
      productos: productosConCategoria,
      restaurante: restaurante[0] || null
    }
  }, 200)
  }

  return c.json({ 
    message: 'Mesa encontrada correctamente', 
    success: true, 
    data: {
      mesa: mesa[0], 
      pedido: ultimoPedido[0], 
      productos: productosConCategoria,
      restaurante: restaurante[0] || null
    } }, 200)
})

.get('/list', authMiddleware, async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const mesas = await db.select()
  .from(MesaTable)
  .where(eq(MesaTable.restauranteId, restauranteId))
  
  return c.json({ message: 'Mesas encontradas correctamente', success: true, data: mesas }, 200)
})

.delete('/delete/:id', authMiddleware, async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const id = Number(c.req.param('id'))

  // Verificar que la mesa existe y pertenece al restaurante
  const mesa = await db.select()
    .from(MesaTable)
    .where(and(eq(MesaTable.id, id), eq(MesaTable.restauranteId, restauranteId)))
  
  if (!mesa || mesa.length === 0) {
    return c.json({ message: 'Mesa no encontrada', success: false }, 404)
  }
  // Obtener todos los pedidos de la mesa (incluidos los cerrados) para eliminar items
  const todosLosPedidos = await db.select()
    .from(PedidoTable)
    .where(eq(PedidoTable.mesaId, id))

  // Eliminar items de pedido asociados
  for (const pedido of todosLosPedidos) {
    await db.delete(ItemPedidoTable).where(eq(ItemPedidoTable.pedidoId, pedido.id))
  }

  // Eliminar pedidos asociados
  await db.delete(PedidoTable).where(eq(PedidoTable.mesaId, id))

  // Eliminar la mesa
  await db.delete(MesaTable).where(and(eq(MesaTable.id, id), eq(MesaTable.restauranteId, restauranteId)))
  
  return c.json({ message: 'Mesa eliminada correctamente', success: true }, 200)
})

// Obtener todas las mesas con su pedido actual (para el admin)
.get('/list-with-pedidos', authMiddleware, async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  
  // Obtener todas las mesas del restaurante
  const mesas = await db.select()
    .from(MesaTable)
    .where(eq(MesaTable.restauranteId, restauranteId))
  
  if (mesas.length === 0) {
    return c.json({ 
      message: 'Mesas encontradas correctamente', 
      success: true, 
      data: [] 
    }, 200)
  }

  // Para cada mesa, obtener el último pedido con sus items
  const mesasConPedidos = await Promise.all(mesas.map(async (mesa) => {
    // Obtener el último pedido de esta mesa
    const ultimoPedido = await db.select()
      .from(PedidoTable)
      .where(eq(PedidoTable.mesaId, mesa.id))
      .orderBy(desc(PedidoTable.createdAt))
      .limit(1)

    let pedidoActual = ultimoPedido[0] || null
    let items: any[] = []

    // Si hay pedido, obtener sus items con info del producto
    if (pedidoActual) {
      items = await db
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
        .where(eq(ItemPedidoTable.pedidoId, pedidoActual.id))
    }

    return {
      ...mesa,
      pedidoActual,
      items,
      itemsCount: items.length,
      totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0)
    }
  }))
  
  return c.json({ 
    message: 'Mesas con pedidos encontradas correctamente', 
    success: true, 
    data: mesasConPedidos 
  }, 200)
})

// Obtener detalle de una mesa específica con su pedido actual
.get('/:id/pedido', authMiddleware, async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const mesaId = Number(c.req.param('id'))
  
  // Verificar que la mesa existe y pertenece al restaurante
  const mesa = await db.select()
    .from(MesaTable)
    .where(and(eq(MesaTable.id, mesaId), eq(MesaTable.restauranteId, restauranteId)))
  
  if (!mesa || mesa.length === 0) {
    return c.json({ message: 'Mesa no encontrada', success: false }, 404)
  }

  // Obtener el último pedido de esta mesa
  const ultimoPedido = await db.select()
    .from(PedidoTable)
    .where(eq(PedidoTable.mesaId, mesaId))
    .orderBy(desc(PedidoTable.createdAt))
    .limit(1)

  let pedidoActual = ultimoPedido[0] || null
  let items: any[] = []

  // Si hay pedido, obtener sus items con info del producto
  if (pedidoActual) {
    items = await db
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
      .where(eq(ItemPedidoTable.pedidoId, pedidoActual.id))
  }
  
  return c.json({ 
    message: 'Pedido de mesa encontrado correctamente', 
    success: true, 
    data: {
      mesa: mesa[0],
      pedido: pedidoActual,
      items
    }
  }, 200)
})

export { mesaRoute }