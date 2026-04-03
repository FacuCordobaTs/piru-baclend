import { Hono } from 'hono'
import { pool } from '../db'
import { restaurante as RestauranteTable, producto as ProductoTable, categoria as CategoriaTable, etiqueta as EtiquetaTable, productoIngrediente as ProductoIngredienteTable, ingrediente as IngredienteTable, agregado as AgregadoTable, productoAgregado as ProductoAgregadoTable, horarioRestaurante as HorarioRestauranteTable, codigoDescuento as CodigoDescuentoTable, varianteProducto as VarianteProductoTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, desc, or, lt, isNull, sql, inArray } from 'drizzle-orm'
import { wsManager } from '../websocket/manager'
import { sendOrderWhatsApp, sendClientPaymentConfirmedWhatsApp } from '../services/whatsapp'
import { productoPuntos as ProductoPuntosTable, zonaDelivery as ZonaDeliveryTable } from '../db/schema'
import { asignarAliasAPedido } from '../services/cucuru'
import { crearPagoTalo } from '../services/talo'
import { findZoneForPoint } from '../utils/geo'
import UUID = require("uuid-js");
import {
  buildMetodosPublicosList,
  resolverMetodoPagoPedido,
  debeEsperarWebhookParaNotificar,
  proveedorTransferenciaDinamica,
  METODO_PAGO,
  rowToPagoRow,
} from '../lib/metodos-pago'

const publicRoute = new Hono()

publicRoute.get('/restaurante/:username', async (c) => {
    const db = drizzle(pool)
    const username = c.req.param('username')

    try {
        const restaurante = await db.select({
            id: RestauranteTable.id,
            nombre: RestauranteTable.nombre,
            imagenUrl: RestauranteTable.imagenUrl,
            imagenLightUrl: RestauranteTable.imagenLightUrl,
            direccion: RestauranteTable.direccion,
            telefono: RestauranteTable.telefono,
            deliveryFee: RestauranteTable.deliveryFee,
            cucuruConfigurado: RestauranteTable.cucuruConfigurado,
            cucuruEnabled: RestauranteTable.cucuruEnabled,
            cardsPaymentsEnabled: RestauranteTable.cardsPaymentsEnabled,
            mpConnected: RestauranteTable.mpConnected,
            mpPublicKey: RestauranteTable.mpPublicKey,
            transferenciaAlias: RestauranteTable.transferenciaAlias,
            proveedorPago: RestauranteTable.proveedorPago,
            metodosPagoConfig: RestauranteTable.metodosPagoConfig,
            taloCredencialesOk: sql<boolean>`(${RestauranteTable.taloClientId} IS NOT NULL AND ${RestauranteTable.taloClientSecret} IS NOT NULL AND ${RestauranteTable.taloUserId} IS NOT NULL)`.as('taloCredencialesOk'),
            colorPrimario: RestauranteTable.colorPrimario,
            colorSecundario: RestauranteTable.colorSecundario,
            disenoAlternativo: RestauranteTable.disenoAlternativo,
            orderGroupEnabled: RestauranteTable.orderGroupEnabled,
            codigoDescuentoEnabled: RestauranteTable.codigoDescuentoEnabled,
            comprobantesWhatsapp: RestauranteTable.comprobantesWhatsapp,
            notificarClientesWhatsapp: RestauranteTable.notificarClientesWhatsapp,
        })
            .from(RestauranteTable)
            .where(eq(RestauranteTable.username, username))
            .limit(1)

        if (!restaurante || restaurante.length === 0) {
            return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
        }

        const restauranteId = restaurante[0].id
        const r0 = restaurante[0]
        const pagoRowPerfil = rowToPagoRow({
            metodosPagoConfig: r0.metodosPagoConfig,
            cardsPaymentsEnabled: r0.cardsPaymentsEnabled,
            mpConnected: r0.mpConnected,
            mpPublicKey: r0.mpPublicKey,
            cucuruConfigurado: r0.cucuruConfigurado,
            cucuruEnabled: r0.cucuruEnabled,
            proveedorPago: r0.proveedorPago,
            taloClientId: r0.taloCredencialesOk ? 'x' : null,
            taloClientSecret: r0.taloCredencialesOk ? 'x' : null,
            taloUserId: r0.taloCredencialesOk ? 'x' : null,
            transferenciaAlias: r0.transferenciaAlias,
        })
        const metodosPagoPublicos = buildMetodosPublicosList(pagoRowPerfil)
        const transferenciaAliasCliente = metodosPagoPublicos.some((m) => m.id === METODO_PAGO.MANUAL_TRANSFER)
            ? r0.transferenciaAlias
            : null
        const {
            proveedorPago: _pp,
            metodosPagoConfig: _mpc,
            taloCredencialesOk: _taloOk,
            ...restauranteSeguro
        } = r0

        // Obtener horarios de atención
        const horarios = await db
            .select({
                id: HorarioRestauranteTable.id,
                diaSemana: HorarioRestauranteTable.diaSemana,
                horaApertura: HorarioRestauranteTable.horaApertura,
                horaCierre: HorarioRestauranteTable.horaCierre,
            })
            .from(HorarioRestauranteTable)
            .where(eq(HorarioRestauranteTable.restauranteId, restauranteId))

        // Productos sin joins (evita bug Drizzle orderSelectedFields con leftJoin null)
        const productosRaw = await db
            .select()
            .from(ProductoTable)
            .where(and(eq(ProductoTable.restauranteId, restauranteId), eq(ProductoTable.activo, true)))

        // Categorías y puntos en consultas separadas
        const categoriasMap = new Map<number, string>()
        const puntosMap = new Map<number, { puntosNecesarios: string | null; puntosGanados: string | null }>()
        if (productosRaw.length > 0) {
            const catIds = [...new Set(productosRaw.map((p) => p.categoriaId).filter(Boolean))] as number[]
            const prodIds = productosRaw.map((p) => p.id)
            if (catIds.length > 0) {
                const categorias = await db.select({ id: CategoriaTable.id, nombre: CategoriaTable.nombre }).from(CategoriaTable).where(inArray(CategoriaTable.id, catIds))
                for (const c of categorias) categoriasMap.set(c.id, c.nombre)
            }
            const puntosRows = await db.select().from(ProductoPuntosTable).where(inArray(ProductoPuntosTable.productoId, prodIds))
            for (const pp of puntosRows) puntosMap.set(pp.productoId, { puntosNecesarios: pp.puntosNecesarios.toString(), puntosGanados: pp.puntosGanados.toString() })
        }

        // Obtener ingredientes y agregados para cada producto
        const productosConIngredientes = await Promise.all(
            productosRaw.map(async (p) => {
                const [ingredientes, agregados, variantes] = await Promise.all([
                    db
                        .select({
                            id: IngredienteTable.id,
                            nombre: IngredienteTable.nombre,
                        })
                        .from(ProductoIngredienteTable)
                        .innerJoin(IngredienteTable, eq(ProductoIngredienteTable.ingredienteId, IngredienteTable.id))
                        .where(eq(ProductoIngredienteTable.productoId, p.id)),
                    db
                        .select({
                            id: AgregadoTable.id,
                            nombre: AgregadoTable.nombre,
                            precio: AgregadoTable.precio,
                        })
                        .from(ProductoAgregadoTable)
                        .innerJoin(AgregadoTable, eq(ProductoAgregadoTable.agregadoId, AgregadoTable.id))
                        .where(eq(ProductoAgregadoTable.productoId, p.id)),
                    db
                        .select({
                            id: VarianteProductoTable.id,
                            nombre: VarianteProductoTable.nombre,
                            precio: VarianteProductoTable.precio,
                        })
                        .from(VarianteProductoTable)
                        .where(eq(VarianteProductoTable.productoId, p.id))
                ])
                const puntos = puntosMap.get(p.id)
                return {
                    id: p.id,
                    restauranteId: p.restauranteId,
                    categoriaId: p.categoriaId,
                    nombre: p.nombre,
                    descripcion: p.descripcion,
                    precio: p.precio,
                    activo: p.activo,
                    imagenUrl: p.imagenUrl,
                    descuento: p.descuento,
                    createdAt: p.createdAt,
                    categoria: p.categoriaId ? categoriasMap.get(p.categoriaId) ?? null : null,
                    puntosNecesarios: puntos?.puntosNecesarios ?? null,
                    puntosGanados: puntos?.puntosGanados ?? null,
                    ingredientes,
                    agregados,
                    variantes,
                }
            })
        )

        return c.json({
            message: 'Datos obtenidos correctamente',
            success: true,
            data: {
                restaurante: {
                    ...restauranteSeguro,
                    transferenciaAlias: transferenciaAliasCliente,
                    metodosPago: metodosPagoPublicos,
                },
                productos: productosConIngredientes,
                horarios
            }
        }, 200)

    } catch (error) {
        console.error('Error getting public restaurant profile:', error)
        return c.json({ message: 'Error getting profile', error: (error as Error).message }, 500)
    }
})

import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { 
    pedidoUnificado as PedidoUnificadoTable, 
    itemPedidoUnificado as ItemPedidoUnificadoTable, 
    cliente as ClienteTable,
    sala as SalaTable
} from '../db/schema'

const createSalaSchema = z.object({
    restauranteId: z.number().int().positive(),
    nombreCliente: z.string().min(1) // we might not really use it for the table but good to know
})

publicRoute.get('/sala/:token/order-created', async (c) => {
    const token = c.req.param('token')
    const order = wsManager.getSalaOrderFromCache(token)
    if (!order) {
      return c.json({ success: false, order: null }, 200)
    }
    return c.json({ success: true, order }, 200)
})

publicRoute.post('/sala/create', zValidator('json', createSalaSchema), async (c) => {
    const db = drizzle(pool)
    const { restauranteId, nombreCliente } = c.req.valid('json')

    try {
        const token = UUID.create().toString()

        // Create the sala with the client's name or a default name
        const sala = await db.insert(SalaTable).values({
            nombre: `Pedido de ${nombreCliente}`,
            restauranteId,
            token
        })

        return c.json({
            message: 'Sala creada correctamente',
            success: true,
            data: {
                id: Number(sala[0].insertId),
                token
            }
        }, 201)
    } catch (error) {
        console.error('Error creating sala:', error)
        return c.json({ message: 'Error creating sala', error: (error as Error).message }, 500)
    }
})

const validarDescuentoSchema = z.object({
    restauranteId: z.number().int().positive(),
    codigo: z.string().min(1).max(50).transform((v) => v.toUpperCase().trim()),
    totalCarrito: z.number().min(0),
})

publicRoute.post('/descuentos/validar', zValidator('json', validarDescuentoSchema), async (c) => {
    const db = drizzle(pool)
    const { restauranteId, codigo, totalCarrito } = c.req.valid('json')

    try {
        const [restauranteCfg] = await db
            .select({ codigoDescuentoEnabled: RestauranteTable.codigoDescuentoEnabled })
            .from(RestauranteTable)
            .where(eq(RestauranteTable.id, restauranteId))
            .limit(1)

        if (!restauranteCfg) {
            return c.json({ success: false, message: 'Restaurante no encontrado' }, 404)
        }

        if (!restauranteCfg.codigoDescuentoEnabled) {
            return c.json({ success: false, message: 'Este local no tiene habilitados los códigos de descuento' }, 200)
        }

        const [cupon] = await db
            .select()
            .from(CodigoDescuentoTable)
            .where(
                and(
                    eq(CodigoDescuentoTable.restauranteId, restauranteId),
                    eq(CodigoDescuentoTable.codigo, codigo)
                )
            )
            .limit(1)

        if (!cupon) {
            return c.json({ success: false, message: 'Código no encontrado' }, 200)
        }
        if (!cupon.activo) {
            return c.json({ success: false, message: 'Este código ya no está activo' }, 200)
        }

        const ahora = new Date()
        if (cupon.fechaInicio && new Date(cupon.fechaInicio) > ahora) {
            return c.json({ success: false, message: 'Este código aún no está vigente' }, 200)
        }
        if (cupon.fechaFin && new Date(cupon.fechaFin) < ahora) {
            return c.json({ success: false, message: 'Este código ha expirado' }, 200)
        }

        const montoMin = parseFloat(cupon.montoMinimo || '0')
        if (totalCarrito < montoMin) {
            return c.json({
                success: false,
                message: `Monto mínimo para este código: $${montoMin.toFixed(0)}`,
            }, 200)
        }

        if (cupon.limiteUsos !== null && (cupon.usosActuales || 0) >= cupon.limiteUsos) {
            return c.json({ success: false, message: 'Este código alcanzó su límite de usos' }, 200)
        }

        let montoDescuento = 0
        if (cupon.tipo === 'porcentaje') {
            const pct = parseFloat(cupon.valor)
            montoDescuento = totalCarrito * (pct / 100)
        } else {
            montoDescuento = parseFloat(cupon.valor)
        }
        montoDescuento = Math.min(montoDescuento, totalCarrito)
        const totalConDescuento = Math.max(0, totalCarrito - montoDescuento)

        return c.json({
            success: true,
            data: {
                codigoDescuentoId: cupon.id,
                codigo: cupon.codigo,
                montoDescuento: montoDescuento.toFixed(2),
                totalConDescuento: totalConDescuento.toFixed(2),
            },
        }, 200)
    } catch (error) {
        console.error('Error validando descuento:', error)
        return c.json({ success: false, message: 'Error al validar el código' }, 500)
    }
})

const createDeliverySchema = z.object({
    restauranteId: z.number().int().positive(),
    direccion: z.string().min(5),
    lat: z.number().optional(),
    lng: z.number().optional(),
    nombreCliente: z.string().optional(),
    telefono: z.string().optional(),
    notas: z.string().optional(),
    metodoPago: z.string().optional(),
    codigoDescuentoId: z.number().int().positive().optional(),
    notificarWhatsapp: z.boolean().optional().default(false),
    items: z.array(z.object({
        productoId: z.number().int().positive(),
        varianteId: z.number().int().positive().optional(),
        cantidad: z.number().int().positive().default(1),
        ingredientesExcluidos: z.array(z.number().int().positive()).optional(),
        agregados: z.array(z.object({
            id: z.number().int().positive(),
            nombre: z.string(),
            precio: z.string()
        })).optional(),
        esCanjePuntos: z.boolean().optional().default(false)
    })).min(1)
})

publicRoute.post('/delivery/create', zValidator('json', createDeliverySchema), async (c) => {
    const db = drizzle(pool)
    const { restauranteId, direccion, lat, lng, nombreCliente, telefono, notas, metodoPago, codigoDescuentoId, items, notificarWhatsapp } = c.req.valid('json')

    try {
        const uniqueProductosIds = [...new Set(items.map(i => i.productoId))]
        const productosRaw = await db.select().from(ProductoTable).where(and(
            inArray(ProductoTable.id, uniqueProductosIds),
            eq(ProductoTable.restauranteId, restauranteId)
        ))
        const puntosRows = await db.select().from(ProductoPuntosTable).where(inArray(ProductoPuntosTable.productoId, uniqueProductosIds))
        const puntosMap = new Map(puntosRows.map(pp => [pp.productoId, pp]))

        if (productosRaw.length !== uniqueProductosIds.length) {
            return c.json({ message: 'Algunos productos no fueron encontrados', success: false }, 400)
        }

        const productosMap = new Map(productosRaw.map(p => [p.id, { producto: p, puntos: puntosMap.get(p.id) ?? null }]))

        const uniqueVariantesIds = [...new Set(items.map(i => i.varianteId).filter(Boolean))] as number[];
        let variantesMap = new Map();
        if (uniqueVariantesIds.length > 0) {
            const variantesRaw = await db.select().from(VarianteProductoTable).where(inArray(VarianteProductoTable.id, uniqueVariantesIds));
            variantesMap = new Map(variantesRaw.map(v => [v.id, v]));
        }

        let total = 0
        let puntosGanados = 0;
        let puntosUsados = 0;

        for (const item of items) {
            const row = productosMap.get(item.productoId)!
            if (item.esCanjePuntos) {
                if (!row.puntos || row.puntos.puntosNecesarios <= 0) {
                    return c.json({ message: 'El producto no es canjeable por puntos', success: false }, 400)
                }
                puntosUsados += row.puntos.puntosNecesarios * item.cantidad
            } else {
                let precioBase = parseFloat(row.producto.precio)
                if (item.varianteId && variantesMap.has(item.varianteId)) {
                    precioBase = parseFloat(variantesMap.get(item.varianteId).precio)
                }
                const descuento = row.producto.descuento || 0
                if (descuento > 0) {
                    precioBase = precioBase * (1 - descuento / 100)
                }

                // Sumar el precio de los agregados
                if (item.agregados && item.agregados.length > 0) {
                    for (const ag of item.agregados) {
                        precioBase += parseFloat(ag.precio)
                    }
                }

                total += precioBase * item.cantidad
                if (row.puntos) {
                    puntosGanados += row.puntos.puntosGanados * item.cantidad
                }
            }
        }

        const resRestaurante = await db.select({
            deliveryFee: RestauranteTable.deliveryFee,
            cucuruApiKey: RestauranteTable.cucuruApiKey,
            cucuruCollectorId: RestauranteTable.cucuruCollectorId,
            cucuruConfigurado: RestauranteTable.cucuruConfigurado,
            cucuruEnabled: RestauranteTable.cucuruEnabled,
            transferenciaAlias: RestauranteTable.transferenciaAlias,
            proveedorPago: RestauranteTable.proveedorPago,
            taloClientId: RestauranteTable.taloClientId,
            taloClientSecret: RestauranteTable.taloClientSecret,
            taloUserId: RestauranteTable.taloUserId,
            username: RestauranteTable.username,
            id: RestauranteTable.id,
            mpConnected: RestauranteTable.mpConnected,
            mpPublicKey: RestauranteTable.mpPublicKey,
            cardsPaymentsEnabled: RestauranteTable.cardsPaymentsEnabled,
            metodosPagoConfig: RestauranteTable.metodosPagoConfig,
            nombre: RestauranteTable.nombre,
            notificarClientesWhatsapp: RestauranteTable.notificarClientesWhatsapp,
        }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1)

        // --- Lógica de zonas de delivery ---
        let deliveryFeeAplicado = 0
        let zonaNombre: string | null = null

        // 1. Buscar zonas configuradas para este restaurante
        const zonasDelivery = await db.select().from(ZonaDeliveryTable)
            .where(eq(ZonaDeliveryTable.restauranteId, restauranteId))

        if (zonasDelivery.length > 0 && lat !== undefined && lng !== undefined) {
            // Hay zonas configuradas → validar que el punto caiga en alguna
            const zonaMatch = findZoneForPoint({ lat, lng }, zonasDelivery)

            if (!zonaMatch) {
                return c.json({
                    message: 'Lo sentimos, tu ubicación está fuera de nuestra área de delivery.',
                    success: false,
                    code: 'FUERA_DE_ZONA'
                }, 400)
            }

            deliveryFeeAplicado = parseFloat(zonaMatch.precio)
            zonaNombre = zonaMatch.nombre
        } else if (resRestaurante.length > 0 && resRestaurante[0].deliveryFee) {
            // Fallback: usar deliveryFee global del restaurante
            deliveryFeeAplicado = parseFloat(resRestaurante[0].deliveryFee)
        }

        total += deliveryFeeAplicado
        const sistemaPuntosActivo = false; // sistemaPuntos comentado en schema

        if (!sistemaPuntosActivo) {
            puntosGanados = 0;
            if (puntosUsados > 0) return c.json({ message: 'El sistema de puntos está inactivo', success: false }, 400);
        }

        let clienteId: number | null = null;
        if (telefono && nombreCliente) {
            const clienteExistente = await db.select().from(ClienteTable).where(
                and(
                    eq(ClienteTable.telefono, telefono),
                    eq(ClienteTable.restauranteId, restauranteId)
                )
            ).limit(1);

            if (clienteExistente.length > 0) {
                clienteId = clienteExistente[0].id;
                if (puntosUsados > clienteExistente[0].puntos) {
                    return c.json({ message: 'Puntos insuficientes para realizar el canje', success: false }, 400);
                }
                const nuevosPuntos = clienteExistente[0].puntos - puntosUsados + puntosGanados;
                await db.update(ClienteTable).set({ puntos: nuevosPuntos }).where(eq(ClienteTable.id, clienteId));
            } else {
                if (puntosUsados > 0) {
                    return c.json({ message: 'Cliente no encontrado, no se pueden usar puntos', success: false }, 400);
                }
                const nuevoCliente = await db.insert(ClienteTable).values({
                    restauranteId,
                    nombre: nombreCliente,
                    telefono,
                    direccion,
                    puntos: puntosGanados,
                });
                clienteId = Number(nuevoCliente[0].insertId);
            }
        } else if (puntosUsados > 0) {
            return c.json({ message: 'Debes ingresar datos de cliente para canjear puntos', success: false }, 400);
        }

        let montoDescuento = 0
        let codigoDescuentoIdFinal: number | null = null
        if (codigoDescuentoId) {
            const [cupon] = await db.select().from(CodigoDescuentoTable).where(eq(CodigoDescuentoTable.id, codigoDescuentoId)).limit(1)
            if (!cupon || cupon.restauranteId !== restauranteId) {
                return c.json({ message: 'Código de descuento inválido', success: false }, 400)
            }
            let desc = 0
            if (cupon.tipo === 'porcentaje') desc = total * (parseFloat(cupon.valor) / 100)
            else desc = parseFloat(cupon.valor)
            montoDescuento = Math.min(desc, total)
            const updateResult = await db.update(CodigoDescuentoTable)
                .set({ usosActuales: sql`${CodigoDescuentoTable.usosActuales} + 1` })
                .where(
                    and(
                        eq(CodigoDescuentoTable.id, codigoDescuentoId),
                        eq(CodigoDescuentoTable.activo, true),
                        or(
                            isNull(CodigoDescuentoTable.limiteUsos),
                            lt(CodigoDescuentoTable.usosActuales, CodigoDescuentoTable.limiteUsos)
                        )
                    )
                )
            if (updateResult[0].affectedRows === 0) {
                return c.json({ message: 'El cupón ya no es válido o alcanzó su límite de usos', success: false }, 400)
            }
            total = Math.max(0, total - montoDescuento)
            codigoDescuentoIdFinal = codigoDescuentoId
        }

        const rDel = resRestaurante[0]!
        const pagoRowDel = rowToPagoRow(rDel)
        const resolvedDel = resolverMetodoPagoPedido(metodoPago ?? null, pagoRowDel)
        if (resolvedDel.error || !resolvedDel.metodo) {
            return c.json({ message: resolvedDel.error || 'Método de pago no disponible', success: false }, 400)
        }
        const metodoPagoEfectivoDelivery = resolvedDel.metodo

        const nuevoPedido = await db.insert(PedidoUnificadoTable).values({
            restauranteId,
            clienteId: clienteId || null,
            tipo: 'delivery',
            direccion,
            latitud: lat !== undefined ? lat.toString() : null,
            longitud: lng !== undefined ? lng.toString() : null,
            nombreCliente: nombreCliente || null,
            telefono: telefono || null,
            notas: notas || null,
            metodoPago: metodoPagoEfectivoDelivery,
            estado: 'pending',
            total: total.toFixed(2),
            codigoDescuentoId: codigoDescuentoIdFinal,
            montoDescuento: montoDescuento.toFixed(2),
            notificarWhatsapp: notificarWhatsapp || false,
        })

        const pedidoId = Number(nuevoPedido[0].insertId)

        for (const item of items) {
            const row = productosMap.get(item.productoId)!
            let precioUnitario = item.esCanjePuntos ? '0.00' : row.producto.precio
            if (!item.esCanjePuntos) {
                let precioVal = parseFloat(row.producto.precio)
                if (item.varianteId && variantesMap.has(item.varianteId)) {
                    precioVal = parseFloat(variantesMap.get(item.varianteId).precio)
                }
                const descuentoPct = row.producto.descuento || 0
                if (descuentoPct > 0) {
                    precioUnitario = (precioVal * (1 - descuentoPct / 100)).toFixed(2)
                } else {
                    precioUnitario = precioVal.toFixed(2)
                }
            }
            await db.insert(ItemPedidoUnificadoTable).values({
                pedidoId,
                productoId: item.productoId,
                varianteId: item.varianteId || null,
                varianteNombre: item.varianteId && variantesMap.has(item.varianteId) ? variantesMap.get(item.varianteId).nombre : null,
                cantidad: item.cantidad,
                precioUnitario,
                ingredientesExcluidos: item.ingredientesExcluidos?.length ? item.ingredientesExcluidos : null,
                agregados: item.agregados?.length ? item.agregados : null,
                esCanjePuntos: item.esCanjePuntos || false
            })
        }

        let cuentaCucuru = null;
        let cuentaTalo: { cvu: string; alias: string } | null = null;
        const provDel = proveedorTransferenciaDinamica(metodoPagoEfectivoDelivery, pagoRowDel)
        if (provDel === 'talo' && resRestaurante[0]?.taloClientId && resRestaurante[0]?.taloClientSecret && resRestaurante[0]?.taloUserId) {
            try {
                const taloRes = await crearPagoTalo({
                    restauranteId,
                    total,
                    pedidoId: pedidoId.toString(),
                    talo_client_id: resRestaurante[0].taloClientId,
                    talo_client_secret: resRestaurante[0].taloClientSecret,
                    talo_user_id: resRestaurante[0].taloUserId,
                });
                cuentaTalo = { cvu: taloRes.cvu, alias: taloRes.alias };
            } catch (error) {
                console.error('[Talo] Error al crear pago para pedido delivery #' + pedidoId + ':', error);
            }
        } else if (provDel === 'cucuru' && resRestaurante[0]?.cucuruConfigurado) {
            try {
                cuentaCucuru = await asignarAliasAPedido({
                    db,
                    restaurante: resRestaurante[0],
                    pedidoId,
                    slug: resRestaurante[0].username!,
                    tipoPedido: 'delivery'
                });
            } catch (error) {
                console.error("❌ Error asignando CVU/Alias de Cucuru:", error);
            }
        }

        const waitToPay = debeEsperarWebhookParaNotificar(metodoPagoEfectivoDelivery)
        try {
            const restaurante = await db.select({
                whatsappEnabled: RestauranteTable.whatsappEnabled,
                whatsappNumber: RestauranteTable.whatsappNumber,
                nombre: RestauranteTable.nombre,
                notificarClientesWhatsapp: RestauranteTable.notificarClientesWhatsapp,
            }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1);

            if (restaurante[0]?.whatsappEnabled && restaurante[0]?.whatsappNumber && !waitToPay) {
                const orderItemsForWa = items.map(item => {
                    const row = productosMap.get(item.productoId)!;
                    return {
                        name: item.esCanjePuntos ? `${row.producto.nombre} (Canje Puntos)` : row.producto.nombre,
                        quantity: item.cantidad
                    };
                });

                if (deliveryFeeAplicado > 0) {
                    orderItemsForWa.push({
                        name: zonaNombre ? `Delivery (${zonaNombre})` : 'Delivery',
                        quantity: 1
                    });
                }

                console.log("⏳ Iniciando envío de WhatsApp a:", restaurante[0].whatsappNumber);
                sendOrderWhatsApp(c, {
                    phone: restaurante[0].whatsappNumber,
                    customerName: nombreCliente || 'Cliente no especificado',
                    address: direccion || 'Sin dirección',
                    total: metodoPagoEfectivoDelivery ? `${total.toFixed(2)} (${metodoPagoEfectivoDelivery})` : total.toFixed(2),
                    items: orderItemsForWa,
                    orderId: pedidoId.toString()
                }).catch(err => {
                    console.error("❌ Error en envío de WhatsApp en background:", err);
                });
            }
        } catch (error) {
            console.error("❌ Error obteniendo datos del restaurante para WhatsApp:", error);
        }

        if (!waitToPay) {
            try {
                if (resRestaurante[0]?.notificarClientesWhatsapp && notificarWhatsapp && telefono) {
                    console.log("⏳ Iniciando envío de WhatsApp al cliente:", telefono);
                    sendClientPaymentConfirmedWhatsApp(c, {
                        phone: telefono,
                        customerName: nombreCliente || 'Cliente',
                        restaurantName: resRestaurante[0].nombre || 'El local',
                        total: total.toFixed(2),
                        orderId: pedidoId.toString()
                    }).catch(err => {
                        console.error("❌ Error en envío de WhatsApp al cliente en background:", err);
                    });
                }
            } catch (err) {
                console.error("❌ Error obteniendo datos del restaurante para enviar WhatsApp al cliente:", err);
            }

            wsManager.notifyAdmins(restauranteId, {
                id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                tipo: 'NUEVO_PEDIDO_PENDIENTE_PAGO',
                mesaId: 0,
                mesaNombre: 'Delivery',
                mensaje: `Pedido pendiente de verificación de pago`,
                detalles: `${nombreCliente || 'Cliente'} - $${total.toFixed(2)} · ${metodoPagoEfectivoDelivery}`,
                timestamp: new Date().toISOString(),
                leida: false,
                pedidoId: pedidoId
            })
            wsManager.broadcastAdminUpdate(restauranteId, 'delivery')
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
                estado: 'pending',
                aliasDinamico: cuentaCucuru?.alias || cuentaTalo?.alias || null,
                cvuDinamico: cuentaCucuru?.accountNumber || cuentaTalo?.cvu || null,
                deliveryFee: deliveryFeeAplicado.toFixed(2),
                zonaNombre
            }
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
    metodoPago: z.string().optional(),
    codigoDescuentoId: z.number().int().positive().optional(),
    notificarWhatsapp: z.boolean().optional().default(false),
    items: z.array(z.object({
        productoId: z.number().int().positive(),
        varianteId: z.number().int().positive().optional(),
        cantidad: z.number().int().positive().default(1),
        ingredientesExcluidos: z.array(z.number().int().positive()).optional(),
        agregados: z.array(z.object({
            id: z.number().int().positive(),
            nombre: z.string(),
            precio: z.string()
        })).optional(),
        esCanjePuntos: z.boolean().optional().default(false)
    })).min(1)
})

publicRoute.post('/takeaway/create', zValidator('json', createTakeawaySchema), async (c) => {
    const db = drizzle(pool)
    const { restauranteId, nombreCliente, telefono, notas, metodoPago, codigoDescuentoId, items, notificarWhatsapp } = c.req.valid('json')

    try {
        const uniqueProductosIds = [...new Set(items.map(i => i.productoId))]
        const productosRaw = await db.select().from(ProductoTable).where(and(
            inArray(ProductoTable.id, uniqueProductosIds),
            eq(ProductoTable.restauranteId, restauranteId)
        ))
        const puntosRows = await db.select().from(ProductoPuntosTable).where(inArray(ProductoPuntosTable.productoId, uniqueProductosIds))
        const puntosMap = new Map(puntosRows.map(pp => [pp.productoId, pp]))

        if (productosRaw.length !== uniqueProductosIds.length) {
            return c.json({ message: 'Algunos productos no fueron encontrados', success: false }, 400)
        }

        const productosMap = new Map(productosRaw.map(p => [p.id, { producto: p, puntos: puntosMap.get(p.id) ?? null }]))

        const uniqueVariantesIds = [...new Set(items.map(i => i.varianteId).filter(Boolean))] as number[];
        let variantesMap = new Map();
        if (uniqueVariantesIds.length > 0) {
            const variantesRaw = await db.select().from(VarianteProductoTable).where(inArray(VarianteProductoTable.id, uniqueVariantesIds));
            variantesMap = new Map(variantesRaw.map(v => [v.id, v]));
        }

        let total = 0
        let puntosGanados = 0;
        let puntosUsados = 0;

        for (const item of items) {
            const row = productosMap.get(item.productoId)!
            if (item.esCanjePuntos) {
                if (!row.puntos || row.puntos.puntosNecesarios <= 0) {
                    return c.json({ message: 'El producto no es canjeable por puntos', success: false }, 400)
                }
                puntosUsados += row.puntos.puntosNecesarios * item.cantidad
            } else {
                let precioBase = parseFloat(row.producto.precio)
                if (item.varianteId && variantesMap.has(item.varianteId)) {
                    precioBase = parseFloat(variantesMap.get(item.varianteId).precio)
                }
                const descuento = row.producto.descuento || 0
                if (descuento > 0) {
                    precioBase = precioBase * (1 - descuento / 100)
                }

                // Sumar el precio de los agregados
                if (item.agregados && item.agregados.length > 0) {
                    for (const ag of item.agregados) {
                        precioBase += parseFloat(ag.precio)
                    }
                }

                total += precioBase * item.cantidad
                if (row.puntos) {
                    puntosGanados += row.puntos.puntosGanados * item.cantidad
                }
            }
        }

        const resRestaurante = await db.select({
            cucuruApiKey: RestauranteTable.cucuruApiKey,
            cucuruCollectorId: RestauranteTable.cucuruCollectorId,
            cucuruConfigurado: RestauranteTable.cucuruConfigurado,
            cucuruEnabled: RestauranteTable.cucuruEnabled,
            transferenciaAlias: RestauranteTable.transferenciaAlias,
            proveedorPago: RestauranteTable.proveedorPago,
            taloClientId: RestauranteTable.taloClientId,
            taloClientSecret: RestauranteTable.taloClientSecret,
            taloUserId: RestauranteTable.taloUserId,
            username: RestauranteTable.username,
            id: RestauranteTable.id,
            mpConnected: RestauranteTable.mpConnected,
            mpPublicKey: RestauranteTable.mpPublicKey,
            cardsPaymentsEnabled: RestauranteTable.cardsPaymentsEnabled,
            metodosPagoConfig: RestauranteTable.metodosPagoConfig,
            nombre: RestauranteTable.nombre,
            notificarClientesWhatsapp: RestauranteTable.notificarClientesWhatsapp,
        }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1)
        const sistemaPuntosActivo = false; // sistemaPuntos comentado en schema

        if (!sistemaPuntosActivo) {
            puntosGanados = 0;
            if (puntosUsados > 0) return c.json({ message: 'El sistema de puntos está inactivo', success: false }, 400);
        }

        let clienteId: number | null = null;
        if (telefono && nombreCliente) {
            const clienteExistente = await db.select().from(ClienteTable).where(
                and(
                    eq(ClienteTable.telefono, telefono),
                    eq(ClienteTable.restauranteId, restauranteId)
                )
            ).limit(1);

            if (clienteExistente.length > 0) {
                clienteId = clienteExistente[0].id;
                if (puntosUsados > clienteExistente[0].puntos) {
                    return c.json({ message: 'Puntos insuficientes para realizar el canje', success: false }, 400);
                }
                const nuevosPuntos = clienteExistente[0].puntos - puntosUsados + puntosGanados;
                await db.update(ClienteTable).set({ puntos: nuevosPuntos }).where(eq(ClienteTable.id, clienteId));
            } else {
                if (puntosUsados > 0) {
                    return c.json({ message: 'Cliente no encontrado, no se pueden usar puntos', success: false }, 400);
                }
                const nuevoCliente = await db.insert(ClienteTable).values({
                    restauranteId,
                    nombre: nombreCliente,
                    telefono,
                    puntos: puntosGanados,
                });
                clienteId = Number(nuevoCliente[0].insertId);
            }
        } else if (puntosUsados > 0) {
            return c.json({ message: 'Debes ingresar datos de cliente para canjear puntos', success: false }, 400);
        }

        let montoDescuentoTk = 0
        let codigoDescuentoIdFinalTk: number | null = null
        if (codigoDescuentoId) {
            const [cupon] = await db.select().from(CodigoDescuentoTable).where(eq(CodigoDescuentoTable.id, codigoDescuentoId)).limit(1)
            if (!cupon || cupon.restauranteId !== restauranteId) {
                return c.json({ message: 'Código de descuento inválido', success: false }, 400)
            }
            let desc = 0
            if (cupon.tipo === 'porcentaje') desc = total * (parseFloat(cupon.valor) / 100)
            else desc = parseFloat(cupon.valor)
            montoDescuentoTk = Math.min(desc, total)
            const updateResult = await db.update(CodigoDescuentoTable)
                .set({ usosActuales: sql`${CodigoDescuentoTable.usosActuales} + 1` })
                .where(
                    and(
                        eq(CodigoDescuentoTable.id, codigoDescuentoId),
                        eq(CodigoDescuentoTable.activo, true),
                        or(
                            isNull(CodigoDescuentoTable.limiteUsos),
                            lt(CodigoDescuentoTable.usosActuales, CodigoDescuentoTable.limiteUsos)
                        )
                    )
                )
            if (updateResult[0].affectedRows === 0) {
                return c.json({ message: 'El cupón ya no es válido o alcanzó su límite de usos', success: false }, 400)
            }
            total = Math.max(0, total - montoDescuentoTk)
            codigoDescuentoIdFinalTk = codigoDescuentoId
        }

        const rTk = resRestaurante[0]!
        const pagoRowTk = rowToPagoRow(rTk)
        const resolvedTk = resolverMetodoPagoPedido(metodoPago ?? null, pagoRowTk)
        if (resolvedTk.error || !resolvedTk.metodo) {
            return c.json({ message: resolvedTk.error || 'Método de pago no disponible', success: false }, 400)
        }
        const metodoPagoEfectivo = resolvedTk.metodo

        const nuevoPedido = await db.insert(PedidoUnificadoTable).values({
            restauranteId,
            clienteId: clienteId || null,
            tipo: 'takeaway',
            nombreCliente: nombreCliente || null,
            telefono: telefono || null,
            notas: notas || null,
            metodoPago: metodoPagoEfectivo,
            estado: 'pending',
            total: total.toFixed(2),
            codigoDescuentoId: codigoDescuentoIdFinalTk,
            montoDescuento: montoDescuentoTk.toFixed(2),
            notificarWhatsapp: notificarWhatsapp || false,
        })

        const pedidoId = Number(nuevoPedido[0].insertId)

        for (const item of items) {
            const row = productosMap.get(item.productoId)!
            let precioUnitario = item.esCanjePuntos ? '0.00' : row.producto.precio
            if (!item.esCanjePuntos) {
                let precioVal = parseFloat(row.producto.precio)
                if (item.varianteId && variantesMap.has(item.varianteId)) {
                    precioVal = parseFloat(variantesMap.get(item.varianteId).precio)
                }
                const descuentoPct = row.producto.descuento || 0
                if (descuentoPct > 0) {
                    precioUnitario = (precioVal * (1 - descuentoPct / 100)).toFixed(2)
                } else {
                    precioUnitario = precioVal.toFixed(2)
                }
            }
            await db.insert(ItemPedidoUnificadoTable).values({
                pedidoId,
                productoId: item.productoId,
                varianteId: item.varianteId || null,
                varianteNombre: item.varianteId && variantesMap.has(item.varianteId) ? variantesMap.get(item.varianteId).nombre : null,
                cantidad: item.cantidad,
                precioUnitario,
                ingredientesExcluidos: item.ingredientesExcluidos?.length ? item.ingredientesExcluidos : null,
                agregados: item.agregados?.length ? item.agregados : null,
                esCanjePuntos: item.esCanjePuntos || false
            })
        }

        let cuentaCucuru = null;
        let cuentaTalo: { cvu: string; alias: string } | null = null;
        const provTk = proveedorTransferenciaDinamica(metodoPagoEfectivo, pagoRowTk)
        if (provTk === 'talo' && resRestaurante[0]?.taloClientId && resRestaurante[0]?.taloClientSecret && resRestaurante[0]?.taloUserId) {
            try {
                const taloRes = await crearPagoTalo({
                    restauranteId,
                    total,
                    pedidoId: pedidoId.toString(),
                    talo_client_id: resRestaurante[0].taloClientId,
                    talo_client_secret: resRestaurante[0].taloClientSecret,
                    talo_user_id: resRestaurante[0].taloUserId,
                });
                cuentaTalo = { cvu: taloRes.cvu, alias: taloRes.alias };
            } catch (error) {
                console.error('[Talo] Error al crear pago para pedido takeaway #' + pedidoId + ':', error);
            }
        } else if (provTk === 'cucuru' && resRestaurante[0]?.cucuruConfigurado) {
            try {
                console.log(`🛍️ [Takeaway] Asignando CVU Cucuru para pedido #${pedidoId} (restaurante ${restauranteId})`);
                cuentaCucuru = await asignarAliasAPedido({
                    db,
                    restaurante: resRestaurante[0],
                    pedidoId,
                    slug: resRestaurante[0].username!,
                    tipoPedido: 'takeaway'
                });
                console.log(`✅ [Takeaway] CVU asignado: ${cuentaCucuru?.alias} -> pedido #${pedidoId}`);
            } catch (error) {
                console.error("❌ [Takeaway] Error asignando CVU/Alias de Cucuru - el pedido NO recibirá webhook automático:", error);
            }
        }

        const waitToPay = debeEsperarWebhookParaNotificar(metodoPagoEfectivo)
        try {
            const restaurante = await db.select({
                whatsappEnabled: RestauranteTable.whatsappEnabled,
                whatsappNumber: RestauranteTable.whatsappNumber,
                nombre: RestauranteTable.nombre,
                notificarClientesWhatsapp: RestauranteTable.notificarClientesWhatsapp,
            }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1);

            if (restaurante[0]?.whatsappEnabled && restaurante[0]?.whatsappNumber && !waitToPay) {
                const orderItemsForWa = items.map(item => {
                    const row = productosMap.get(item.productoId)!;
                    return {
                        name: item.esCanjePuntos ? `${row.producto.nombre} (Canje Puntos)` : row.producto.nombre,
                        quantity: item.cantidad
                    };
                });

                console.log("⏳ Iniciando envío de WhatsApp a:", restaurante[0].whatsappNumber);
                sendOrderWhatsApp(c, {
                    phone: restaurante[0].whatsappNumber,
                    customerName: nombreCliente || 'Cliente no especificado',
                    address: 'Retira en local (Take Away)',
                    total: metodoPagoEfectivo ? `${total.toFixed(2)} (${metodoPagoEfectivo})` : total.toFixed(2),
                    items: orderItemsForWa,
                    orderId: pedidoId.toString()
                }).catch(err => {
                    console.error("❌ Error en envío de WhatsApp en background:", err);
                });
            }
        } catch (error) {
            console.error("❌ Error obteniendo datos del restaurante para WhatsApp:", error);
        }

        if (!waitToPay) {
            try {
                if (resRestaurante[0]?.notificarClientesWhatsapp && notificarWhatsapp && telefono) {
                    console.log("⏳ Iniciando envío de WhatsApp al cliente:", telefono);
                    sendClientPaymentConfirmedWhatsApp(c, {
                        phone: telefono,
                        customerName: nombreCliente || 'Cliente',
                        restaurantName: resRestaurante[0].nombre || 'El local',
                        total: total.toFixed(2),
                        orderId: pedidoId.toString()
                    }).catch(err => {
                        console.error("❌ Error en envío de WhatsApp al cliente en background:", err);
                    });
                }
            } catch (err) {
                console.error("❌ Error obteniendo datos del restaurante para enviar WhatsApp al cliente:", err);
            }

            wsManager.notifyAdmins(restauranteId, {
                id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                tipo: 'NUEVO_PEDIDO_PENDIENTE_PAGO',
                mesaId: 0,
                mesaNombre: 'Take Away',
                mensaje: `Pedido pendiente de verificación de pago`,
                detalles: `${nombreCliente || 'Cliente'} - $${total.toFixed(2)} · ${metodoPagoEfectivo}`,
                timestamp: new Date().toISOString(),
                leida: false,
                pedidoId: pedidoId
            })
            wsManager.broadcastAdminUpdate(restauranteId, 'takeaway')
        }

        return c.json({
            message: 'Pedido de takeaway creado correctamente',
            success: true,
            data: {
                id: pedidoId,
                nombreCliente,
                telefono,
                total: total.toFixed(2),
                estado: 'pending',
                aliasDinamico: cuentaCucuru?.alias || cuentaTalo?.alias || null,
                cvuDinamico: cuentaCucuru?.accountNumber || cuentaTalo?.cvu || null
            }
        }, 201)
    } catch (error) {
        console.error('Error creating public takeaway:', error)
        return c.json({ message: 'Error creating takeaway', error: (error as Error).message }, 500)
    }
})

const setMetodoPagoSchema = z.object({
    metodoPago: z.string().min(1)
})

publicRoute.put('/delivery/:id/metodo-pago', zValidator('json', setMetodoPagoSchema), async (c) => {
    const db = drizzle(pool)
    const id = parseInt(c.req.param('id'))
    const { metodoPago } = c.req.valid('json')

    try {
        const result = await db.update(PedidoUnificadoTable)
            .set({ metodoPago })
            .where(and(eq(PedidoUnificadoTable.id, id), eq(PedidoUnificadoTable.tipo, 'delivery')))

        if (result[0].affectedRows === 0) {
            return c.json({ message: 'Pedido no encontrado', success: false }, 404)
        }

        const pedido = await db.select({ restauranteId: PedidoUnificadoTable.restauranteId }).from(PedidoUnificadoTable).where(eq(PedidoUnificadoTable.id, id)).limit(1)
        if (pedido.length > 0 && pedido[0].restauranteId) {
            wsManager.broadcastAdminUpdate(pedido[0].restauranteId, 'delivery')
        }

        return c.json({ message: 'Método de pago actualizado', success: true }, 200)
    } catch (error) {
        return c.json({ message: 'Error', error: (error as Error).message }, 500)
    }
})

publicRoute.put('/takeaway/:id/metodo-pago', zValidator('json', setMetodoPagoSchema), async (c) => {
    const db = drizzle(pool)
    const id = parseInt(c.req.param('id'))
    const { metodoPago } = c.req.valid('json')

    try {
        const result = await db.update(PedidoUnificadoTable)
            .set({ metodoPago })
            .where(and(eq(PedidoUnificadoTable.id, id), eq(PedidoUnificadoTable.tipo, 'takeaway')))

        if (result[0].affectedRows === 0) {
            return c.json({ message: 'Pedido no encontrado', success: false }, 404)
        }

        const pedido = await db.select({ restauranteId: PedidoUnificadoTable.restauranteId }).from(PedidoUnificadoTable).where(eq(PedidoUnificadoTable.id, id)).limit(1)
        if (pedido.length > 0 && pedido[0].restauranteId) {
            wsManager.broadcastAdminUpdate(pedido[0].restauranteId, 'takeaway')
        }

        return c.json({ message: 'Método de pago actualizado', success: true }, 200)
    } catch (error) {
        return c.json({ message: 'Error', error: (error as Error).message }, 500)
    }
})

publicRoute.get('/restaurante/:id/cliente/:telefono', async (c) => {
    const db = drizzle(pool)
    const id = parseInt(c.req.param('id'))
    const telefono = c.req.param('telefono')

    try {
        const cliente = await db.select({
            id: ClienteTable.id,
            nombre: ClienteTable.nombre,
            puntos: ClienteTable.puntos
        }).from(ClienteTable).where(
            and(
                eq(ClienteTable.restauranteId, id),
                eq(ClienteTable.telefono, telefono)
            )
        ).limit(1)

        if (cliente.length === 0) {
            return c.json({ message: 'Cliente no encontrado', success: false }, 404)
        }

        return c.json({ message: 'Cliente encontrado', success: true, data: cliente[0] }, 200)
    } catch (error) {
        console.error('Error getting client:', error)
        return c.json({ message: 'Error', error: (error as Error).message }, 500)
    }
})

// Check delivery zone for a given lat/lng (public, no auth needed)
publicRoute.get('/restaurante/:id/check-zona', async (c) => {
    const db = drizzle(pool)
    const restauranteId = parseInt(c.req.param('id'), 10)
    const lat = parseFloat(c.req.query('lat') || '')
    const lng = parseFloat(c.req.query('lng') || '')

    if (isNaN(restauranteId) || isNaN(lat) || isNaN(lng)) {
        return c.json({ success: false, message: 'Parámetros inválidos' }, 400)
    }

    try {
        const zonasDelivery = await db.select().from(ZonaDeliveryTable)
            .where(eq(ZonaDeliveryTable.restauranteId, restauranteId))

        if (zonasDelivery.length === 0) {
            // No zones configured — fallback to global deliveryFee
            const resRestaurante = await db.select({
                deliveryFee: RestauranteTable.deliveryFee
            }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1)

            const fee = resRestaurante.length > 0 && resRestaurante[0].deliveryFee
                ? resRestaurante[0].deliveryFee
                : '0.00'

            return c.json({
                success: true,
                tieneZonas: false,
                deliveryFee: fee,
                zonaNombre: null
            }, 200)
        }

        // Zones exist — check if point is in any
        const zonaMatch = findZoneForPoint({ lat, lng }, zonasDelivery)

        if (!zonaMatch) {
            return c.json({
                success: false,
                code: 'FUERA_DE_ZONA',
                message: 'Tu ubicación está fuera de nuestra área de delivery.'
            }, 200) // 200 so the frontend can handle it gracefully
        }

        return c.json({
            success: true,
            tieneZonas: true,
            deliveryFee: zonaMatch.precio,
            zonaNombre: zonaMatch.nombre
        }, 200)
    } catch (error) {
        console.error('Error checking delivery zone:', error)
        return c.json({ success: false, message: 'Error al verificar zona' }, 500)
    }
})

publicRoute.get('/restaurante/:id/mis-pedidos/:telefono', async (c) => {
    const db = drizzle(pool)
    const restauranteId = parseInt(c.req.param('id'), 10)
    const telefono = c.req.param('telefono')

    if (isNaN(restauranteId) || !telefono) {
        return c.json({ success: false, message: 'Parámetros inválidos' }, 400)
    }

    try {
        const pedidosDT = await db
            .select({
                id: PedidoUnificadoTable.id,
                tipo: PedidoUnificadoTable.tipo,
                estado: PedidoUnificadoTable.estado,
                total: PedidoUnificadoTable.total,
                nombreCliente: PedidoUnificadoTable.nombreCliente,
                direccion: PedidoUnificadoTable.direccion,
                notas: PedidoUnificadoTable.notas,
                metodoPago: PedidoUnificadoTable.metodoPago,
                pagado: PedidoUnificadoTable.pagado,
                createdAt: PedidoUnificadoTable.createdAt,
                deliveredAt: PedidoUnificadoTable.deliveredAt,
                rapiboyTrackingUrl: PedidoUnificadoTable.rapiboyTrackingUrl,
            })
            .from(PedidoUnificadoTable)
            .where(and(
                eq(PedidoUnificadoTable.restauranteId, restauranteId),
                eq(PedidoUnificadoTable.telefono, telefono),
                eq(PedidoUnificadoTable.pagado, true)
            ))
            .orderBy(desc(PedidoUnificadoTable.createdAt))

        const pedidosConItems = await Promise.all(
            pedidosDT.map(async (p) => {
                const items = await db
                    .select({
                        id: ItemPedidoUnificadoTable.id,
                        productoId: ItemPedidoUnificadoTable.productoId,
                        cantidad: ItemPedidoUnificadoTable.cantidad,
                        precioUnitario: ItemPedidoUnificadoTable.precioUnitario,
                        varianteId: ItemPedidoUnificadoTable.varianteId,
                        varianteNombre: ItemPedidoUnificadoTable.varianteNombre,
                        ingredientesExcluidos: ItemPedidoUnificadoTable.ingredientesExcluidos,
                        agregados: ItemPedidoUnificadoTable.agregados,
                        esCanjePuntos: ItemPedidoUnificadoTable.esCanjePuntos,
                        productoNombre: ProductoTable.nombre,
                    })
                    .from(ItemPedidoUnificadoTable)
                    .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
                    .where(eq(ItemPedidoUnificadoTable.pedidoId, p.id))

                const totalItems = items.reduce((sum, i) => sum + (i.cantidad ?? 1), 0)
                return { ...p, items, totalItems }
            })
        )

        const pedidos = pedidosConItems
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

        return c.json({ success: true, data: pedidos }, 200)
    } catch (error) {
        console.error('Error fetching mis pedidos:', error)
        return c.json({ success: false, message: 'Error al obtener pedidos', error: (error as Error).message }, 500)
    }
})

publicRoute.get('/pedido/:tipo/:id/status', async (c) => {
    const tipo = c.req.param('tipo');
    const id = Number(c.req.param('id'));

    try {
        const db = drizzle(pool);
        let pagado = false;
        let estado: string | null = null;
        let rapiboyTrackingUrl: string | null = null;

        if (tipo === 'delivery' || tipo === 'takeaway') {
            const p = await db.select({ pagado: PedidoUnificadoTable.pagado, estado: PedidoUnificadoTable.estado, rapiboyTrackingUrl: PedidoUnificadoTable.rapiboyTrackingUrl }).from(PedidoUnificadoTable).where(and(eq(PedidoUnificadoTable.id, id), eq(PedidoUnificadoTable.tipo, tipo))).limit(1);
            if (p.length > 0) { pagado = p[0].pagado; estado = p[0].estado; rapiboyTrackingUrl = p[0].rapiboyTrackingUrl; }
        }

        return c.json({ success: true, pagado, estado, rapiboyTrackingUrl }, 200);
    } catch (error) {
        console.error('Error consultando estado del pedido:', error);
        return c.json({ success: false, error: 'Internal server error' }, 500);
    }
});

/**
 * Obtener información completa de un pedido unificado por ID.
 * Endpoint público usado por la pantalla /pedido/:id (post-pago MP redirect).
 * Devuelve: pedido + items + datos del restaurante necesarios para la UI.
 */
publicRoute.get('/pedido-info/:id', async (c) => {
    const db = drizzle(pool)
    const id = Number(c.req.param('id'))

    if (!id || isNaN(id)) {
        return c.json({ success: false, error: 'ID inválido' }, 400)
    }

    try {
        // 1. Obtener pedido
        const pedidos = await db.select().from(PedidoUnificadoTable).where(eq(PedidoUnificadoTable.id, id)).limit(1)
        if (pedidos.length === 0) {
            return c.json({ success: false, error: 'Pedido no encontrado' }, 404)
        }
        const pedido = pedidos[0]

        // 2. Obtener items con nombres de producto
        const items = await db
            .select({
                id: ItemPedidoUnificadoTable.id,
                productoId: ItemPedidoUnificadoTable.productoId,
                cantidad: ItemPedidoUnificadoTable.cantidad,
                precioUnitario: ItemPedidoUnificadoTable.precioUnitario,
                varianteId: ItemPedidoUnificadoTable.varianteId,
                varianteNombre: ItemPedidoUnificadoTable.varianteNombre,
                ingredientesExcluidos: ItemPedidoUnificadoTable.ingredientesExcluidos,
                agregados: ItemPedidoUnificadoTable.agregados,
                esCanjePuntos: ItemPedidoUnificadoTable.esCanjePuntos,
                nombreProducto: ProductoTable.nombre,
            })
            .from(ItemPedidoUnificadoTable)
            .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
            .where(eq(ItemPedidoUnificadoTable.pedidoId, id))

        // 3. Obtener datos del restaurante necesarios para la UI
        const restaurantes = await db.select({
            id: RestauranteTable.id,
            nombre: RestauranteTable.nombre,
            username: RestauranteTable.username,
            direccion: RestauranteTable.direccion,
            telefono: RestauranteTable.telefono,
            deliveryFee: RestauranteTable.deliveryFee,
            transferenciaAlias: RestauranteTable.transferenciaAlias,
            mpConnected: RestauranteTable.mpConnected,
            mpPublicKey: RestauranteTable.mpPublicKey,
            colorPrimario: RestauranteTable.colorPrimario,
            colorSecundario: RestauranteTable.colorSecundario,
            comprobantesWhatsapp: RestauranteTable.comprobantesWhatsapp,
        }).from(RestauranteTable).where(eq(RestauranteTable.id, pedido.restauranteId)).limit(1)

        const restaurante = restaurantes[0] || null

        return c.json({
            success: true,
            data: {
                pedido: {
                    id: pedido.id,
                    tipo: pedido.tipo,
                    estado: pedido.estado,
                    total: pedido.total,
                    pagado: pedido.pagado,
                    metodoPago: pedido.metodoPago,
                    nombreCliente: pedido.nombreCliente,
                    telefono: pedido.telefono,
                    direccion: pedido.direccion,
                    notas: pedido.notas,
                    montoDescuento: pedido.montoDescuento,
                    rapiboyTrackingUrl: pedido.rapiboyTrackingUrl,
                    createdAt: pedido.createdAt,
                },
                items: items.map(i => ({
                    id: i.id,
                    productoId: i.productoId,
                    cantidad: i.cantidad,
                    precio: i.precioUnitario,
                    varianteId: i.varianteId,
                    varianteNombre: i.varianteNombre,
                    nombreProducto: i.nombreProducto,
                    ingredientesExcluidos: i.ingredientesExcluidos,
                    agregados: i.agregados,
                    esCanjePuntos: i.esCanjePuntos,
                })),
                restaurante,
            }
        })
    } catch (error) {
        console.error('Error obteniendo info del pedido:', error)
        return c.json({ success: false, error: 'Internal server error' }, 500)
    }
})

export { publicRoute }

