import { Hono } from 'hono'
import { pool } from '../db'
import { restaurante as RestauranteTable, producto as ProductoTable, categoria as CategoriaTable, etiqueta as EtiquetaTable, productoIngrediente as ProductoIngredienteTable, ingrediente as IngredienteTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and } from 'drizzle-orm'
import { wsManager } from '../websocket/manager'

const publicRoute = new Hono()

publicRoute.get('/restaurante/:username', async (c) => {
    const db = drizzle(pool)
    const username = c.req.param('username')

    try {
        const restaurante = await db.select({
            id: RestauranteTable.id,
            nombre: RestauranteTable.nombre,
            imagenUrl: RestauranteTable.imagenUrl,
            direccion: RestauranteTable.direccion,
            telefono: RestauranteTable.telefono,
            deliveryFee: RestauranteTable.deliveryFee,
            cucuruAlias: RestauranteTable.cucuruAlias,
            cucuruEnabled: RestauranteTable.cucuruEnabled,
        })
            .from(RestauranteTable)
            .where(eq(RestauranteTable.username, username))
            .limit(1)

        if (!restaurante || restaurante.length === 0) {
            return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
        }

        const restauranteId = restaurante[0].id

        // Obtener productos activos con categoría
        const productosRaw = await db
            .select({
                id: ProductoTable.id,
                restauranteId: ProductoTable.restauranteId,
                categoriaId: ProductoTable.categoriaId,
                nombre: ProductoTable.nombre,
                descripcion: ProductoTable.descripcion,
                precio: ProductoTable.precio,
                activo: ProductoTable.activo,
                imagenUrl: ProductoTable.imagenUrl,
                createdAt: ProductoTable.createdAt,
                categoria: {
                    id: CategoriaTable.id,
                    nombre: CategoriaTable.nombre,
                }
            })
            .from(ProductoTable)
            .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
            .where(and(eq(ProductoTable.restauranteId, restauranteId), eq(ProductoTable.activo, true)))

        // Obtener ingredientes para cada producto
        const productosConIngredientes = await Promise.all(
            productosRaw.map(async (p) => {
                const ingredientes = await db
                    .select({
                        id: IngredienteTable.id,
                        nombre: IngredienteTable.nombre,
                    })
                    .from(ProductoIngredienteTable)
                    .innerJoin(IngredienteTable, eq(ProductoIngredienteTable.ingredienteId, IngredienteTable.id))
                    .where(eq(ProductoIngredienteTable.productoId, p.id))

                return {
                    ...p,
                    categoria: p.categoria?.nombre || null,
                    ingredientes: ingredientes,
                }
            })
        )

        return c.json({
            message: 'Datos obtenidos correctamente',
            success: true,
            data: {
                restaurante: restaurante[0],
                productos: productosConIngredientes
            }
        }, 200)

    } catch (error) {
        console.error('Error getting public restaurant profile:', error)
        return c.json({ message: 'Error getting profile', error: (error as Error).message }, 500)
    }
})

import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { pedidoDelivery as PedidoDeliveryTable, itemPedidoDelivery as ItemPedidoDeliveryTable, pedidoTakeaway as PedidoTakeawayTable, itemPedidoTakeaway as ItemPedidoTakeawayTable, cliente as ClienteTable } from '../db/schema'

const createDeliverySchema = z.object({
    restauranteId: z.number().int().positive(),
    direccion: z.string().min(5),
    nombreCliente: z.string().optional(),
    telefono: z.string().optional(),
    notas: z.string().optional(),
    items: z.array(z.object({
        productoId: z.number().int().positive(),
        cantidad: z.number().int().positive().default(1),
        ingredientesExcluidos: z.array(z.number().int().positive()).optional()
    })).min(1)
})

publicRoute.post('/delivery/create', zValidator('json', createDeliverySchema), async (c) => {
    const db = drizzle(pool)
    const { restauranteId, direccion, nombreCliente, telefono, notas, items } = c.req.valid('json')

    try {
        const productosIds = items.map(i => i.productoId)
        const productos = await db
            .select()
            .from(ProductoTable)
            .where(and(
                require('drizzle-orm').inArray(ProductoTable.id, productosIds),
                eq(ProductoTable.restauranteId, restauranteId)
            ))

        if (productos.length !== productosIds.length) {
            return c.json({ message: 'Algunos productos no fueron encontrados', success: false }, 400)
        }

        const productosMap = new Map(productos.map(p => [p.id, p]))

        let total = 0
        for (const item of items) {
            const producto = productosMap.get(item.productoId)!
            total += parseFloat(producto.precio) * item.cantidad
        }

        const resRestaurante = await db.select({ deliveryFee: RestauranteTable.deliveryFee }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1)
        if (resRestaurante.length > 0 && resRestaurante[0].deliveryFee) {
            total += parseFloat(resRestaurante[0].deliveryFee)
        }

        let clienteId: number | null = null;
        if (telefono && nombreCliente) {
            // Verificar si el cliente existe
            const clienteExistente = await db.select().from(ClienteTable).where(
                and(
                    eq(ClienteTable.telefono, telefono),
                    eq(ClienteTable.restauranteId, restauranteId)
                )
            ).limit(1);

            if (clienteExistente.length > 0) {
                clienteId = clienteExistente[0].id;
                // Actualizar dirección si es diferente (opcional)
            } else {
                const nuevoCliente = await db.insert(ClienteTable).values({
                    restauranteId,
                    nombre: nombreCliente,
                    telefono,
                    direccion,
                });
                clienteId = Number(nuevoCliente[0].insertId);
            }
        }

        const nuevoPedido = await db.insert(PedidoDeliveryTable).values({
            restauranteId,
            clienteId: clienteId || null,
            direccion,
            nombreCliente: nombreCliente || null,
            telefono: telefono || null,
            notas: notas || null,
            estado: 'pending',
            total: total.toFixed(2)
        })

        const pedidoId = Number(nuevoPedido[0].insertId)

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

        wsManager.notifyAdmins(restauranteId, {
            id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            tipo: 'NUEVO_PEDIDO',
            mesaId: 0,
            mesaNombre: 'Delivery',
            mensaje: `Nuevo pedido de Delivery`,
            detalles: `${nombreCliente || 'Cliente'} - $${total.toFixed(2)}`,
            timestamp: new Date().toISOString(),
            leida: false,
            pedidoId: pedidoId
        })
        wsManager.broadcastAdminUpdate(restauranteId, 'delivery')

        return c.json({
            message: 'Pedido de delivery creado correctamente',
            success: true,
            data: { id: pedidoId, direccion, nombreCliente, telefono, total: total.toFixed(2), estado: 'pending' }
        }, 201)
    } catch (error) {
        console.error('Error creating public delivery:', error)
        return c.json({ message: 'Error creating delivery', error: (error as Error).message }, 500)
    }
})

const createTakeawaySchema = z.object({
    restauranteId: z.number().int().positive(),
    nombreCliente: z.string().optional(),
    telefono: z.string().optional(),
    notas: z.string().optional(),
    items: z.array(z.object({
        productoId: z.number().int().positive(),
        cantidad: z.number().int().positive().default(1),
        ingredientesExcluidos: z.array(z.number().int().positive()).optional()
    })).min(1)
})

publicRoute.post('/takeaway/create', zValidator('json', createTakeawaySchema), async (c) => {
    const db = drizzle(pool)
    const { restauranteId, nombreCliente, telefono, notas, items } = c.req.valid('json')

    try {
        const productosIds = items.map(i => i.productoId)
        const productos = await db
            .select()
            .from(ProductoTable)
            .where(and(
                require('drizzle-orm').inArray(ProductoTable.id, productosIds),
                eq(ProductoTable.restauranteId, restauranteId)
            ))

        if (productos.length !== productosIds.length) {
            return c.json({ message: 'Algunos productos no fueron encontrados', success: false }, 400)
        }

        const productosMap = new Map(productos.map(p => [p.id, p]))

        let total = 0
        for (const item of items) {
            const producto = productosMap.get(item.productoId)!
            total += parseFloat(producto.precio) * item.cantidad
        }

        let clienteId: number | null = null;
        if (telefono && nombreCliente) {
            // Verificar si el cliente existe
            const clienteExistente = await db.select().from(ClienteTable).where(
                and(
                    eq(ClienteTable.telefono, telefono),
                    eq(ClienteTable.restauranteId, restauranteId)
                )
            ).limit(1);

            if (clienteExistente.length > 0) {
                clienteId = clienteExistente[0].id;
            } else {
                const nuevoCliente = await db.insert(ClienteTable).values({
                    restauranteId,
                    nombre: nombreCliente,
                    telefono,
                });
                clienteId = Number(nuevoCliente[0].insertId);
            }
        }

        const nuevoPedido = await db.insert(PedidoTakeawayTable).values({
            restauranteId,
            clienteId: clienteId || null,
            nombreCliente: nombreCliente || null,
            telefono: telefono || null,
            notas: notas || null,
            estado: 'pending',
            total: total.toFixed(2)
        })

        const pedidoId = Number(nuevoPedido[0].insertId)

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

        wsManager.notifyAdmins(restauranteId, {
            id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            tipo: 'NUEVO_PEDIDO',
            mesaId: 0,
            mesaNombre: 'Take Away',
            mensaje: `Nuevo pedido de Take Away`,
            detalles: `${nombreCliente || 'Cliente'} - $${total.toFixed(2)}`,
            timestamp: new Date().toISOString(),
            leida: false,
            pedidoId: pedidoId
        })
        wsManager.broadcastAdminUpdate(restauranteId, 'takeaway')

        return c.json({
            message: 'Pedido de takeaway creado correctamente',
            success: true,
            data: { id: pedidoId, nombreCliente, telefono, total: total.toFixed(2), estado: 'pending' }
        }, 201)
    } catch (error) {
        console.error('Error creating public takeaway:', error)
        return c.json({ message: 'Error creating takeaway', error: (error as Error).message }, 500)
    }
})

export { publicRoute }
