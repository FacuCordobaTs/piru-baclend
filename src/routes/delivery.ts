// delivery.ts - Rutas para pedidos de delivery
import { Hono } from 'hono'
import { pool } from '../db'
import {
    pedidoDelivery as PedidoDeliveryTable,
    itemPedidoDelivery as ItemPedidoDeliveryTable,
    producto as ProductoTable,
    ingrediente as IngredienteTable
} from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, desc, and, inArray } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

// Schemas de validación
const createDeliverySchema = z.object({
    direccion: z.string().min(5, 'La dirección es requerida'),
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

const deliveryRoute = new Hono()

    .use('*', authMiddleware)

    // Obtener todos los pedidos de delivery del restaurante con paginación
    .get('/list', async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const page = Number(c.req.query('page')) || 1
        const limit = Number(c.req.query('limit')) || 20
        const estado = c.req.query('estado')
        const offset = (page - 1) * limit

        let whereCondition = eq(PedidoDeliveryTable.restauranteId, restauranteId)

        const pedidos = await db
            .select({
                id: PedidoDeliveryTable.id,
                direccion: PedidoDeliveryTable.direccion,
                nombreCliente: PedidoDeliveryTable.nombreCliente,
                telefono: PedidoDeliveryTable.telefono,
                estado: PedidoDeliveryTable.estado,
                total: PedidoDeliveryTable.total,
                notas: PedidoDeliveryTable.notas,
                createdAt: PedidoDeliveryTable.createdAt,
                deliveredAt: PedidoDeliveryTable.deliveredAt,
                pagado: PedidoDeliveryTable.pagado,
            })
            .from(PedidoDeliveryTable)
            .where(estado
                ? and(whereCondition, eq(PedidoDeliveryTable.estado, estado as any))
                : whereCondition
            )
            .orderBy(desc(PedidoDeliveryTable.createdAt))
            .limit(limit)
            .offset(offset)

        // Para cada pedido, obtener los items
        const pedidosConItems = await Promise.all(pedidos.map(async (pedido) => {
            const itemsRaw = await db
                .select({
                    id: ItemPedidoDeliveryTable.id,
                    productoId: ItemPedidoDeliveryTable.productoId,
                    cantidad: ItemPedidoDeliveryTable.cantidad,
                    precioUnitario: ItemPedidoDeliveryTable.precioUnitario,
                    nombreProducto: ProductoTable.nombre,
                    imagenUrl: ProductoTable.imagenUrl,
                    ingredientesExcluidos: ItemPedidoDeliveryTable.ingredientesExcluidos,
                })
                .from(ItemPedidoDeliveryTable)
                .leftJoin(ProductoTable, eq(ItemPedidoDeliveryTable.productoId, ProductoTable.id))
                .where(eq(ItemPedidoDeliveryTable.pedidoDeliveryId, pedido.id))

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
            message: 'Pedidos de delivery encontrados',
            success: true,
            data: pedidosConItems,
            pagination: {
                page,
                limit,
                hasMore: pedidos.length === limit
            }
        }, 200)
    })

    // Obtener un pedido de delivery específico
    .get('/:id', async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const pedidoId = Number(c.req.param('id'))

        const pedido = await db
            .select()
            .from(PedidoDeliveryTable)
            .where(and(
                eq(PedidoDeliveryTable.id, pedidoId),
                eq(PedidoDeliveryTable.restauranteId, restauranteId)
            ))
            .limit(1)

        if (!pedido || pedido.length === 0) {
            return c.json({ message: 'Pedido no encontrado', success: false }, 404)
        }

        // Obtener items
        const itemsRaw = await db
            .select({
                id: ItemPedidoDeliveryTable.id,
                productoId: ItemPedidoDeliveryTable.productoId,
                cantidad: ItemPedidoDeliveryTable.cantidad,
                precioUnitario: ItemPedidoDeliveryTable.precioUnitario,
                nombreProducto: ProductoTable.nombre,
                imagenUrl: ProductoTable.imagenUrl,
                ingredientesExcluidos: ItemPedidoDeliveryTable.ingredientesExcluidos,
            })
            .from(ItemPedidoDeliveryTable)
            .leftJoin(ProductoTable, eq(ItemPedidoDeliveryTable.productoId, ProductoTable.id))
            .where(eq(ItemPedidoDeliveryTable.pedidoDeliveryId, pedidoId))

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

    // Crear nuevo pedido de delivery
    .post('/create', zValidator('json', createDeliverySchema), async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const { direccion, nombreCliente, telefono, notas, items } = c.req.valid('json')

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
        const nuevoPedido = await db.insert(PedidoDeliveryTable).values({
            restauranteId,
            direccion,
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
            await db.insert(ItemPedidoDeliveryTable).values({
                pedidoDeliveryId: pedidoId,
                productoId: item.productoId,
                cantidad: item.cantidad,
                precioUnitario: producto.precio,
                ingredientesExcluidos: item.ingredientesExcluidos || null
            })
        }

        return c.json({
            message: 'Pedido de delivery creado correctamente',
            success: true,
            data: {
                id: pedidoId,
                direccion,
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
            .from(PedidoDeliveryTable)
            .where(and(
                eq(PedidoDeliveryTable.id, pedidoId),
                eq(PedidoDeliveryTable.restauranteId, restauranteId)
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
            .update(PedidoDeliveryTable)
            .set(updateData)
            .where(eq(PedidoDeliveryTable.id, pedidoId))

        return c.json({
            message: 'Estado actualizado correctamente',
            success: true
        }, 200)
    })

    // Marcar/desmarcar pedido como pagado
    .put('/:id/pagado', async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const pedidoId = Number(c.req.param('id'))

        // Verificar que el pedido pertenece al restaurante
        const pedido = await db
            .select()
            .from(PedidoDeliveryTable)
            .where(and(
                eq(PedidoDeliveryTable.id, pedidoId),
                eq(PedidoDeliveryTable.restauranteId, restauranteId)
            ))
            .limit(1)

        if (!pedido || pedido.length === 0) {
            return c.json({ message: 'Pedido no encontrado', success: false }, 404)
        }

        // Toggle pagado
        const body = await c.req.json().catch(() => ({}))
        const metodoPagoStr = body.metodoPago || null

        const newPagado = !pedido[0].pagado

        await db
            .update(PedidoDeliveryTable)
            .set({
                pagado: newPagado,
                metodoPago: newPagado ? metodoPagoStr : null
            })
            .where(eq(PedidoDeliveryTable.id, pedidoId))

        return c.json({
            message: newPagado ? 'Pedido marcado como pagado' : 'Pedido marcado como no pagado',
            success: true,
            data: { pagado: newPagado }
        }, 200)
    })

    // Eliminar pedido de delivery
    .delete('/:id', async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const pedidoId = Number(c.req.param('id'))

        // Verificar que el pedido pertenece al restaurante
        const pedido = await db
            .select()
            .from(PedidoDeliveryTable)
            .where(and(
                eq(PedidoDeliveryTable.id, pedidoId),
                eq(PedidoDeliveryTable.restauranteId, restauranteId)
            ))
            .limit(1)

        if (!pedido || pedido.length === 0) {
            return c.json({ message: 'Pedido no encontrado', success: false }, 404)
        }

        // Eliminar items primero
        await db
            .delete(ItemPedidoDeliveryTable)
            .where(eq(ItemPedidoDeliveryTable.pedidoDeliveryId, pedidoId))

        // Eliminar el pedido
        await db
            .delete(PedidoDeliveryTable)
            .where(eq(PedidoDeliveryTable.id, pedidoId))

        return c.json({
            message: 'Pedido eliminado correctamente',
            success: true
        }, 200)
    })

export { deliveryRoute }
