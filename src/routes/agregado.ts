import { Hono } from 'hono'
import { pool } from '../db'
import { agregado as AgregadoTable, productoAgregado as ProductoAgregadoTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, inArray } from 'drizzle-orm'

const createAgregadoSchema = z.object({
    nombre: z.string().min(1).max(255),
    precio: z.number().min(0).default(0),
})

const agregadoRoute = new Hono()

    .use('*', authMiddleware)

    // Obtener todos los agregados del restaurante
    .get('/', async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id

        const agregados = await db
            .select()
            .from(AgregadoTable)
            .where(eq(AgregadoTable.restauranteId, restauranteId))
            .orderBy(AgregadoTable.nombre)

        return c.json({
            message: 'Agregados obtenidos correctamente',
            success: true,
            agregados
        }, 200)
    })

    // Crear nuevo agregado
    .post('/create', zValidator('json', createAgregadoSchema), async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const { nombre, precio } = c.req.valid('json')

        const result = await db.insert(AgregadoTable).values({
            nombre: nombre.trim(),
            precio: precio.toString(),
            restauranteId,
        })

        return c.json({
            message: 'Agregado creado correctamente',
            success: true,
            data: { id: Number(result[0].insertId), nombre, precio: precio.toString(), restauranteId }
        }, 201)
    })

    // Eliminar agregado
    .delete('/:id', async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const id = Number(c.req.param('id'))

        // Verificar que el agregado pertenece al restaurante
        const agregado = await db
            .select()
            .from(AgregadoTable)
            .where(and(
                eq(AgregadoTable.id, id),
                eq(AgregadoTable.restauranteId, restauranteId)
            ))
            .limit(1)

        if (!agregado || agregado.length === 0) {
            return c.json({ message: 'Agregado no encontrado', success: false }, 404)
        }

        // Eliminar relaciones con productos primero
        await db
            .delete(ProductoAgregadoTable)
            .where(eq(ProductoAgregadoTable.agregadoId, id))

        // Eliminar agregado
        await db
            .delete(AgregadoTable)
            .where(and(
                eq(AgregadoTable.id, id),
                eq(AgregadoTable.restauranteId, restauranteId)
            ))

        return c.json({
            message: 'Agregado eliminado correctamente',
            success: true
        }, 200)
    })

    // Obtener agregados de un producto
    .get('/producto/:productoId', async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const productoId = Number(c.req.param('productoId'))

        // Verificar que el producto pertenece al restaurante
        const { producto: ProductoTable } = await import('../db/schema')
        const producto = await db
            .select()
            .from(ProductoTable)
            .where(and(
                eq(ProductoTable.id, productoId),
                eq(ProductoTable.restauranteId, restauranteId)
            ))
            .limit(1)

        if (!producto || producto.length === 0) {
            return c.json({ message: 'Producto no encontrado', success: false }, 404)
        }

        // Obtener agregados del producto
        const agregados = await db
            .select({
                id: AgregadoTable.id,
                nombre: AgregadoTable.nombre,
                precio: AgregadoTable.precio,
            })
            .from(ProductoAgregadoTable)
            .innerJoin(AgregadoTable, eq(ProductoAgregadoTable.agregadoId, AgregadoTable.id))
            .where(eq(ProductoAgregadoTable.productoId, productoId))

        return c.json({
            message: 'Agregados obtenidos correctamente',
            success: true,
            agregados
        }, 200)
    })

    // Asociar agregados a un producto (usado en dashboard pero también se maneja en producto.ts directamente muchas veces, lo dejamos por si acaso)
    .post('/producto/:productoId', zValidator('json', z.object({
        agregadoIds: z.array(z.number().int().positive())
    })), async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const productoId = Number(c.req.param('productoId'))
        const { agregadoIds } = c.req.valid('json')

        // Verificar que el producto pertenece al restaurante
        const { producto: ProductoTable } = await import('../db/schema')
        const producto = await db
            .select()
            .from(ProductoTable)
            .where(and(
                eq(ProductoTable.id, productoId),
                eq(ProductoTable.restauranteId, restauranteId)
            ))
            .limit(1)

        if (!producto || producto.length === 0) {
            return c.json({ message: 'Producto no encontrado', success: false }, 404)
        }

        // Verificar que todos los agregados pertenecen al restaurante
        if (agregadoIds.length > 0) {
            const agregados = await db
                .select()
                .from(AgregadoTable)
                .where(and(
                    inArray(AgregadoTable.id, agregadoIds),
                    eq(AgregadoTable.restauranteId, restauranteId)
                ))

            if (agregados.length !== agregadoIds.length) {
                return c.json({
                    message: 'Algunos agregados no pertenecen al restaurante',
                    success: false
                }, 400)
            }
        }

        // Eliminar relaciones existentes
        await db
            .delete(ProductoAgregadoTable)
            .where(eq(ProductoAgregadoTable.productoId, productoId))

        // Crear nuevas relaciones
        if (agregadoIds.length > 0) {
            await db.insert(ProductoAgregadoTable).values(
                agregadoIds.map(agregadoId => ({
                    productoId,
                    agregadoId,
                }))
            )
        }

        return c.json({
            message: 'Agregados asociados correctamente',
            success: true
        }, 200)
    })

export { agregadoRoute }
