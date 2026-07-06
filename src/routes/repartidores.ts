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

  // Estadísticas por repartidor: cantidad de pedidos de delivery asignados y total recaudado en envíos.
  // Filtro opcional por rango de fechas (from/to en formato YYYY-MM-DD).
  .get('/stats', async (c) => {
    const restauranteId = (c as any).user.id
    const fromQuery = c.req.query('from')
    const toQuery = c.req.query('to')

    const params: any[] = [restauranteId]
    let dateFilter = ''
    if (fromQuery && toQuery) {
      dateFilter = ' AND DATE(p.created_at) >= ? AND DATE(p.created_at) <= ?'
      params.push(fromQuery, toQuery)
    }
    params.push(restauranteId)

    // El fee de envío es delivery_fee cuando existe; si es null (pedidos legacy),
    // se estima como total + descuento - subtotal de items (mismo criterio que la admin).
    const [rows]: any = await pool.query(
      `SELECT
         r.id,
         r.nombre,
         r.estado,
         COUNT(p.id) AS cantidadPedidos,
         COALESCE(SUM(CASE WHEN p.pagado = 1 THEN 1 ELSE 0 END), 0) AS pedidosPagados,
         COALESCE(SUM(
           CASE
             WHEN p.delivery_fee IS NOT NULL THEN p.delivery_fee
             ELSE GREATEST(0, p.total + COALESCE(p.monto_descuento, 0) - COALESCE(items.subtotal, 0))
           END
         ), 0) AS totalRecaudado,
         COALESCE(SUM(p.total), 0) AS totalPedidos
       FROM repartidor r
       LEFT JOIN pedido_unificado p
         ON p.repartidor_id = r.id
        AND p.tipo = 'delivery'
        AND p.restaurante_id = ?${dateFilter}
       LEFT JOIN (
         SELECT pedido_id, SUM(cantidad * precio_unitario) AS subtotal
         FROM item_pedido_unificado
         GROUP BY pedido_id
       ) items ON items.pedido_id = p.id
       WHERE r.restaurante_id = ?
       GROUP BY r.id, r.nombre, r.estado
       ORDER BY totalRecaudado DESC, r.nombre ASC`,
      params
    )

    const data = (rows as any[]).map((row) => ({
      id: Number(row.id),
      nombre: row.nombre as string,
      estado: row.estado as 'activo' | 'inactivo',
      cantidadPedidos: Number(row.cantidadPedidos) || 0,
      pedidosPagados: Number(row.pedidosPagados) || 0,
      totalRecaudado: parseFloat(row.totalRecaudado) || 0,
      totalPedidos: parseFloat(row.totalPedidos) || 0,
    }))

    return c.json({ success: true, data })
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
