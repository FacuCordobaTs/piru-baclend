// takeaway.ts - Rutas para pedidos take away
import { Hono } from 'hono'
import { pool } from '../db'
import {
    pedidoTakeaway as PedidoTakeawayTable,
    itemPedidoTakeaway as ItemPedidoTakeawayTable,
    producto as ProductoTable,
    ingrediente as IngredienteTable
} from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, desc, and, inArray } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

// Schemas de validación
const createTakeawaySchema = z.object({
    nombreCliente: z.string().optional(),
    telefono: z.string().optional(),
    notas: z.string().optional(),
    items: z.array(z.object({
        productoId: z.number().int().positive(),
        cantidad: z.number().int().positive().default(1),
        ingredientesExcluidos: z.array(z.number().int().positive()).optional()
    })).min(1, 'Debe agregar al menos un producto')
})

const updateEstadoSchema = z.object({
    estado: z.enum(['pending', 'preparing', 'ready', 'delivered', 'cancelled', 'archived'])
})

const takeawayRoute = new Hono()

    .use('*', authMiddleware)

    // Obtener todos los pedidos take away del restaurante con paginación
    .get('/list', async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const page = Number(c.req.query('page')) || 1
        const limit = Number(c.req.query('limit')) || 20
        const estado = c.req.query('estado')
        const offset = (page - 1) * limit

        let whereCondition = eq(PedidoTakeawayTable.restauranteId, restauranteId)

        const pedidos = await db
            .select({
                id: PedidoTakeawayTable.id,
                nombreCliente: PedidoTakeawayTable.nombreCliente,
                telefono: PedidoTakeawayTable.telefono,
                estado: PedidoTakeawayTable.estado,
                total: PedidoTakeawayTable.total,
                notas: PedidoTakeawayTable.notas,
                createdAt: PedidoTakeawayTable.createdAt,
                deliveredAt: PedidoTakeawayTable.deliveredAt,
            })
            .from(PedidoTakeawayTable)
            .where(estado
                ? and(whereCondition, eq(PedidoTakeawayTable.estado, estado as any))
                : whereCondition
            )
            .orderBy(desc(PedidoTakeawayTable.createdAt))
            .limit(limit)
            .offset(offset)

        // Para cada pedido, obtener los items
        const pedidosConItems = await Promise.all(pedidos.map(async (pedido) => {
            const itemsRaw = await db
                .select({
                    id: ItemPedidoTakeawayTable.id,
                    productoId: ItemPedidoTakeawayTable.productoId,
                    cantidad: ItemPedidoTakeawayTable.cantidad,
                    precioUnitario: ItemPedidoTakeawayTable.precioUnitario,
                    nombreProducto: ProductoTable.nombre,
                    imagenUrl: ProductoTable.imagenUrl,
                    ingredientesExcluidos: ItemPedidoTakeawayTable.ingredientesExcluidos,
                })
                .from(ItemPedidoTakeawayTable)
                .leftJoin(ProductoTable, eq(ItemPedidoTakeawayTable.productoId, ProductoTable.id))
                .where(eq(ItemPedidoTakeawayTable.pedidoTakeawayId, pedido.id))

            // Obtener nombres de ingredientes excluidos para cada item
            const items = await Promise.all(
                itemsRaw.map(async (item) => {
                    let ingredientesExcluidosNombres: string[] = []

                    if (item.ingredientesExcluidos && Array.isArray(item.ingredientesExcluidos) && item.ingredientesExcluidos.length > 0) {
                        const ingredientes = await db
                            .select({
                                id: IngredienteTable.id,
                                nombre: IngredienteTable.nombre,
                            })
                            .from(IngredienteTable)
                            .where(inArray(IngredienteTable.id, item.ingredientesExcluidos as number[]))

                        ingredientesExcluidosNombres = ingredientes.map(ing => ing.nombre)
                    }

                    return {
                        ...item,
                        ingredientesExcluidos: item.ingredientesExcluidos || [],
                        ingredientesExcluidosNombres,
                    }
                })
            )

            return {
                ...pedido,
                items,
                totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0)
            }
        }))

        return c.json({
            message: 'Pedidos take away encontrados',
            success: true,
            data: pedidosConItems,
            pagination: {
                page,
                limit,
                hasMore: pedidos.length === limit
            }
        }, 200)
    })

    // Obtener un pedido take away específico
    .get('/:id', async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const pedidoId = Number(c.req.param('id'))

        const pedido = await db
            .select()
            .from(PedidoTakeawayTable)
            .where(and(
                eq(PedidoTakeawayTable.id, pedidoId),
                eq(PedidoTakeawayTable.restauranteId, restauranteId)
            ))
            .limit(1)

        if (!pedido || pedido.length === 0) {
            return c.json({ message: 'Pedido no encontrado', success: false }, 404)
        }

        // Obtener items
        const itemsRaw = await db
            .select({
                id: ItemPedidoTakeawayTable.id,
                productoId: ItemPedidoTakeawayTable.productoId,
                cantidad: ItemPedidoTakeawayTable.cantidad,
                precioUnitario: ItemPedidoTakeawayTable.precioUnitario,
                nombreProducto: ProductoTable.nombre,
                imagenUrl: ProductoTable.imagenUrl,
                ingredientesExcluidos: ItemPedidoTakeawayTable.ingredientesExcluidos,
            })
            .from(ItemPedidoTakeawayTable)
            .leftJoin(ProductoTable, eq(ItemPedidoTakeawayTable.productoId, ProductoTable.id))
            .where(eq(ItemPedidoTakeawayTable.pedidoTakeawayId, pedidoId))

        return c.json({
            message: 'Pedido encontrado',
            success: true,
            data: {
                ...pedido[0],
                items: itemsRaw,
                totalItems: itemsRaw.reduce((sum, item) => sum + (item.cantidad || 1), 0)
            }
        }, 200)
    })

    // Crear nuevo pedido take away
    .post('/create', zValidator('json', createTakeawaySchema), async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const { nombreCliente, telefono, notas, items } = c.req.valid('json')

        // Verificar que todos los productos existen y obtener sus precios
        const productosIds = items.map(i => i.productoId)
        const productos = await db
            .select()
            .from(ProductoTable)
            .where(and(
                inArray(ProductoTable.id, productosIds),
                eq(ProductoTable.restauranteId, restauranteId)
            ))

        if (productos.length !== productosIds.length) {
            return c.json({ message: 'Algunos productos no fueron encontrados', success: false }, 400)
        }

        const productosMap = new Map(productos.map(p => [p.id, p]))

        // Calcular total
        let total = 0
        for (const item of items) {
            const producto = productosMap.get(item.productoId)!
            total += parseFloat(producto.precio) * item.cantidad
        }

        // Crear el pedido
        const nuevoPedido = await db.insert(PedidoTakeawayTable).values({
            restauranteId,
            nombreCliente: nombreCliente || null,
            telefono: telefono || null,
            notas: notas || null,
            estado: 'pending',
            total: total.toFixed(2)
        })

        const pedidoId = Number(nuevoPedido[0].insertId)

        // Crear los items
        for (const item of items) {
            const producto = productosMap.get(item.productoId)!
            await db.insert(ItemPedidoTakeawayTable).values({
                pedidoTakeawayId: pedidoId,
                productoId: item.productoId,
                cantidad: item.cantidad,
                precioUnitario: producto.precio,
                ingredientesExcluidos: item.ingredientesExcluidos || null
            })
        }

        return c.json({
            message: 'Pedido take away creado correctamente',
            success: true,
            data: {
                id: pedidoId,
                nombreCliente,
                telefono,
                total: total.toFixed(2),
                estado: 'pending'
            }
        }, 201)
    })

    // Actualizar estado del pedido
    .put('/:id/estado', zValidator('json', updateEstadoSchema), async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const pedidoId = Number(c.req.param('id'))
        const { estado } = c.req.valid('json')

        // Verificar que el pedido pertenece al restaurante
        const pedido = await db
            .select()
            .from(PedidoTakeawayTable)
            .where(and(
                eq(PedidoTakeawayTable.id, pedidoId),
                eq(PedidoTakeawayTable.restauranteId, restauranteId)
            ))
            .limit(1)

        if (!pedido || pedido.length === 0) {
            return c.json({ message: 'Pedido no encontrado', success: false }, 404)
        }

        // Actualizar estado
        const updateData: any = { estado }
        if (estado === 'delivered') {
            updateData.deliveredAt = new Date()
        }

        await db
            .update(PedidoTakeawayTable)
            .set(updateData)
            .where(eq(PedidoTakeawayTable.id, pedidoId))

        return c.json({
            message: 'Estado actualizado correctamente',
            success: true
        }, 200)
    })

    // Eliminar pedido take away
    .delete('/:id', async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const pedidoId = Number(c.req.param('id'))

        // Verificar que el pedido pertenece al restaurante
        const pedido = await db
            .select()
            .from(PedidoTakeawayTable)
            .where(and(
                eq(PedidoTakeawayTable.id, pedidoId),
                eq(PedidoTakeawayTable.restauranteId, restauranteId)
            ))
            .limit(1)

        if (!pedido || pedido.length === 0) {
            return c.json({ message: 'Pedido no encontrado', success: false }, 404)
        }

        // Eliminar items primero
        await db
            .delete(ItemPedidoTakeawayTable)
            .where(eq(ItemPedidoTakeawayTable.pedidoTakeawayId, pedidoId))

        // Eliminar el pedido
        await db
            .delete(PedidoTakeawayTable)
            .where(eq(PedidoTakeawayTable.id, pedidoId))

        return c.json({
            message: 'Pedido eliminado correctamente',
            success: true
        }, 200)
    })

export { takeawayRoute }
