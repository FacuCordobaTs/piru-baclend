import { Hono } from 'hono'
import { pool } from '../db'
import { codigoDescuento as CodigoDescuentoTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'

const codigoDescuentoRoute = new Hono()

codigoDescuentoRoute.use('*', authMiddleware)

const createCodigoSchema = z.object({
  codigo: z.string().min(1, 'El código es requerido').max(50).transform((v) => v.toUpperCase().trim()),
  tipo: z.enum(['porcentaje', 'monto_fijo']),
  valor: z.string().min(1, 'El valor es requerido'),
  limiteUsos: z.number().int().min(0).nullable().optional(),
  montoMinimo: z.string().optional(),
  fechaInicio: z.string().nullable().optional(),
  fechaFin: z.string().nullable().optional(),
})

const updateCodigoSchema = z.object({
  codigo: z.string().min(1).max(50).transform((v) => v.toUpperCase().trim()).optional(),
  tipo: z.enum(['porcentaje', 'monto_fijo']).optional(),
  valor: z.string().min(1).optional(),
  limiteUsos: z.number().int().min(0).nullable().optional(),
  montoMinimo: z.string().optional(),
  fechaInicio: z.string().nullable().optional(),
  fechaFin: z.string().nullable().optional(),
  activo: z.boolean().optional(),
})

// GET /codigo-descuento - Listar todos los códigos del restaurante
codigoDescuentoRoute.get('/', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    const codigos = await db
      .select()
      .from(CodigoDescuentoTable)
      .where(eq(CodigoDescuentoTable.restauranteId, restauranteId))

    return c.json({ success: true, data: codigos }, 200)
  } catch (error) {
    console.error('Error fetching códigos de descuento:', error)
    return c.json({ success: false, message: 'Error al obtener códigos de descuento' }, 500)
  }
})

// POST /codigo-descuento/create - Crear nuevo código
codigoDescuentoRoute.post('/create', zValidator('json', createCodigoSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const body = c.req.valid('json')

  try {
    // Verificar que no exista otro código igual para este restaurante
    const [existente] = await db
      .select()
      .from(CodigoDescuentoTable)
      .where(
        and(
          eq(CodigoDescuentoTable.restauranteId, restauranteId),
          eq(CodigoDescuentoTable.codigo, body.codigo)
        )
      )

    if (existente) {
      return c.json({ success: false, message: 'Ya existe un código con ese nombre' }, 400)
    }

    const result = await db.insert(CodigoDescuentoTable).values({
      restauranteId,
      codigo: body.codigo,
      tipo: body.tipo,
      valor: body.valor,
      limiteUsos: body.limiteUsos ?? null,
      montoMinimo: body.montoMinimo ?? '0.00',
      fechaInicio: body.fechaInicio ? new Date(body.fechaInicio) : null,
      fechaFin: body.fechaFin ? new Date(body.fechaFin) : null,
    })

    const insertedId = Number(result[0].insertId)
    const [nuevo] = await db
      .select()
      .from(CodigoDescuentoTable)
      .where(eq(CodigoDescuentoTable.id, insertedId))

    return c.json({ success: true, data: nuevo, message: 'Código creado exitosamente' }, 201)
  } catch (error) {
    console.error('Error creating código de descuento:', error)
    return c.json({ success: false, message: 'Error al crear código de descuento' }, 500)
  }
})

// PUT /codigo-descuento/:id - Actualizar código existente
codigoDescuentoRoute.put('/:id', zValidator('json', updateCodigoSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const codigoId = parseInt(c.req.param('id'), 10)

  if (isNaN(codigoId)) {
    return c.json({ success: false, message: 'ID inválido' }, 400)
  }

  const body = c.req.valid('json')

  try {
    const [existing] = await db
      .select()
      .from(CodigoDescuentoTable)
      .where(
        and(
          eq(CodigoDescuentoTable.id, codigoId),
          eq(CodigoDescuentoTable.restauranteId, restauranteId)
        )
      )

    if (!existing) {
      return c.json({ success: false, message: 'Código no encontrado' }, 404)
    }

    // Si se cambia el código, verificar que no exista otro
    if (body.codigo && body.codigo !== existing.codigo) {
      const [duplicado] = await db
        .select()
        .from(CodigoDescuentoTable)
        .where(
          and(
            eq(CodigoDescuentoTable.restauranteId, restauranteId),
            eq(CodigoDescuentoTable.codigo, body.codigo)
          )
        )
      if (duplicado) {
        return c.json({ success: false, message: 'Ya existe un código con ese nombre' }, 400)
      }
    }

    const updateData: Record<string, unknown> = {}
    if (body.codigo !== undefined) updateData.codigo = body.codigo
    if (body.tipo !== undefined) updateData.tipo = body.tipo
    if (body.valor !== undefined) updateData.valor = body.valor
    if (body.limiteUsos !== undefined) updateData.limiteUsos = body.limiteUsos
    if (body.montoMinimo !== undefined) updateData.montoMinimo = body.montoMinimo
    if (body.fechaInicio !== undefined) updateData.fechaInicio = body.fechaInicio ? new Date(body.fechaInicio) : null
    if (body.fechaFin !== undefined) updateData.fechaFin = body.fechaFin ? new Date(body.fechaFin) : null
    if (body.activo !== undefined) updateData.activo = body.activo

    if (Object.keys(updateData).length === 0) {
      return c.json({ success: false, message: 'No hay datos para actualizar' }, 400)
    }

    await db
      .update(CodigoDescuentoTable)
      .set(updateData)
      .where(eq(CodigoDescuentoTable.id, codigoId))

    const [actualizado] = await db
      .select()
      .from(CodigoDescuentoTable)
      .where(eq(CodigoDescuentoTable.id, codigoId))

    return c.json({ success: true, data: actualizado, message: 'Código actualizado' }, 200)
  } catch (error) {
    console.error('Error updating código de descuento:', error)
    return c.json({ success: false, message: 'Error al actualizar código' }, 500)
  }
})

// PUT /codigo-descuento/:id/toggle - Activar/desactivar código
codigoDescuentoRoute.put('/:id/toggle', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const codigoId = parseInt(c.req.param('id'), 10)

  if (isNaN(codigoId)) {
    return c.json({ success: false, message: 'ID inválido' }, 400)
  }

  try {
    const [existing] = await db
      .select()
      .from(CodigoDescuentoTable)
      .where(
        and(
          eq(CodigoDescuentoTable.id, codigoId),
          eq(CodigoDescuentoTable.restauranteId, restauranteId)
        )
      )

    if (!existing) {
      return c.json({ success: false, message: 'Código no encontrado' }, 404)
    }

    const nuevoEstado = !existing.activo
    await db
      .update(CodigoDescuentoTable)
      .set({ activo: nuevoEstado })
      .where(eq(CodigoDescuentoTable.id, codigoId))

    const [actualizado] = await db
      .select()
      .from(CodigoDescuentoTable)
      .where(eq(CodigoDescuentoTable.id, codigoId))

    return c.json({
      success: true,
      data: actualizado,
      message: nuevoEstado ? 'Código activado' : 'Código desactivado',
    }, 200)
  } catch (error) {
    console.error('Error toggling código:', error)
    return c.json({ success: false, message: 'Error al cambiar estado' }, 500)
  }
})

// DELETE /codigo-descuento/:id - Eliminar código
codigoDescuentoRoute.delete('/:id', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const codigoId = parseInt(c.req.param('id'), 10)

  if (isNaN(codigoId)) {
    return c.json({ success: false, message: 'ID inválido' }, 400)
  }

  try {
    const [existing] = await db
      .select()
      .from(CodigoDescuentoTable)
      .where(
        and(
          eq(CodigoDescuentoTable.id, codigoId),
          eq(CodigoDescuentoTable.restauranteId, restauranteId)
        )
      )

    if (!existing) {
      return c.json({ success: false, message: 'Código no encontrado' }, 404)
    }

    await db.delete(CodigoDescuentoTable).where(eq(CodigoDescuentoTable.id, codigoId))

    return c.json({ success: true, message: 'Código eliminado' }, 200)
  } catch (error) {
    console.error('Error deleting código:', error)
    return c.json({ success: false, message: 'Error al eliminar código' }, 500)
  }
})

export { codigoDescuentoRoute }
