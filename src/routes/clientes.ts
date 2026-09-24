import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { pool } from '../db'
import {
    cliente as ClienteTable,
    pedidoUnificado as PedidoUnificadoTable,
    itemPedidoUnificado as ItemPedidoUnificadoTable,
    producto as ProductoTable,
    mensajeWhatsapp as MensajeWhatsappTable,
    whatsappConversacion as WhatsappConversacionTable,
    pago as PagoTable,
    recuperoCliente as RecuperoClienteTable,
    campanaRecompraCliente as CampanaRecompraClienteTable,
    colaRecompra as ColaRecompraTable,
    pedidoDelivery as PedidoDeliveryTable,
    itemPedidoDelivery as ItemPedidoDeliveryTable,
    pedidoTakeaway as PedidoTakeawayTable,
    itemPedidoTakeaway as ItemPedidoTakeawayTable,
    marketingCampana as MarketingCampanaTable,
    marketingEnlace as MarketingEnlaceTable,
    marketingContacto as MarketingContactoTable,
    pedidoMarketingAtribucion as PedidoMarketingAtribucionTable,
    codigoDescuento as CodigoDescuentoTable,
} from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { columnasIndiceCliente, normalizarTelefonoCliente } from '../lib/clientes-identidad'
import { requirePosConsulta } from '../middleware/pos-evento'
import { requireModulo } from '../middleware/modulo'
import { MODULE_KEYS } from '../lib/modulos'
import { eq, desc, inArray, notInArray, and } from 'drizzle-orm'
import { computarPerfilesRFM } from '../lib/clientes-rfm'
import { deduplicarPedidosHistorial } from '../lib/clientes-historial'
import {
    cargarToquesPorCliente, estadoRecupero, enviarRecuperoDormido,
} from '../lib/recupero'
import { decisionesRecetaSchema, opcionesDeDecisiones } from '../lib/recompra-decisiones'
import {
    estadoMotor, pausarMotorManual, reanudarMotor, setModoMotor, guardarConfigMotor,
    programarEnvios, previewProgramacion, listarProgramaciones, cancelarProgramacion,
    listarClientesRecompra, listarColaRecompra, listarHistorialRecompra,
    obtenerMensajeFilaCola, marcarFilaColaComoEnviadaManual,
    registrarContactoManual, registrarFalloContactoManual, CUPO_DIARIO_MIN, CUPO_DIARIO_MAX,
} from '../lib/motor-recompra'
import {
    CANTIDAD_MAX, CANTIDAD_MIN, PORCENTAJE_CONTROL_MAX, PORCENTAJE_CONTROL_MIN, SEGMENTOS_PROGRAMABLES,
} from '../lib/recompra-programacion'
import { DIAS_ENTRE_TOQUES_MIN } from '../lib/recompra-goteo'
import { emitirEventoPedido } from '../lib/pedidos-activos'
import { resolverOportunidadesMarketing } from '../lib/marketing-oportunidades'
import { resolverDatosGrowthClientes } from '../lib/clientes-growth'

const clientesRoute = new Hono()

async function borrarPedidosUnificados(tx: any, restauranteId: number, pedidoIds: number[]) {
    if (pedidoIds.length === 0) return

    // `pago` y el ledger de mensajes no tienen FK estricta. El comprobante de pago
    // sí corresponde borrarlo; el ledger se conserva como auditoría financiera.
    await tx.delete(PagoTable).where(inArray(PagoTable.pedidoUnificadoId, pedidoIds))
    await tx.delete(ItemPedidoUnificadoTable).where(inArray(ItemPedidoUnificadoTable.pedidoId, pedidoIds))
    await tx.delete(MensajeWhatsappTable).where(and(
        eq(MensajeWhatsappTable.restauranteId, restauranteId),
        inArray(MensajeWhatsappTable.pedidoUnificadoId, pedidoIds),
    ))
    await tx.update(WhatsappConversacionTable)
        .set({ pedidoUnificadoId: null })
        .where(and(
            eq(WhatsappConversacionTable.restauranteId, restauranteId),
            inArray(WhatsappConversacionTable.pedidoUnificadoId, pedidoIds),
        ))
    await tx.delete(PedidoUnificadoTable).where(and(
        eq(PedidoUnificadoTable.restauranteId, restauranteId),
        inArray(PedidoUnificadoTable.id, pedidoIds),
    ))
}

clientesRoute.use('*', authMiddleware)

clientesRoute.get('/indice-pos', requirePosConsulta, async (c) => {
    const inicio = performance.now()
    const restauranteId = Number((c as any).user.id)
    const data = await drizzle(pool).select(columnasIndiceCliente).from(ClienteTable)
        .where(eq(ClienteTable.restauranteId, restauranteId))
    c.header('Cache-Control', 'private, no-store')
    console.info('[pos_indice]', { restauranteId, filas: data.length, duracionMs: Math.round(performance.now() - inicio) })
    return c.json({ success: true, data })
})

clientesRoute.get('/list', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const soloDespachados = c.req.query('soloDespachados') === 'true'

    try {
        // 1. Traer todos los clientes del restaurante
        const clientes = await db.select().from(ClienteTable)
            .where(eq(ClienteTable.restauranteId, restauranteId))
            .orderBy(desc(ClienteTable.createdAt))

        // La pantalla actual de Clientes solicita sólo ventas completadas. El
        // default anterior se conserva para admins instalados que todavía no
        // envían el query param. En el Dashboard, "Despachar" lleva a `archived`.
        const pedidos = await db.select({
            id: PedidoUnificadoTable.id,
            clienteId: PedidoUnificadoTable.clienteId,
            total: PedidoUnificadoTable.total,
            sucursalId: PedidoUnificadoTable.sucursalId,
            codigoDescuentoId: PedidoUnificadoTable.codigoDescuentoId,
            montoDescuento: PedidoUnificadoTable.montoDescuento,
            marketingCampanaId: PedidoUnificadoTable.marketingCampanaId,
            pagado: PedidoUnificadoTable.pagado,
            createdAt: PedidoUnificadoTable.createdAt,
            tipo: PedidoUnificadoTable.tipo,
            grupal: PedidoUnificadoTable.grupal,
        }).from(PedidoUnificadoTable)
            .where(and(
                eq(PedidoUnificadoTable.restauranteId, restauranteId),
                soloDespachados
                    ? eq(PedidoUnificadoTable.estado, 'archived')
                    : notInArray(PedidoUnificadoTable.estado, ['cancelled']),
            ))

        // 3. Traer todos los items de esos pedidos
        const pedidoIds = pedidos.map(p => p.id)
        let itemsRaw: {
            pedidoId: number,
            productoId: number,
            cantidad: number | null,
            precioUnitario: string,
            clienteNombre: string | null,
            clienteTelefono: string | null,
            clienteId: number | null,
        }[] = []
        
        if (pedidoIds.length > 0) {
            itemsRaw = await db.select({
                pedidoId: ItemPedidoUnificadoTable.pedidoId,
                productoId: ItemPedidoUnificadoTable.productoId,
                cantidad: ItemPedidoUnificadoTable.cantidad,
                precioUnitario: ItemPedidoUnificadoTable.precioUnitario,
                clienteNombre: ItemPedidoUnificadoTable.clienteNombre,
                clienteTelefono: ItemPedidoUnificadoTable.clienteTelefono,
                clienteId: ItemPedidoUnificadoTable.clienteId,
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
        const itemsMap: Record<number, {
            nombreProducto: string,
            cantidad: number,
            precioUnitario: string,
            clienteNombre: string | null,
            clienteTelefono: string | null,
            clienteId: number | null,
        }[]> = {}
        for (const item of itemsRaw) {
            if (!itemsMap[item.pedidoId]) itemsMap[item.pedidoId] = []
            itemsMap[item.pedidoId].push({
                nombreProducto: productosMap[item.productoId] || 'Producto eliminado',
                cantidad: item.cantidad ?? 1,
                precioUnitario: item.precioUnitario,
                clienteNombre: item.clienteNombre || null,
                clienteTelefono: item.clienteTelefono || null,
                clienteId: item.clienteId || null,
            })
        }

        // 6. Ensamblar los pedidos con sus items
        const allPedidos = pedidos.map(p => ({
            ...p,
            // Casteamos el tipo explícitamente para que coincida con lo que espera el frontend
            tipo: p.tipo as 'delivery' | 'takeaway' | 'mesa',
            grupal: Boolean(p.grupal),
            items: itemsMap[p.id] || []
        }))

        // Helper para resolver los pedidos atribuidos a un cliente (individuales o grupales)
        const resolverPedidosCliente = (cliente: typeof clientes[0]) => {
            const telNorm = cliente.telefonoNormalizado || (cliente.telefono ? normalizarTelefonoCliente(cliente.telefono) : null)
            const matched: typeof allPedidos = []

            for (const p of allPedidos) {
                if (p.grupal) {
                    const clientItems = p.items.filter(it => {
                        if (it.clienteId && it.clienteId === cliente.id) return true
                        if (it.clienteTelefono && telNorm && normalizarTelefonoCliente(it.clienteTelefono) === telNorm) return true
                        return false
                    })

                    if (clientItems.length > 0) {
                        const totalGastadoItems = clientItems.reduce(
                            (sum, it) => sum + (parseFloat(it.precioUnitario || '0') * it.cantidad),
                            0
                        )
                        matched.push({
                            ...p,
                            items: clientItems,
                            total: totalGastadoItems.toFixed(2),
                        })
                    }
                } else if (p.clienteId === cliente.id) {
                    matched.push(p)
                }
            }

            return deduplicarPedidosHistorial(matched)
        }

        // 7. Mostrar sólo clientes con al menos un pedido despachado y calcular
        // todas sus métricas a partir de ese mismo historial.
        const clientesParaRespuesta = soloDespachados
            ? clientes.filter(cliente => resolverPedidosCliente(cliente).length > 0)
            : clientes
        const base = clientesParaRespuesta.map(cliente => {
            const clientPedidos = resolverPedidosCliente(cliente)
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
        const toquesPorCliente = await cargarToquesPorCliente(
            db,
            restauranteId,
            clientesParaRespuesta.map(cl => cl.id),
        )

        // Growth se resuelve con cargas por restaurante, nunca una consulta por
        // cliente. Este endpoint continúa siendo público para admins legacy:
        // todos los campos de crecimiento son estrictamente aditivos.
        const [atribuciones, campanas, enlaces, recuperosGrowth, contactosGrowth, cupones] = await Promise.all([
            db.select({
                pedidoUnificadoId: PedidoMarketingAtribucionTable.pedidoUnificadoId,
                campanaId: PedidoMarketingAtribucionTable.campanaId,
                origen: PedidoMarketingAtribucionTable.origen,
                recetaCodigo: PedidoMarketingAtribucionTable.recetaCodigo,
                revenueAtribuido: PedidoMarketingAtribucionTable.revenueAtribuido,
                createdAt: PedidoMarketingAtribucionTable.createdAt,
            }).from(PedidoMarketingAtribucionTable)
                .where(eq(PedidoMarketingAtribucionTable.restauranteId, restauranteId)),
            db.select({ id: MarketingCampanaTable.id, nombre: MarketingCampanaTable.nombre, slug: MarketingCampanaTable.slug })
                .from(MarketingCampanaTable)
                .where(eq(MarketingCampanaTable.restauranteId, restauranteId)),
            db.select({
                id: MarketingEnlaceTable.id, clienteId: MarketingEnlaceTable.clienteId,
                recetaCodigo: MarketingEnlaceTable.recetaCodigo, destinoTipo: MarketingEnlaceTable.destinoTipo,
                productoId: MarketingEnlaceTable.productoId, carritoRep: MarketingEnlaceTable.carritoRep,
                codigoDescuentoId: MarketingEnlaceTable.codigoDescuentoId, activo: MarketingEnlaceTable.activo,
                expiraAt: MarketingEnlaceTable.expiraAt, createdAt: MarketingEnlaceTable.createdAt,
            }).from(MarketingEnlaceTable)
                .where(eq(MarketingEnlaceTable.restauranteId, restauranteId)),
            db.select({ clienteId: RecuperoClienteTable.clienteId, createdAt: RecuperoClienteTable.createdAt })
                .from(RecuperoClienteTable)
                .where(eq(RecuperoClienteTable.restauranteId, restauranteId)),
            db.select({ clienteId: MarketingContactoTable.clienteId, createdAt: MarketingContactoTable.createdAt })
                .from(MarketingContactoTable)
                .where(and(
                    eq(MarketingContactoTable.restauranteId, restauranteId),
                    inArray(MarketingContactoTable.estado, ['preparado', 'abierto', 'reservado', 'enviado']),
                )),
            db.select({ id: CodigoDescuentoTable.id, codigo: CodigoDescuentoTable.codigo, tipo: CodigoDescuentoTable.tipo, valor: CodigoDescuentoTable.valor })
                .from(CodigoDescuentoTable)
                .where(eq(CodigoDescuentoTable.restauranteId, restauranteId)),
        ])
        // Reusamos el mismo historial deduplicado que expone el contrato
        // legacy; así `revenueHistorico` no puede diferir de `totalGastado`
        // por un reintento técnico de checkout.
        const pedidosGrowth = base.flatMap((cliente) => cliente.pedidos)
        const pedidoGrowthIds = new Set(pedidosGrowth.map((pedido) => pedido.id))
        const atribucionesEfectivas: any[] = [...atribuciones]
        const pedidoAtribuidoIds = new Set(atribucionesEfectivas.map((atribucion) => atribucion.pedidoUnificadoId))
        for (const pedido of pedidosGrowth) {
            if (pedido.marketingCampanaId != null && !pedidoAtribuidoIds.has(pedido.id)) {
                atribucionesEfectivas.push({
                    pedidoUnificadoId: pedido.id,
                    campanaId: pedido.marketingCampanaId,
                    origen: 'campana',
                    recetaCodigo: null,
                    revenueAtribuido: pedido.total,
                    createdAt: pedido.createdAt,
                })
                pedidoAtribuidoIds.add(pedido.id)
            }
        }
        const atribucionPorPedidoId = new Map(atribucionesEfectivas.map((atribucion) => [atribucion.pedidoUnificadoId, atribucion]))
        // Todo pedido sin atribución de campaña/receta es orgánico. Exigir un
        // evento `purchase` ocultaba clientes históricos y navegadores con
        // tracking bloqueado, aunque la compra existiera y estuviera cobrada.
        const pedidoIdsOrganicos = new Set(pedidosGrowth
            .filter((pedido) => !pedidoAtribuidoIds.has(pedido.id))
            .map((pedido) => pedido.id))
        const oportunidadesGrowth = resolverOportunidadesMarketing({
            clientes: clientesParaRespuesta.map((cliente) => ({
                id: cliente.id, nombre: cliente.nombre, marketingOptOut: cliente.marketingOptOut,
            })),
            pedidos: pedidosGrowth.map((pedido) => ({
                id: pedido.id, clienteId: pedido.clienteId, total: pedido.total, createdAt: pedido.createdAt,
            })),
            items: itemsRaw.filter((item) => pedidoGrowthIds.has(item.pedidoId)).map((item) => ({
                pedidoId: item.pedidoId, productoId: item.productoId, cantidad: item.cantidad ?? 1,
            })),
            productos: Object.entries(productosMap).map(([id, nombre]) => ({ id: Number(id), nombre })),
            recuperos: recuperosGrowth,
            contactos: contactosGrowth,
        }, enlaces as any)
        const growthPorCliente = resolverDatosGrowthClientes(
            clientesParaRespuesta,
            pedidosGrowth,
            atribucionesEfectivas,
            campanas,
            oportunidadesGrowth,
            {
                pedidoIdsOrganicos,
                cupones,
            },
        )

        const clientesConMetricas = base.map((b, i) => {
            const perfil = perfiles[i]
            const ultimoPedidoMs = b.fechasMs.length > 0 ? Math.max(...b.fechasMs) : null
            const recupero = estadoRecupero(toquesPorCliente[b.cliente.id] ?? [], ultimoPedidoMs)
            const crecimiento = growthPorCliente.get(b.cliente.id)
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
                // Crecimiento MVP (T19): aliases explícitos para que los
                // bundles nuevos no tengan que inferir datos de campos legacy.
                // Los defaults conservan el contrato aun sin tracking previo.
                fuenteAdquisicion: crecimiento?.fuenteAdquisicion ?? null,
                campanaAdquisicion: crecimiento?.campanaAdquisicion ?? null,
                primeraCompra: crecimiento?.primeraCompra ?? null,
                revenueHistorico: crecimiento?.revenueHistorico ?? b.totalGastado,
                recetaRecomendada: crecimiento?.recetaRecomendada ?? null,
                enlacePreparado: crecimiento?.enlacePreparado ?? null,
                revenueAcciones: crecimiento?.revenueAcciones ?? 0,
                campanasParticipadas: crecimiento?.campanasParticipadas ?? [],
                cuponesUsados: crecimiento?.cuponesUsados ?? [],
                actividadOrganica: crecimiento?.actividadOrganica ?? null,
                pedidos: b.pedidos.map((pedido) => ({
                    ...pedido,
                    esOrganico: pedidoIdsOrganicos.has(pedido.id),
                    campanaId: atribucionPorPedidoId.get(pedido.id)?.campanaId ?? null,
                    recetaCodigo: atribucionPorPedidoId.get(pedido.id)?.recetaCodigo ?? null,
                })),
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

// Borra un pedido desde el historial del cliente. Ambos identificadores y el
// restaurante forman parte del filtro para impedir accesos cruzados entre tenants.
clientesRoute.delete('/:id/pedidos/:pedidoId', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const clienteId = Number(c.req.param('id'))
    const pedidoId = Number(c.req.param('pedidoId'))

    if (!Number.isInteger(clienteId) || clienteId <= 0 || !Number.isInteger(pedidoId) || pedidoId <= 0) {
        return c.json({ success: false, message: 'ID inválido' }, 400)
    }

    try {
        const [pedido] = await db.select({
            id: PedidoUnificadoTable.id,
            tipo: PedidoUnificadoTable.tipo,
            sucursalId: PedidoUnificadoTable.sucursalId,
        }).from(PedidoUnificadoTable).where(and(
            eq(PedidoUnificadoTable.id, pedidoId),
            eq(PedidoUnificadoTable.clienteId, clienteId),
            eq(PedidoUnificadoTable.restauranteId, restauranteId),
        )).limit(1)

        if (!pedido) return c.json({ success: false, message: 'Pedido no encontrado' }, 404)

        await db.transaction(async (tx) => {
            await borrarPedidosUnificados(tx, restauranteId, [pedidoId])
        })

        await emitirEventoPedido(db, {
            restauranteId,
            pedidoId,
            tipo: pedido.tipo,
            sucursalId: pedido.sucursalId,
            event: 'remove',
            reason: 'deleted',
        })

        return c.json({ success: true, message: 'Pedido eliminado correctamente' }, 200)
    } catch (error) {
        console.error('Error eliminando pedido del cliente:', error)
        return c.json({ success: false, message: 'No se pudo eliminar el pedido' }, 500)
    }
})

// Elimina el perfil y todo su historial. También limpia las tablas legacy y las
// referencias del Motor de Recompra para que ninguna FK deje el borrado a medias.
clientesRoute.delete('/:id', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const clienteId = Number(c.req.param('id'))

    if (!Number.isInteger(clienteId) || clienteId <= 0) {
        return c.json({ success: false, message: 'ID inválido' }, 400)
    }

    try {
        const [cliente] = await db.select({ id: ClienteTable.id })
            .from(ClienteTable)
            .where(and(eq(ClienteTable.id, clienteId), eq(ClienteTable.restauranteId, restauranteId)))
            .limit(1)

        if (!cliente) return c.json({ success: false, message: 'Cliente no encontrado' }, 404)

        const resultado = await db.transaction(async (tx) => {
            const pedidos = await tx.select({
                id: PedidoUnificadoTable.id,
                tipo: PedidoUnificadoTable.tipo,
                sucursalId: PedidoUnificadoTable.sucursalId,
            })
                .from(PedidoUnificadoTable)
                .where(and(
                    eq(PedidoUnificadoTable.clienteId, clienteId),
                    eq(PedidoUnificadoTable.restauranteId, restauranteId),
                ))
            await borrarPedidosUnificados(tx, restauranteId, pedidos.map((p: { id: number }) => p.id))

            const delivery = await tx.select({ id: PedidoDeliveryTable.id })
                .from(PedidoDeliveryTable)
                .where(and(eq(PedidoDeliveryTable.clienteId, clienteId), eq(PedidoDeliveryTable.restauranteId, restauranteId)))
            const deliveryIds = delivery.map((p: { id: number }) => p.id)
            if (deliveryIds.length > 0) {
                await tx.delete(PagoTable).where(inArray(PagoTable.pedidoDeliveryId, deliveryIds))
                await tx.delete(ItemPedidoDeliveryTable).where(inArray(ItemPedidoDeliveryTable.pedidoDeliveryId, deliveryIds))
                await tx.delete(PedidoDeliveryTable).where(inArray(PedidoDeliveryTable.id, deliveryIds))
            }

            const takeaway = await tx.select({ id: PedidoTakeawayTable.id })
                .from(PedidoTakeawayTable)
                .where(and(eq(PedidoTakeawayTable.clienteId, clienteId), eq(PedidoTakeawayTable.restauranteId, restauranteId)))
            const takeawayIds = takeaway.map((p: { id: number }) => p.id)
            if (takeawayIds.length > 0) {
                await tx.delete(PagoTable).where(inArray(PagoTable.pedidoTakeawayId, takeawayIds))
                await tx.delete(ItemPedidoTakeawayTable).where(inArray(ItemPedidoTakeawayTable.pedidoTakeawayId, takeawayIds))
                await tx.delete(PedidoTakeawayTable).where(inArray(PedidoTakeawayTable.id, takeawayIds))
            }

            await tx.delete(ColaRecompraTable).where(and(
                eq(ColaRecompraTable.clienteId, clienteId),
                eq(ColaRecompraTable.restauranteId, restauranteId),
            ))
            await tx.delete(CampanaRecompraClienteTable).where(and(
                eq(CampanaRecompraClienteTable.clienteId, clienteId),
                eq(CampanaRecompraClienteTable.restauranteId, restauranteId),
            ))
            await tx.delete(RecuperoClienteTable).where(and(
                eq(RecuperoClienteTable.clienteId, clienteId),
                eq(RecuperoClienteTable.restauranteId, restauranteId),
            ))
            await tx.delete(ClienteTable).where(and(
                eq(ClienteTable.id, clienteId),
                eq(ClienteTable.restauranteId, restauranteId),
            ))

            return {
                pedidosUnificados: pedidos,
                pedidosEliminados: pedidos.length + deliveryIds.length + takeawayIds.length,
            }
        })

        // Mantiene sincronizados los dashboards que estén abiertos en otras terminales.
        for (const pedido of resultado.pedidosUnificados) {
            await emitirEventoPedido(db, {
                restauranteId,
                pedidoId: pedido.id,
                tipo: pedido.tipo,
                sucursalId: pedido.sucursalId,
                event: 'remove',
                reason: 'deleted',
            })
        }

        return c.json({
            success: true,
            message: 'Cliente y sus pedidos eliminados correctamente',
            data: { pedidosEliminados: resultado.pedidosEliminados },
        }, 200)
    } catch (error) {
        console.error('Error eliminando cliente:', error)
        return c.json({ success: false, message: 'No se pudo eliminar el cliente y sus pedidos' }, 500)
    }
})

/**
 * POST /clientes/:id/recupero — Playbook de recupero de dormidos (Motor de Recompra · 4.2).
 * Acción VOLUNTARIA del local: manda el próximo toque de la escalera de incentivos al cliente.
 * Gateado por Motor de Recompra. Reserva el bucket `marketing` antes del proveedor.
 * El mensaje usa la receta del segmento del cliente (derivada del RFM: acá no hay cola que la traiga).
 */
clientesRoute.post('/:id/recupero', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const clienteId = parseInt(c.req.param('id'), 10)

    if (isNaN(clienteId)) {
        return c.json({ success: false, message: 'ID inválido' }, 400)
    }

    try {
        const claveSolicitada = c.req.header('Idempotency-Key')?.trim()
        const operacionId = claveSolicitada && claveSolicitada.length <= 80
            ? `recupero-manual:${restauranteId}:${clienteId}:${claveSolicitada}`
            : `recupero-manual:${restauranteId}:${clienteId}:${crypto.randomUUID()}`
        const resultado = await enviarRecuperoDormido(c, db, restauranteId, clienteId, { operacionId })

        if (!resultado.ok) {
            if (resultado.motivo === 'envio_fallido') {
                await registrarFalloContactoManual(db, restauranteId, clienteId, {
                    plantillaWhatsapp: resultado.plantillaWhatsapp,
                    errorEnvio: resultado.errorEnvio ?? resultado.mensaje,
                })
            }
            // 404 si el cliente no existe; 409 por barreras "no ahora" (cooldown + protección de la
            // base: opt-out / tope mensual / horario de silencio); 400 para el resto (config/envío).
            const bloqueos = ['cooldown', 'opt_out', 'tope_mensual', 'horario_silencio', 'sin_saldo']
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
            plantillaWhatsapp: resultado.plantillaWhatsapp,
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
// MOTOR DE RECOMPRA · PROGRAMACIONES — el dueño programa la tanda y el motor
// la ejecuta. Nada se agenda sin una programación explícita.
// Todo el contrato usa el gate canónico de Retención.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * El contrato de entrada de una programación. Es el borde HTTP, no la validación de negocio: todo lo
 * que entra acá se acota después en `normalizarEspecificacion` (que es la única puerta hacia la base).
 * Por eso el zod es permisivo a propósito —`nullish()` en todo, coerción suelta en los ids—: el
 * admin manda `null` para "usá el default del local", y un 400 de Zod no deja log del lado del
 * servidor, así que rechazar por un valor que el motor sabe acotar sería un bug silencioso.
 */
const especificacionProgramacionSchema = z.object({
    segmento: z.enum(SEGMENTOS_PROGRAMABLES as unknown as [string, ...string[]]).nullish(),
    cantidad: z.coerce.number().nullish(),
    toqueHasta: z.coerce.number().nullish(),
    diasToque2: z.coerce.number().nullish(),
    diasToque3: z.coerce.number().nullish(),
    porcentajeControl: z.coerce.number().nullish(),
    // Los ids se aceptan crudos: `idsValidos` descarta los que no son enteros positivos. Un id
    // basura en la lista no tiene por qué tumbar toda la programación.
    incluirIds: z.array(z.coerce.number()).nullish(),
    excluirIds: z.array(z.coerce.number()).nullish(),
})

const previewProgramacionSchema = z.object({
    segmento: z.preprocess((v) => (v === '' ? undefined : v), z.enum(SEGMENTOS_PROGRAMABLES as unknown as [string, ...string[]]).nullish()),
    cantidad: z.coerce.number().nullish(),
    limite: z.coerce.number().nullish(),
    buscar: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(80).nullish()),
})

const configMotorSchema = z.object({
    cupoDiario: z.coerce.number().nullish(),
    modo: z.enum(['automatico', 'manual']).nullish(),
    diasToque2: z.coerce.number().nullish(),
    diasToque3: z.coerce.number().nullish(),
    porcentajeControl: z.coerce.number().nullish(),
})

/**
 * GET /clientes/recompra/estado — la pantalla del motor:
 *  - sin tandas vivas → el PLAN de activación (cohorte disponible + propuesta de cupo + días que
 *    cubre el saldo) y el asistente para programar la primera.
 *  - con tandas vivas → el DASHBOARD agregado (contactados, volvieron, plata recuperada) + la lista
 *    de programaciones con su progreso.
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
 * GET /clientes/recompra/programar/preview — el universo del asistente de programación.
 *
 * Devuelve los candidatos en el orden en que el motor los elegiría, con el día y la hora que le
 * tocaría a cada uno, más el control que se apartaría. Los que ya están comprometidos en otra tanda
 * viva vienen marcados (`elegible: false`) porque programarlos de nuevo les mandaría el mismo toque
 * dos veces. `buscar` busca en TODA la cohorte, para poder agregar a alguien puntual que no esté
 * entre los primeros de la lista. No escribe nada.
 */
clientesRoute.get(
    '/recompra/programar/preview',
    requireModulo(MODULE_KEYS.MOTOR_RECOMPRA),
    zValidator('query', previewProgramacionSchema),
    async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        try {
            const q = c.req.valid('query')
            const data = await previewProgramacion(db, restauranteId, {
                segmento: (q.segmento ?? null) as any,
                cantidad: q.cantidad ?? null,
                buscar: q.buscar ?? null,
                limite: q.limite ?? null,
            })
            return c.json({ success: true, data }, 200)
        } catch (error) {
            console.error('Error previsualizando programación de recompra:', error)
            return c.json({ success: false, message: 'Error interno del servidor' }, 500)
        }
    },
)

/**
 * POST /clientes/recompra/programar — LA DECISIÓN del dueño. Crea la tanda: elige a quiénes, aparta
 * el grupo de control y deja agendadas las filas del toque 1 con su día y su hora.
 *
 * No envía nada: el goteo lo hace el tick cuando cada fila vence, respetando el cupo del local.
 * Que programar no envíe es lo que hace que el dueño pueda programar tranquilo.
 */
clientesRoute.post(
    '/recompra/programar',
    requireModulo(MODULE_KEYS.MOTOR_RECOMPRA),
    zValidator('json', especificacionProgramacionSchema),
    async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        try {
            const body = c.req.valid('json')
            const resultado = await programarEnvios(db, restauranteId, {
                segmento: (body.segmento ?? null) as any,
                cantidad: body.cantidad ?? null,
                toqueHasta: body.toqueHasta ?? null,
                diasToque2: body.diasToque2 ?? null,
                diasToque3: body.diasToque3 ?? null,
                porcentajeControl: body.porcentajeControl ?? null,
                incluirIds: body.incluirIds ?? null,
                excluirIds: body.excluirIds ?? null,
            })
            if (resultado.moduloNoDisponible) {
                return c.json({
                    success: false,
                    message: 'El módulo Retención no está disponible.',
                    data: resultado,
                }, 403)
            }
            if (resultado.vacio) {
                return c.json({
                    success: false,
                    message: 'No hay clientes elegibles para programar con esos filtros',
                    data: resultado,
                }, 200)
            }
            return c.json({
                success: true,
                message: `Programados ${resultado.cantidad} mensajes`
                    + (resultado.control > 0 ? ` (+${resultado.control} en el grupo de control)` : ''),
                data: resultado,
            }, 200)
        } catch (error) {
            console.error('Error programando envíos del motor de recompra:', error)
            return c.json({ success: false, message: 'Error interno del servidor' }, 500)
        }
    },
)

/** GET /clientes/recompra/programaciones — las tandas del local (vivas y cerradas) con su progreso. */
clientesRoute.get('/recompra/programaciones', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        const data = await listarProgramaciones(db, restauranteId, numeroQuery(c.req.query('limite'), 20))
        return c.json({ success: true, data }, 200)
    } catch (error) {
        console.error('Error listando programaciones de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

/**
 * POST /clientes/recompra/programaciones/:id/cancelar — lo que todavía no salió, no sale.
 * Las filas ya enviadas y las del grupo de control se conservan: son la evidencia de atribución.
 */
clientesRoute.post('/recompra/programaciones/:id/cancelar', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const campanaId = Number(c.req.param('id'))
    if (!Number.isFinite(campanaId) || campanaId <= 0) {
        return c.json({ success: false, message: 'ID de programación inválido' }, 400)
    }
    try {
        const res = await cancelarProgramacion(db, restauranteId, campanaId)
        if (!res.ok) return c.json({ success: false, message: res.mensaje }, 404)
        return c.json({
            success: true,
            message: res.mensaje
                ?? (res.canceladas > 0
                    ? `Programación cancelada: ${res.canceladas} mensajes no salen`
                    : 'Programación cancelada'),
            data: res,
        }, 200)
    } catch (error) {
        console.error('Error cancelando programación de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

/** POST /clientes/recompra/pausar — Pausar el goteo del local (siempre disponible). No se pierde nada: la cola queda. */
clientesRoute.post('/recompra/pausar', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        await pausarMotorManual(db, restauranteId)
        return c.json({ success: true, message: 'Motor pausado' }, 200)
    } catch (error) {
        console.error('Error pausando motor de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

/** POST /clientes/recompra/reanudar — vuelve a gotear desde donde quedó, con las tandas que ya estaban. */
clientesRoute.post('/recompra/reanudar', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        await reanudarMotor(db, restauranteId)
        return c.json({ success: true, message: 'Motor reanudado' }, 200)
    } catch (error) {
        console.error('Error reanudando motor de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

/**
 * PUT /clientes/recompra/config — la configuración del MOTOR del local (no de una tanda): cupo diario,
 * modo, días entre toques por defecto y % de control. Todas las claves son opcionales y cada una se
 * acota en `guardarConfigMotor`; los días además tienen el piso anti-spam de 48 hs.
 */
clientesRoute.put(
    '/recompra/config',
    requireModulo(MODULE_KEYS.MOTOR_RECOMPRA),
    zValidator('json', configMotorSchema),
    async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        try {
            const body = c.req.valid('json')
            const patch: Record<string, unknown> = {}
            if (body.cupoDiario != null) patch.cupoDiario = body.cupoDiario
            if (body.modo != null) patch.modo = body.modo
            if (body.diasToque2 != null) patch.diasToque2 = body.diasToque2
            if (body.diasToque3 != null) patch.diasToque3 = body.diasToque3
            if (body.porcentajeControl != null) patch.porcentajeControl = body.porcentajeControl

            const config = await guardarConfigMotor(db, restauranteId, patch)
            return c.json({
                success: true,
                message: 'Configuración actualizada',
                data: {
                    config,
                    min: CUPO_DIARIO_MIN,
                    max: CUPO_DIARIO_MAX,
                    cantidadMin: CANTIDAD_MIN,
                    cantidadMax: CANTIDAD_MAX,
                    diasMinEntreToques: DIAS_ENTRE_TOQUES_MIN,
                    porcentajeControlMin: PORCENTAJE_CONTROL_MIN,
                    porcentajeControlMax: PORCENTAJE_CONTROL_MAX,
                },
            }, 200)
        } catch (error) {
            console.error('Error configurando motor de recompra:', error)
            return c.json({ success: false, message: 'Error interno del servidor' }, 500)
        }
    },
)

/** PUT /clientes/recompra/modo — alias de `config` para el único campo del modo (lo usa la pantalla). */
clientesRoute.put('/recompra/modo', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        const body = await c.req.json().catch(() => ({}))
        const modo = body?.modo === 'manual' ? 'manual' : 'automatico'
        const aplicado = await setModoMotor(db, restauranteId, modo)
        return c.json({ success: true, message: `Modo ${aplicado} activado`, data: { modo: aplicado } }, 200)
    } catch (error) {
        console.error('Error actualizando modo del motor de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

/**
 * GET /clientes/recompra/cola/:id/mensaje — obtiene datos y texto preparado del mensaje para enviar.
 *
 * Las tres decisiones del operador viajan por query: `segmento` (el MENSAJE), `link` y `descuento`.
 * `toque` elige el tramo del recetario (1º relato, 2º recordatorio, 3º cierre). Sin nada elegido se
 * devuelve el default del motor: el segmento recalculado en vivo, el toque de la escalera del cliente
 * y el `%` de ese escalón. `receta` se mantiene como alias legacy de `segmento`.
 */
clientesRoute.get(
    '/recompra/cola/:id/mensaje',
    requireModulo(MODULE_KEYS.MOTOR_RECOMPRA),
    zValidator('query', decisionesRecetaSchema),
    async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const filaId = Number(c.req.param('id'))
        if (!Number.isFinite(filaId) || filaId <= 0) {
            return c.json({ success: false, message: 'ID de fila inválido' }, 400)
        }
        try {
            const res = await obtenerMensajeFilaCola(db, restauranteId, filaId, opcionesDeDecisiones(c.req.valid('query')))
            if (!res.ok) return c.json({ success: false, message: res.mensaje }, 404)
            return c.json({ success: true, data: res.data }, 200)
        } catch (error) {
            console.error('Error obteniendo mensaje de cola de recompra:', error)
            return c.json({ success: false, message: 'Error interno del servidor' }, 500)
        }
    },
)

/**
 * POST /clientes/recompra/cola/:id/marcar-enviado — marca una fila de la cola como enviada manualmente.
 *
 * Body opcional con `segmento` + `toque` + `link` + `descuento`: lo que el operador efectivamente
 * mandó. Se registra tal cual —incluido un envío sin descuento— sin reiniciar el nivel de la escalera
 * del cliente, y ACÁ es donde se emite el cupón (el diálogo no toca la base). La respuesta devuelve lo
 * registrado para que la pantalla no tenga que adivinarlo.
 */
clientesRoute.post(
    '/recompra/cola/:id/marcar-enviado',
    requireModulo(MODULE_KEYS.MOTOR_RECOMPRA),
    zValidator('json', decisionesRecetaSchema),
    async (c) => {
        const db = drizzle(pool)
        const restauranteId = (c as any).user.id
        const filaId = Number(c.req.param('id'))
        if (!Number.isFinite(filaId) || filaId <= 0) {
            return c.json({ success: false, message: 'ID de fila inválido' }, 400)
        }
        try {
            const res = await marcarFilaColaComoEnviadaManual(db, restauranteId, filaId, opcionesDeDecisiones(c.req.valid('json')))
            if (!res.ok) return c.json({ success: false, message: res.mensaje || 'Error al marcar como enviado' }, 400)
            return c.json({
                success: true,
                message: res.mensaje,
                data: {
                    toque: res.toque ?? null,
                    nivel: res.nivel ?? null,
                    descuento: res.descuento ?? 0,
                    link: res.link ?? null,
                    codigoDescuento: res.codigoDescuento ?? null,
                },
            }, 200)
        } catch (error) {
            console.error('Error marcando fila de recompra como enviada:', error)
            return c.json({ success: false, message: 'Error interno del servidor' }, 500)
        }
    },
)

function numeroQuery(value: string | undefined, fallback: number) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
}

/** Filtro por tanda: sin él las vistas son del local entero (las tandas vivas conviven). */
function campanaQuery(value: string | undefined): number | undefined {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** GET /clientes/recompra/cola — backlog paginado en orden efectivo de despacho. */
clientesRoute.get('/recompra/cola', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        const poblacion = c.req.query('poblacion')
        const data = await listarColaRecompra(db, restauranteId, {
            pagina: numeroQuery(c.req.query('pagina'), 1),
            limite: numeroQuery(c.req.query('limite'), 25),
            segmento: c.req.query('segmento') || undefined,
            poblacion: poblacion === 'flujo' || poblacion === 'stock' ? poblacion : undefined,
            campanaId: campanaQuery(c.req.query('campanaId')),
        })
        return c.json({ success: true, data }, 200)
    } catch (error) {
        console.error('Error listando cola del motor de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

/** GET /clientes/recompra/historial — despachos entregados/fallidos auditables. */
clientesRoute.get('/recompra/historial', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        const estado = c.req.query('estado')
        const data = await listarHistorialRecompra(db, restauranteId, {
            pagina: numeroQuery(c.req.query('pagina'), 1),
            limite: numeroQuery(c.req.query('limite'), 25),
            segmento: c.req.query('segmento') || undefined,
            campanaId: campanaQuery(c.req.query('campanaId')),
            estadoDespacho: estado === 'entregado' || estado === 'fallido' ? estado : undefined,
        })
        return c.json({ success: true, data }, 200)
    } catch (error) {
        console.error('Error listando historial del motor de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

/** GET /clientes/recompra/clientes — directorio consolidado de las tandas vivas del local. */
clientesRoute.get('/recompra/clientes', requireModulo(MODULE_KEYS.MOTOR_RECOMPRA), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    try {
        const poblacion = c.req.query('poblacion')
        const rol = c.req.query('rol')
        const estadoSolicitado = c.req.query('estado')
        const estados = ['pendiente', 'enviado', 'salido', 'fallido', 'control'] as const
        const estadoNormalizado = estadoSolicitado === 'salido_por_pedido' ? 'salido' : estadoSolicitado
        const data = await listarClientesRecompra(db, restauranteId, {
            pagina: numeroQuery(c.req.query('pagina'), 1),
            limite: numeroQuery(c.req.query('limite'), 25),
            segmento: c.req.query('segmento') || undefined,
            poblacion: poblacion === 'flujo' || poblacion === 'stock' ? poblacion : undefined,
            rol: rol === 'contactado' || rol === 'control' ? rol : undefined,
            campanaId: campanaQuery(c.req.query('campanaId')),
            estado: estados.includes(estadoNormalizado as typeof estados[number])
                ? estadoNormalizado as typeof estados[number]
                : undefined,
        })
        return c.json({ success: true, data }, 200)
    } catch (error) {
        console.error('Error listando clientes del motor de recompra:', error)
        return c.json({ success: false, message: 'Error interno del servidor' }, 500)
    }
})

export { clientesRoute }
