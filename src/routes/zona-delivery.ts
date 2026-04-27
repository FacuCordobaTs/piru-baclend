import { Hono } from 'hono'
import { pool } from '../db'
import { zonaDelivery as ZonaDeliveryTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'

const zonaDeliveryRoute = new Hono()

zonaDeliveryRoute.use('*', authMiddleware)

// Schema de validación para coordenadas
const coordenadaSchema = z.object({
    lat: z.number(),
    lng: z.number(),
})

const createZonaSchema = z.object({
    nombre: z.string().min(1, 'El nombre es requerido'),
    precio: z.string().min(1, 'El precio es requerido'),
    poligono: z.array(coordenadaSchema).min(3, 'Un polígono necesita al menos 3 puntos'),
    color: z.string().optional(),
})

const updateZonaSchema = z.object({
    nombre: z.string().min(1).optional(),
    precio: z.string().min(1).optional(),
    poligono: z.array(coordenadaSchema).min(3).optional(),
    color: z.string().optional(),
})

// GET /zona-delivery - Obtener todas las zonas del restaurante
zonaDeliveryRoute.get('/', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id

    try {
        const zonas = await db
            .select()
            .from(ZonaDeliveryTable)
            .where(eq(ZonaDeliveryTable.restauranteId, restauranteId))

        return c.json({ success: true, data: zonas }, 200)
    } catch (error) {
        console.error('Error fetching zonas de delivery:', error)
        return c.json({ success: false, message: 'Error al obtener zonas de delivery' }, 500)
    }
})

// POST /zona-delivery/create - Crear una nueva zona
zonaDeliveryRoute.post('/create', zValidator('json', createZonaSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const { nombre, precio, poligono, color } = c.req.valid('json')

    try {
        const result = await db.insert(ZonaDeliveryTable).values({
            restauranteId,
            nombre,
            precio,
            poligono,
            color: color || null,
        })

        const insertedId = Number(result[0].insertId)

        // Fetch the created zona
        const [zona] = await db
            .select()
            .from(ZonaDeliveryTable)
            .where(eq(ZonaDeliveryTable.id, insertedId))

        return c.json({ success: true, data: zona, message: 'Zona creada exitosamente' }, 201)
    } catch (error) {
        console.error('Error creating zona de delivery:', error)
        return c.json({ success: false, message: 'Error al crear zona de delivery' }, 500)
    }
})

// PUT /zona-delivery/:id - Actualizar una zona existente
zonaDeliveryRoute.put('/:id', zValidator('json', updateZonaSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const zonaId = parseInt(c.req.param('id'), 10)

    if (isNaN(zonaId)) {
        return c.json({ success: false, message: 'ID de zona inválido' }, 400)
    }

    const { nombre, precio, poligono, color } = c.req.valid('json')

    try {
        // Verificar que la zona pertenece al restaurante
        const [existing] = await db
            .select()
            .from(ZonaDeliveryTable)
            .where(and(eq(ZonaDeliveryTable.id, zonaId), eq(ZonaDeliveryTable.restauranteId, restauranteId)))

        if (!existing) {
            return c.json({ success: false, message: 'Zona no encontrada' }, 404)
        }

        const updateData: { [key: string]: any } = {}
        if (nombre !== undefined) updateData.nombre = nombre
        if (precio !== undefined) updateData.precio = precio
        if (poligono !== undefined) updateData.poligono = poligono
        if (color !== undefined) updateData.color = color

        if (Object.keys(updateData).length === 0) {
            return c.json({ success: false, message: 'No hay datos para actualizar' }, 400)
        }

        await db
            .update(ZonaDeliveryTable)
            .set(updateData)
            .where(eq(ZonaDeliveryTable.id, zonaId))

        // Fetch updated zona
        const [updated] = await db
            .select()
            .from(ZonaDeliveryTable)
            .where(eq(ZonaDeliveryTable.id, zonaId))

        return c.json({ success: true, data: updated, message: 'Zona actualizada exitosamente' }, 200)
    } catch (error) {
        console.error('Error updating zona de delivery:', error)
        return c.json({ success: false, message: 'Error al actualizar zona de delivery' }, 500)
    }
})

// DELETE /zona-delivery/:id - Eliminar una zona
zonaDeliveryRoute.delete('/:id', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const zonaId = parseInt(c.req.param('id'), 10)

    if (isNaN(zonaId)) {
        return c.json({ success: false, message: 'ID de zona inválido' }, 400)
    }

    try {
        // Verificar que la zona pertenece al restaurante
        const [existing] = await db
            .select()
            .from(ZonaDeliveryTable)
            .where(and(eq(ZonaDeliveryTable.id, zonaId), eq(ZonaDeliveryTable.restauranteId, restauranteId)))

        if (!existing) {
            return c.json({ success: false, message: 'Zona no encontrada' }, 404)
        }

        await db
            .delete(ZonaDeliveryTable)
            .where(eq(ZonaDeliveryTable.id, zonaId))

        return c.json({ success: true, message: 'Zona eliminada exitosamente' }, 200)
    } catch (error) {
        console.error('Error deleting zona de delivery:', error)
        return c.json({ success: false, message: 'Error al eliminar zona de delivery' }, 500)
    }
})

export { zonaDeliveryRoute }
