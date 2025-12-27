// mesa.ts
import { Hono } from 'hono'
import { pool } from '../db'
import { mesa as MesaTable, pedido as PedidoTable, producto as ProductoTable, itemPedido as ItemPedidoTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import UUID = require("uuid-js");
import { authMiddleware } from '../middleware/auth'
import { and, desc, eq, ne } from 'drizzle-orm'

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

   let ultimoPedido = await db.select().
  from(PedidoTable).
  where(eq(PedidoTable.mesaId, mesa[0].id)).
  orderBy(desc(PedidoTable.createdAt))
  .limit(1)
  
  const productos = await db.select()
  .from(ProductoTable)
  .where(and(eq(ProductoTable.restauranteId, mesa[0].restauranteId!), eq(ProductoTable.activo, true)))

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
      productos: productos
    }
  }, 200)
  }

  return c.json({ 
    message: 'Mesa encontrada correctamente', 
    success: true, 
    data: {
      mesa: mesa[0], 
      pedido: ultimoPedido[0], 
      productos: productos
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

export { mesaRoute }