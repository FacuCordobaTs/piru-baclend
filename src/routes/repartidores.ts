import { Hono } from 'hono'
import { pool } from '../db'
import { repartidor as RepartidorTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, and } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

const repartidoresRoute = new Hono()
  .use('*', authMiddleware)

  .get('/list', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const repartidores = await db
      .select()
      .from(RepartidorTable)
      .where(eq(RepartidorTable.restauranteId, restauranteId))
      .orderBy(RepartidorTable.nombre)
    return c.json({ success: true, data: repartidores })
  })

  .post('/create', zValidator('json', z.object({ nombre: z.string().min(1, 'El nombre es requerido').max(255) })), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const { nombre } = c.req.valid('json')
    const result = await db.insert(RepartidorTable).values({
      restauranteId,
      nombre: nombre.trim(),
      estado: 'activo',
    })
    const id = Number(result[0].insertId)
    return c.json({ success: true, data: { id, restauranteId, nombre: nombre.trim(), estado: 'activo' } }, 201)
  })

  .put('/:id/estado', zValidator('json', z.object({ estado: z.enum(['activo', 'inactivo']) })), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const repartidorId = Number(c.req.param('id'))
    const { estado } = c.req.valid('json')

    const existing = await db
      .select({ id: RepartidorTable.id })
      .from(RepartidorTable)
      .where(and(eq(RepartidorTable.id, repartidorId), eq(RepartidorTable.restauranteId, restauranteId)))
      .limit(1)

    if (!existing.length) return c.json({ success: false, message: 'Repartidor no encontrado' }, 404)

    await db.update(RepartidorTable).set({ estado }).where(eq(RepartidorTable.id, repartidorId))
    return c.json({ success: true })
  })

export { repartidoresRoute }
