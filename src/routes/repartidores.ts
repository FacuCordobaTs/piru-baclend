import { Hono } from 'hono'
import { pool } from '../db'
import { repartidor as RepartidorTable, feriado as FeriadoTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, and, gte, lte } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { requireModulo } from '../middleware/modulo'
import { MODULE_KEYS } from '../lib/modulos'
import { anioArgentina, esFechaISO, feriadosNacionales } from '../lib/feriados-ar'
import { liquidarRepartidor, type DiaTrabajado } from '../lib/repartidor-pagos'

const pagosSchema = z.object({
  precioEnvio: z.coerce.number().min(0).max(10_000_000),
  pagoDiaHabil: z.coerce.number().min(0).max(10_000_000),
  pagoFinDeSemana: z.coerce.number().min(0).max(10_000_000),
  pagoFeriado: z.coerce.number().min(0).max(10_000_000),
})

const feriadoSchema = z.object({
  fecha: z.string().refine(esFechaISO, 'La fecha debe ser un día real en formato YYYY-MM-DD'),
  nombre: z.string().trim().min(1, 'El nombre es requerido').max(255),
})

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

  // Estadísticas y liquidación por repartidor.
  // `cantidadPedidos` cuenta todo lo asignado (histórico); `entregas` y el pago
  // sólo consideran pedidos no cancelados. Un día con al menos una entrega se
  // paga como día trabajado, con la tarifa que corresponda a ese día.
  // Filtro opcional por rango de fechas (from/to en formato YYYY-MM-DD).
  .get('/stats', async (c) => {
    const db = drizzle(pool)
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
         r.precio_envio,
         r.pago_dia_habil,
         r.pago_fin_de_semana,
         r.pago_feriado,
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
       GROUP BY r.id, r.nombre, r.estado, r.precio_envio, r.pago_dia_habil,
                r.pago_fin_de_semana, r.pago_feriado
       ORDER BY totalRecaudado DESC, r.nombre ASC`,
      params
    )

    // Días con al menos una entrega asignada, agrupados para no traer cada pedido.
    const diasParams: any[] = [restauranteId]
    let diasDateFilter = ''
    if (fromQuery && toQuery) {
      diasDateFilter = ' AND DATE(p.created_at) >= ? AND DATE(p.created_at) <= ?'
      diasParams.push(fromQuery, toQuery)
    }
    const [diasRows]: any = await pool.query(
      `SELECT
         p.repartidor_id AS repartidorId,
         DATE_FORMAT(DATE(p.created_at), '%Y-%m-%d') AS fecha,
         COUNT(*) AS entregas
       FROM pedido_unificado p
       WHERE p.restaurante_id = ?
         AND p.tipo = 'delivery'
         AND p.repartidor_id IS NOT NULL
         AND p.estado <> 'cancelled'${diasDateFilter}
       GROUP BY p.repartidor_id, DATE_FORMAT(DATE(p.created_at), '%Y-%m-%d')`,
      diasParams
    )

    const diasPorRepartidor = new Map<number, DiaTrabajado[]>()
    for (const row of diasRows as any[]) {
      const repartidorId = Number(row.repartidorId)
      const dias = diasPorRepartidor.get(repartidorId) ?? []
      dias.push({ fecha: String(row.fecha), entregas: Number(row.entregas) || 0 })
      diasPorRepartidor.set(repartidorId, dias)
    }

    // Feriados propios del local; los nacionales los resuelve la lib por fecha.
    const propios = await db
      .select({ fecha: FeriadoTable.fecha })
      .from(FeriadoTable)
      .where(eq(FeriadoTable.restauranteId, restauranteId))
    const feriadosPropios = new Set(propios.map((f) => String(f.fecha)))

    const data = (rows as any[]).map((row) => {
      const id = Number(row.id)
      const config = {
        precioEnvio: parseFloat(row.precio_envio) || 0,
        pagoDiaHabil: parseFloat(row.pago_dia_habil) || 0,
        pagoFinDeSemana: parseFloat(row.pago_fin_de_semana) || 0,
        pagoFeriado: parseFloat(row.pago_feriado) || 0,
      }
      const liquidacion = liquidarRepartidor(config, diasPorRepartidor.get(id) ?? [], feriadosPropios)

      return {
        id,
        nombre: row.nombre as string,
        estado: row.estado as 'activo' | 'inactivo',
        cantidadPedidos: Number(row.cantidadPedidos) || 0,
        pedidosPagados: Number(row.pedidosPagados) || 0,
        totalRecaudado: parseFloat(row.totalRecaudado) || 0,
        totalPedidos: parseFloat(row.totalPedidos) || 0,
        ...config,
        ...liquidacion,
      }
    })

    return c.json({ success: true, data })
  })

  // Calendario de feriados: los nacionales se calculan por año y los propios
  // salen de la tabla. El local sólo administra los propios (puentes y locales).
  .get('/feriados', zValidator('query', z.object({
    anio: z.coerce.number().int().min(2000).max(2100).optional(),
  })), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const anio = c.req.valid('query').anio ?? anioArgentina()

    const propios = await db
      .select()
      .from(FeriadoTable)
      .where(and(
        eq(FeriadoTable.restauranteId, restauranteId),
        gte(FeriadoTable.fecha, `${anio}-01-01`),
        lte(FeriadoTable.fecha, `${anio}-12-31`),
      ))
      .orderBy(FeriadoTable.fecha)

    return c.json({
      success: true,
      data: {
        anio,
        nacionales: feriadosNacionales(anio),
        propios: propios.map((f) => ({
          id: f.id,
          fecha: String(f.fecha),
          nombre: f.nombre,
        })),
      },
    })
  })

  .post('/feriados', requireModulo(MODULE_KEYS.GESTION_CADETES), zValidator('json', feriadoSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const { fecha, nombre } = c.req.valid('json')

    await db
      .insert(FeriadoTable)
      .values({ restauranteId, fecha, nombre: nombre.trim() })
      .onDuplicateKeyUpdate({ set: { nombre: nombre.trim() } })

    const [feriado] = await db
      .select()
      .from(FeriadoTable)
      .where(and(eq(FeriadoTable.restauranteId, restauranteId), eq(FeriadoTable.fecha, fecha)))
      .limit(1)

    return c.json({
      success: true,
      data: { id: feriado.id, fecha: String(feriado.fecha), nombre: feriado.nombre },
    }, 201)
  })

  .delete('/feriados/:id', requireModulo(MODULE_KEYS.GESTION_CADETES), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const feriadoId = Number(c.req.param('id'))
    if (!Number.isInteger(feriadoId) || feriadoId <= 0) {
      return c.json({ success: false, message: 'Feriado inválido' }, 400)
    }

    const existing = await db
      .select({ id: FeriadoTable.id })
      .from(FeriadoTable)
      .where(and(eq(FeriadoTable.id, feriadoId), eq(FeriadoTable.restauranteId, restauranteId)))
      .limit(1)
    if (!existing.length) return c.json({ success: false, message: 'Feriado no encontrado' }, 404)

    await db.delete(FeriadoTable).where(eq(FeriadoTable.id, feriadoId))
    return c.json({ success: true })
  })

  .post('/create', requireModulo(MODULE_KEYS.GESTION_CADETES), zValidator('json', z.object({ nombre: z.string().min(1, 'El nombre es requerido').max(255) })), async (c) => {
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

  .put('/:id/estado', requireModulo(MODULE_KEYS.GESTION_CADETES), zValidator('json', z.object({ estado: z.enum(['activo', 'inactivo']) })), async (c) => {
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

  // Importes de la liquidación del cadete. Los ceros son válidos: significan
  // que ese concepto no se paga.
  .put('/:id/pagos', requireModulo(MODULE_KEYS.GESTION_CADETES), zValidator('json', pagosSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const repartidorId = Number(c.req.param('id'))
    const pagos = c.req.valid('json')

    if (!Number.isInteger(repartidorId) || repartidorId <= 0) {
      return c.json({ success: false, message: 'Repartidor inválido' }, 400)
    }

    const existing = await db
      .select({ id: RepartidorTable.id })
      .from(RepartidorTable)
      .where(and(eq(RepartidorTable.id, repartidorId), eq(RepartidorTable.restauranteId, restauranteId)))
      .limit(1)
    if (!existing.length) return c.json({ success: false, message: 'Repartidor no encontrado' }, 404)

    await db.update(RepartidorTable).set({
      precioEnvio: pagos.precioEnvio.toFixed(2),
      pagoDiaHabil: pagos.pagoDiaHabil.toFixed(2),
      pagoFinDeSemana: pagos.pagoFinDeSemana.toFixed(2),
      pagoFeriado: pagos.pagoFeriado.toFixed(2),
    }).where(eq(RepartidorTable.id, repartidorId))

    return c.json({ success: true, data: pagos })
  })

export { repartidoresRoute }
