import { Hono } from 'hono'
import { pool } from '../db'
import { notificacion as NotificacionTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, and, desc } from 'drizzle-orm'

const notificacionRoute = new Hono()

.use('*', authMiddleware)

// Obtener todas las notificaciones del restaurante
.get('/', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  
  const notificaciones = await db
    .select()
    .from(NotificacionTable)
    .where(eq(NotificacionTable.restauranteId, restauranteId))
    .orderBy(desc(NotificacionTable.timestamp))
    .limit(100) // Limitar a las últimas 100 notificaciones
  
  return c.json({ 
    message: 'Notificaciones obtenidas correctamente', 
    success: true, 
    notificaciones 
  }, 200)
})

// Marcar una notificación como leída
.put('/:id/read', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const id = c.req.param('id')

  // Verificar que la notificación pertenece al restaurante
  const notificacion = await db
    .select()
    .from(NotificacionTable)
    .where(and(
      eq(NotificacionTable.id, id),
      eq(NotificacionTable.restauranteId, restauranteId)
    ))
    .limit(1)

  if (!notificacion || notificacion.length === 0) {
    return c.json({ 
      message: 'Notificación no encontrada', 
      success: false 
    }, 404)
  }

  await db
    .update(NotificacionTable)
    .set({ leida: true })
    .where(and(
      eq(NotificacionTable.id, id),
      eq(NotificacionTable.restauranteId, restauranteId)
    ))

  return c.json({ 
    message: 'Notificación marcada como leída', 
    success: true 
  }, 200)
})

// Marcar todas las notificaciones como leídas
.put('/read-all', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  await db
    .update(NotificacionTable)
    .set({ leida: true })
    .where(eq(NotificacionTable.restauranteId, restauranteId))

  return c.json({ 
    message: 'Todas las notificaciones marcadas como leídas', 
    success: true 
  }, 200)
})

// Eliminar una notificación
.delete('/:id', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const id = c.req.param('id')

  // Verificar que la notificación pertenece al restaurante
  const notificacion = await db
    .select()
    .from(NotificacionTable)
    .where(and(
      eq(NotificacionTable.id, id),
      eq(NotificacionTable.restauranteId, restauranteId)
    ))
    .limit(1)

  if (!notificacion || notificacion.length === 0) {
    return c.json({ 
      message: 'Notificación no encontrada', 
      success: false 
    }, 404)
  }

  await db
    .delete(NotificacionTable)
    .where(and(
      eq(NotificacionTable.id, id),
      eq(NotificacionTable.restauranteId, restauranteId)
    ))

  return c.json({ 
    message: 'Notificación eliminada correctamente', 
    success: true 
  }, 200)
})

// Eliminar todas las notificaciones
.delete('/all', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  await db
    .delete(NotificacionTable)
    .where(eq(NotificacionTable.restauranteId, restauranteId))

  return c.json({ 
    message: 'Todas las notificaciones eliminadas', 
    success: true 
  }, 200)
})

export { notificacionRoute }

