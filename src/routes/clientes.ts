import { Hono } from 'hono'
import { pool } from '../db'
import {
    cliente as ClienteTable,
    pedidoDelivery as PedidoDeliveryTable,
    pedidoTakeaway as PedidoTakeawayTable,
    itemPedidoDelivery as ItemDeliveryTable,
    itemPedidoTakeaway as ItemTakeawayTable,
    producto as ProductoTable
} from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, desc, inArray } from 'drizzle-orm'

const clientesRoute = new Hono()

clientesRoute.use('*', authMiddleware)

clientesRoute.get('/list', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id

    try {
        const clientes = await db.select().from(ClienteTable).where(eq(ClienteTable.restauranteId, restauranteId)).orderBy(desc(ClienteTable.createdAt))

        const pedidosDelivery = await db.select({
            clienteId: PedidoDeliveryTable.clienteId,
            total: PedidoDeliveryTable.total,
            createdAt: PedidoDeliveryTable.createdAt,
            id: PedidoDeliveryTable.id,
        }).from(PedidoDeliveryTable)
            .where(eq(PedidoDeliveryTable.restauranteId, restauranteId))

        const pedidosTakeaway = await db.select({
            clienteId: PedidoTakeawayTable.clienteId,
            total: PedidoTakeawayTable.total,
            createdAt: PedidoTakeawayTable.createdAt,
            id: PedidoTakeawayTable.id,
        }).from(PedidoTakeawayTable)
            .where(eq(PedidoTakeawayTable.restauranteId, restauranteId))

        // Fetch items for delivery orders
        const deliveryIds = pedidosDelivery.map(p => p.id)
        let itemsDelivery: { pedidoDeliveryId: number, productoId: number, cantidad: number | null, precioUnitario: string }[] = []
        if (deliveryIds.length > 0) {
            itemsDelivery = await db.select({
                pedidoDeliveryId: ItemDeliveryTable.pedidoDeliveryId,
                productoId: ItemDeliveryTable.productoId,
                cantidad: ItemDeliveryTable.cantidad,
                precioUnitario: ItemDeliveryTable.precioUnitario,
            }).from(ItemDeliveryTable)
                .where(inArray(ItemDeliveryTable.pedidoDeliveryId, deliveryIds))
        }

        // Fetch items for takeaway orders
        const takeawayIds = pedidosTakeaway.map(p => p.id)
        let itemsTakeaway: { pedidoTakeawayId: number, productoId: number, cantidad: number | null, precioUnitario: string }[] = []
        if (takeawayIds.length > 0) {
            itemsTakeaway = await db.select({
                pedidoTakeawayId: ItemTakeawayTable.pedidoTakeawayId,
                productoId: ItemTakeawayTable.productoId,
                cantidad: ItemTakeawayTable.cantidad,
                precioUnitario: ItemTakeawayTable.precioUnitario,
            }).from(ItemTakeawayTable)
                .where(inArray(ItemTakeawayTable.pedidoTakeawayId, takeawayIds))
        }

        // Fetch product names
        const allProductoIds = [
            ...new Set([
                ...itemsDelivery.map(i => i.productoId),
                ...itemsTakeaway.map(i => i.productoId)
            ])
        ]
        let productosMap: Record<number, string> = {}
        if (allProductoIds.length > 0) {
            const productos = await db.select({
                id: ProductoTable.id,
                nombre: ProductoTable.nombre,
            }).from(ProductoTable)
                .where(inArray(ProductoTable.id, allProductoIds))
            productosMap = Object.fromEntries(productos.map(p => [p.id, p.nombre]))
        }

        // Build items map per delivery order
        const deliveryItemsMap: Record<number, { nombreProducto: string, cantidad: number, precioUnitario: string }[]> = {}
        for (const item of itemsDelivery) {
            if (!deliveryItemsMap[item.pedidoDeliveryId]) deliveryItemsMap[item.pedidoDeliveryId] = []
            deliveryItemsMap[item.pedidoDeliveryId].push({
                nombreProducto: productosMap[item.productoId] || 'Producto eliminado',
                cantidad: item.cantidad ?? 1,
                precioUnitario: item.precioUnitario,
            })
        }

        // Build items map per takeaway order
        const takeawayItemsMap: Record<number, { nombreProducto: string, cantidad: number, precioUnitario: string }[]> = {}
        for (const item of itemsTakeaway) {
            if (!takeawayItemsMap[item.pedidoTakeawayId]) takeawayItemsMap[item.pedidoTakeawayId] = []
            takeawayItemsMap[item.pedidoTakeawayId].push({
                nombreProducto: productosMap[item.productoId] || 'Producto eliminado',
                cantidad: item.cantidad ?? 1,
                precioUnitario: item.precioUnitario,
            })
        }

        const allPedidos = [
            ...pedidosDelivery.map(p => ({
                ...p,
                tipo: 'delivery' as const,
                items: deliveryItemsMap[p.id] || []
            })),
            ...pedidosTakeaway.map(p => ({
                ...p,
                tipo: 'takeaway' as const,
                items: takeawayItemsMap[p.id] || []
            }))
        ]

        const clientesConMetricas = clientes.map(cliente => {
            const clientPedidos = allPedidos.filter(p => p.clienteId === cliente.id)
            const cantidadPedidos = clientPedidos.length
            const totalGastado = clientPedidos.reduce((acc, current) => acc + parseFloat(current.total || '0'), 0)

            let ultimoPedidoAt: Date | null = null;
            if (clientPedidos.length > 0) {
                const dates = clientPedidos.map(p => new Date(p.createdAt));
                ultimoPedidoAt = new Date(Math.max(...dates.map(Number)));
            }

            return {
                ...cliente,
                cantidadPedidos,
                totalGastado,
                ultimoPedidoAt,
                pedidos: clientPedidos.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            }
        })

        return c.json({
            message: 'Clientes obtenidos correctamente',
            success: true,
            data: clientesConMetricas
        }, 200)

    } catch (error) {
        console.error('Error fetching clientes:', error)
        return c.json({ message: 'Error interno del servidor', success: false }, 500)
    }
})

export { clientesRoute }
