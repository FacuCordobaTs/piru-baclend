import { Hono } from 'hono'
import { pool } from '../db'
import { cliente as ClienteTable, pedidoDelivery as PedidoDeliveryTable, pedidoTakeaway as PedidoTakeawayTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, desc } from 'drizzle-orm'

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

        const allPedidos = [...pedidosDelivery.map(p => ({ ...p, tipo: 'delivery' })), ...pedidosTakeaway.map(p => ({ ...p, tipo: 'takeaway' }))]

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
