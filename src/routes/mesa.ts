// mesa.ts
import { Hono } from 'hono'
import { pool } from '../db'
import { mesa as MesaTable, pedido as PedidoTable, producto as ProductoTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import UUID = require("uuid-js");
import { authMiddleware } from '../middleware/auth'
import { and, desc, eq } from 'drizzle-orm'

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

  const ultimoPedido = await db.select().
  from(PedidoTable).
  where(eq(PedidoTable.mesaId, mesa[0].id)).
  orderBy(desc(PedidoTable.createdAt))
  .limit(1)
  
  const productos = await db.select()
  .from(ProductoTable)
  .where(and(eq(ProductoTable.restauranteId, mesa[0].restauranteId!), eq(ProductoTable.activo, true)))

  let pedidoActual = ultimoPedido?.[0];
  if (!pedidoActual || pedidoActual.estado === 'closed') {
    const nuevoPedido = await db.insert(PedidoTable).values({ 
      mesaId: mesa[0].id,
      restauranteId: mesa[0].restauranteId,
      estado: 'pending',
      total: '0.00'
    })
    
    // Obtener el pedido recién creado

  return c.json({ 
    message: 'Mesa encontrada correctamente', 
    success: true, 
    data: {
      mesa: mesa[0],
      pedido: pedidoActual,
      productos: productos
    }
  }, 200)
  }

  return c.json({ 
    message: 'Mesa encontrada correctamente', 
    success: true, 
    data: {
      mesa: ultimoPedido[0], 
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

export { mesaRoute }