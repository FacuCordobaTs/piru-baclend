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
import { requireModulo } from '../middleware/modulo'
import { MODULE_KEYS } from '../lib/modulos'
import { eq, desc, inArray, notInArray, and } from 'drizzle-orm'
import { computarPerfilesRFM } from '../lib/clientes-rfm'
import { deduplicarPedidosHistorial } from '../lib/clientes-historial'
import {
    cargarToquesPorCliente, estadoRecupero, enviarRecuperoDormido,
} from '../lib/recupero'
import {
    estadoMotor, activarMotor, pausarMotorManual, reanudarMotor, setCupoDiario,
    registrarContactoManual, CUPO_DIARIO_MIN, CUPO_DIARIO_MAX,
} from '../lib/motor-recompra'

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
            .where(and(
                eq(PedidoUnificadoTable.restauranteId, restauranteId),
                // Los pedidos por WhatsApp pueden ser válidos aunque no tengan pago online.
                notInArray(PedidoUnificadoTable.estado, ['cancelled']),
            ))

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
            tipo: p.tipo as 'delivery' | 'takeaway' | 'mesa',
            items: itemsMap[p.id] || []
        }))

        // 7. Calcular métricas base + agrupar pedidos por cliente
        const base = clientes.map(cliente => {
            const clientPedidos = deduplicarPedidosHistorial(
                allPedidos.filter(p => p.clienteId === cliente.id),
            )
            const cantidadPedidos = clientPedidos.length
            const totalGastado = clientPedidos.reduce((acc, current) => acc + parseFloat(current.total || '0'), 0)

            const fechasMs = clientPedidos.map(p => new Date(p.createdAt).getTime())
            const ultimoPedidoAt = fechasMs.length > 0 ? new Date(Math.max(...fechasMs)) : null
            const primerPedidoAt = fechasMs.length > 0 ? new Date(Math.min(...fechasMs)) : null

            // Productos más pedidos (por cantidad total) — top 3.
            const productosCount: Record<string, number> = {}
            for (const ped of clientPedidos) {
                for (const it of ped.items) {
                    productosCount[it.nombreProducto] = (productosCount[it.nombreProducto] || 0) + it.cantidad
                }
            }
            const productosTop = Object.entries(productosCount)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([nombre, cantidad]) => ({ nombre, cantidad }))

            return {
                cliente,
                cantidadPedidos,
                totalGastado,
                fechasMs,
                ultimoPedidoAt,
                primerPedidoAt,
                productosTop,
                pedidos: clientPedidos,
            }
        })

        // 8. Cerebro RFM: cadencia individual + estado de ciclo de vida (nuevo/activo/vip/en_riesgo/dormido/perdido).
        //    Se calcula en batch porque la cadencia global y el umbral VIP dependen de todo el local.
        const perfiles = computarPerfilesRFM(
            base.map(b => ({
                cantidadPedidos: b.cantidadPedidos,
                totalGastado: b.totalGastado,
                fechasPedidos: b.fechasMs,
            })),
        )

        // Estado de la escalera de recupero por cliente (Motor de Recompra · 4.2). Un fetch para todos.
        const toquesPorCliente = await cargarToquesPorCliente(db, restauranteId, clientes.map(cl => cl.id))

        const clientesConMetricas = base.map((b, i) => {
            const perfil = perfiles[i]
            const ultimoPedidoMs = b.fechasMs.length > 0 ? Math.max(...b.fechasMs) : null
            const recupero = estadoRecupero(toquesPorCliente[b.cliente.id] ?? [], ultimoPedidoMs)
            return {
                ...b.cliente,
                cantidadPedidos: b.cantidadPedidos,
                totalGastado: b.totalGastado,
                ultimoPedidoAt: b.ultimoPedidoAt ? b.ultimoPedidoAt.toISOString() : null,
                // ── Campos nuevos (Motor de Recompra · 4.1). Aditivos: los admin viejos los ignoran.
                primerPedidoAt: b.primerPedidoAt ? b.primerPedidoAt.toISOString() : null,
                ticketPromedio: perfil.ticketPromedio,
                cadenciaDias: perfil.cadenciaDias,
                diasDesdeUltimo: perfil.diasDesdeUltimo,
                segmento: perfil.segmento,
                esVip: perfil.esVip,
                resumenCadencia: perfil.resumenCadencia,
                productosTop: b.productosTop,
                // ── Estado de la escalera de recupero (Motor de Recompra · 4.2). También aditivo.
                recupero,
                pedidos: b.pedidos,
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

/**
 * POST /clientes/:id/recupero — Playbook de recupero de dormidos (Motor de Recompra · 4.2).
 * Acción VOLUNTARIA del local: manda el próximo toque de la escalera de incentivos al cliente.
 * Gateado por el módulo Motor de Recompra. Consume el bucket `marketing` del wallet.
 */
clientesRoute.post('/:id/recupero', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const clienteId = parseInt(c.req.param('id'), 10)

    if (isNaN(clienteId)) {
        return c.json({ success: false, message: 'ID inválido' }, 400)
    }

    try {
        const resultado = await enviarRecuperoDormido(c, db, restauranteId, clienteId)

        if (!resultado.ok) {
            // 404 si el cliente no existe; 409 por barreras "no ahora" (cooldown + protección de la
            // base: opt-out / tope mensual / horario de silencio); 400 para el resto (config/envío).
            const bloqueos = ['cooldown', 'opt_out', 'tope_mensual', 'horario_silencio']
            const status = resultado.motivo === 'cliente_no_encontrado'
                ? 404
                : bloqueos.includes(resultado.motivo ?? '')
                    ? 409
                    : 400
            return c.json({ success: false, message: resultado.mensaje, motivo: resultado.motivo, estado: resultado.estado }, status)
        }

        // Atribución honesta: si el cliente estaba en el grupo de control de la campaña activa, este
        // contacto MANUAL lo saca del control y lo marca como contactado (mismo momento). Sin esto, si
        // vuelve, se contaría como "volvió solo" e inflaría la tasa del control → subestima el uplift.
        await registrarContactoManual(db, restauranteId, clienteId, {
            nivel: resultado.nivel,
            codigoDescuento: resultado.codigoDescuento,
        })

        return c.json({
            success: true,
            message: `Mensaje de recupero enviado (nivel ${resultado.nivel})`,
            data: {
                nivel: resultado.nivel,
                codigoDescuento: resultado.codigoDescuento,
                saldoMarketing: resultado.saldoMarketing,
                recupero: resultado.estado,
            },
        }, 200)
    } catch (error) {
        console.error('Error enviando recupero:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE RECOMPRA · GOTEO (piloto automático) — campaña persistente que gotea
// al ritmo del cupo diario. Todo gateado por el módulo Motor de Recompra.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /clientes/recompra/estado — la pantalla del motor:
 *  - apagado → un PLAN de activación (cohorte detectada + propuesta de cupo + días que cubre el saldo).
 *  - encendido → el DASHBOARD (consumo junto a retorno: contactados, volvieron, plata recuperada).
 */
clientesRoute.get('/recompra/estado', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        const estado = await estadoMotor(db, restauranteId)
        return c.json({ success: true, data: estado }, 200)
    } catch (error) {
        console.error('Error obteniendo estado del motor de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

/**
 * POST /clientes/recompra/activar — la DECISIÓN humana (una vez). Enciende el motor: detecta el stock,
 * aparta el 10% de control, carga la cola y dispara el primer goteo (respetando cupo/silencio).
 * Body opcional: { cupoDiario }.
 */
clientesRoute.post('/recompra/activar', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        const body = await c.req.json().catch(() => ({}))
        const cupoDiario = body?.cupoDiario != null ? Number(body.cupoDiario) : undefined
        const resultado = await activarMotor(db, restauranteId, cupoDiario)
        return c.json({
            success: true,
            message: resultado.yaActiva
                ? 'El motor ya estaba encendido'
                : resultado.vacio
                    ? 'No hay clientes para recuperar en este momento'
                    : 'Motor de recompra encendido',
            data: resultado,
        }, 200)
    } catch (error) {
        console.error('Error activando motor de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

/** POST /clientes/recompra/pausar — Pausar (siempre disponible). No se pierde nada: la cola queda. */
clientesRoute.post('/recompra/pausar', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        const ok = await pausarMotorManual(db, restauranteId)
        if (!ok) return c.json({ success: false, message: 'No hay una campaña activa' }, 404)
        return c.json({ success: true, message: 'Motor pausado' }, 200)
    } catch (error) {
        console.error('Error pausando motor de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

/** POST /clientes/recompra/reanudar — vuelve a gotear desde donde quedó. */
clientesRoute.post('/recompra/reanudar', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        const ok = await reanudarMotor(db, restauranteId)
        if (!ok) return c.json({ success: false, message: 'No hay una campaña para reanudar' }, 404)
        return c.json({ success: true, message: 'Motor reanudado' }, 200)
    } catch (error) {
        console.error('Error reanudando motor de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

/** PUT /clientes/recompra/config — ajusta el cupo diario (acotado al tope duro de sistema). */
clientesRoute.put('/recompra/config', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        const body = await c.req.json().catch(() => ({}))
        const cupoDiario = Number(body?.cupoDiario)
        if (!Number.isFinite(cupoDiario)) {
            return c.json({ success: false, message: 'cupoDiario inválido' }, 400)
        }
        const aplicado = await setCupoDiario(db, restauranteId, cupoDiario)
        if (aplicado == null) return c.json({ success: false, message: 'No hay una campaña activa' }, 404)
        return c.json({
            success: true,
            message: 'Cupo actualizado',
            data: { cupoDiario: aplicado, min: CUPO_DIARIO_MIN, max: CUPO_DIARIO_MAX },
        }, 200)
    } catch (error) {
        console.error('Error configurando motor de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

export { clientesRoute }
