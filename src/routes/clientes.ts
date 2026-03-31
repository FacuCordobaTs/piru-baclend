import { Hono } from 'hono'
import { pool } from '../db'
import {
    cliente as ClienteTable,
    pedidoUnificado as PedidoUnificadoTable,
    itemPedidoUnificado as ItemPedidoUnificadoTable,
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
        // 1. Traer todos los clientes del restaurante
        const clientes = await db.select().from(ClienteTable)
            .where(eq(ClienteTable.restauranteId, restauranteId))
            .orderBy(desc(ClienteTable.createdAt))

        // 2. Traer todos los pedidos unificados del restaurante
        const pedidos = await db.select({
            id: PedidoUnificadoTable.id,
            clienteId: PedidoUnificadoTable.clienteId,
            total: PedidoUnificadoTable.total,
            createdAt: PedidoUnificadoTable.createdAt,
            tipo: PedidoUnificadoTable.tipo,
        }).from(PedidoUnificadoTable)
            .where(eq(PedidoUnificadoTable.restauranteId, restauranteId))

        // 3. Traer todos los items de esos pedidos
        const pedidoIds = pedidos.map(p => p.id)
        let itemsRaw: { pedidoId: number, productoId: number, cantidad: number | null, precioUnitario: string }[] = []
        
        if (pedidoIds.length > 0) {
            itemsRaw = await db.select({
                pedidoId: ItemPedidoUnificadoTable.pedidoId,
                productoId: ItemPedidoUnificadoTable.productoId,
                cantidad: ItemPedidoUnificadoTable.cantidad,
                precioUnitario: ItemPedidoUnificadoTable.precioUnitario,
            }).from(ItemPedidoUnificadoTable)
                .where(inArray(ItemPedidoUnificadoTable.pedidoId, pedidoIds))
        }

        // 4. Traer los nombres de los productos para los items
        const allProductoIds = [...new Set(itemsRaw.map(i => i.productoId))]
        let productosMap: Record<number, string> = {}
        
        if (allProductoIds.length > 0) {
            const productos = await db.select({
                id: ProductoTable.id,
                nombre: ProductoTable.nombre,
            }).from(ProductoTable)
                .where(inArray(ProductoTable.id, allProductoIds))
            productosMap = Object.fromEntries(productos.map(p => [p.id, p.nombre]))
        }

        // 5. Armar el mapa de items por pedido unificado
        const itemsMap: Record<number, { nombreProducto: string, cantidad: number, precioUnitario: string }[]> = {}
        for (const item of itemsRaw) {
            if (!itemsMap[item.pedidoId]) itemsMap[item.pedidoId] = []
            itemsMap[item.pedidoId].push({
                nombreProducto: productosMap[item.productoId] || 'Producto eliminado',
                cantidad: item.cantidad ?? 1,
                precioUnitario: item.precioUnitario,
            })
        }

        // 6. Ensamblar los pedidos con sus items
        const allPedidos = pedidos.map(p => ({
            ...p,
            // Casteamos el tipo explícitamente para que coincida con lo que espera el frontend
            tipo: p.tipo as 'delivery' | 'takeaway', 
            items: itemsMap[p.id] || []
        }))

        // 7. Calcular métricas para cada cliente
        const clientesConMetricas = clientes.map(cliente => {
            const clientPedidos = allPedidos.filter(p => p.clienteId === cliente.id)
            const cantidadPedidos = clientPedidos.length
            const totalGastado = clientPedidos.reduce((acc, current) => acc + parseFloat(current.total || '0'), 0)

            let ultimoPedidoAt: Date | null = null;
            if (clientPedidos.length > 0) {
                const dates = clientPedidos.map(p => new Date(p.createdAt).getTime());
                ultimoPedidoAt = new Date(Math.max(...dates));
            }

            return {
                ...cliente,
                cantidadPedidos,
                totalGastado,
                ultimoPedidoAt: ultimoPedidoAt ? ultimoPedidoAt.toISOString() : null,
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