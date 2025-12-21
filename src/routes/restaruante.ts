import { Hono } from 'hono'
import { pool } from '../db'
import { restaurante as RestauranteTable, mesa as MesaTable, producto as ProductoTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'

const restauranteRoute = new Hono()

restauranteRoute.use('*', authMiddleware)

const completeProfileSchema = z.object({
  nombre: z.string().min(3),
  direccion: z.string().min(3),
  telefono: z.string().min(3),
  imagenUrl: z.string().min(3),
})

restauranteRoute.get('/profile', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const restaurante = await db.select().from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId))
  const mesas = await db.select().from(MesaTable).where(eq(MesaTable.restauranteId, restauranteId))
  const productos = await db.select().from(ProductoTable).where(and(eq(ProductoTable.restauranteId, restauranteId), eq(ProductoTable.activo, true)))

  try {
    return c.json({ message: 'Profile retrieved successfully', success: true, data: { restaurante, mesas, productos } }, 200)
  } catch (error) {
    console.error('Error getting profile:', error)
    return c.json({ message: 'Error getting profile', error: (error as Error).message }, 500)
  }

})

restauranteRoute.post('/complete-profile', zValidator('json', completeProfileSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { nombre, direccion, telefono, imagenUrl } = c.req.valid('json')

  try {
    await db.update(RestauranteTable).set({ nombre, direccion, telefono, imagenUrl }).where(eq(RestauranteTable.id, restauranteId))
    return c.json({ message: 'Profile completed successfully', success: true }, 200)

  } catch (error) {
    console.error('Error completing profile:', error)
    return c.json({ message: 'Error completing profile', error: (error as Error).message }, 500)
  }
  
})

export { restauranteRoute }