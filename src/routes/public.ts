import { Hono } from 'hono'
import { pool } from '../db'
import { restaurante as RestauranteTable, producto as ProductoTable, categoria as CategoriaTable, etiqueta as EtiquetaTable, productoIngrediente as ProductoIngredienteTable, ingrediente as IngredienteTable, agregado as AgregadoTable, productoAgregado as ProductoAgregadoTable, horarioRestaurante as HorarioRestauranteTable, codigoDescuento as CodigoDescuentoTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, desc, or, lt, isNull, sql } from 'drizzle-orm'
import { wsManager } from '../websocket/manager'
import { sendOrderWhatsApp } from '../services/whatsapp'
import { productoPuntos as ProductoPuntosTable, zonaDelivery as ZonaDeliveryTable } from '../db/schema'
import { asignarAliasAPedido } from '../services/cucuru'
import { findZoneForPoint } from '../utils/geo'
import UUID = require("uuid-js");

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
            mpConnected: RestauranteTable.mpConnected,
            transferenciaAlias: RestauranteTable.transferenciaAlias,
            sistemaPuntos: RestauranteTable.sistemaPuntos,
            colorPrimario: RestauranteTable.colorPrimario,
            colorSecundario: RestauranteTable.colorSecundario,
            disenoAlternativo: RestauranteTable.disenoAlternativo,
            orderGroupEnabled: RestauranteTable.orderGroupEnabled,
        })
            .from(RestauranteTable)
            .where(eq(RestauranteTable.username, username))
            .limit(1)

        if (!restaurante || restaurante.length === 0) {
            return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
        }

        const restauranteId = restaurante[0].id

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

        // Obtener productos activos con categoría (columnas planas para evitar null en Drizzle)
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
                descuento: ProductoTable.descuento,
                createdAt: ProductoTable.createdAt,
                categoriaIdCat: CategoriaTable.id,
                categoriaNombre: CategoriaTable.nombre,
                puntosNecesarios: ProductoPuntosTable.puntosNecesarios,
                puntosGanados: ProductoPuntosTable.puntosGanados,
            })
            .from(ProductoTable)
            .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
            .leftJoin(ProductoPuntosTable, eq(ProductoTable.id, ProductoPuntosTable.productoId))
            .where(and(eq(ProductoTable.restauranteId, restauranteId), eq(ProductoTable.activo, true)))

        // Obtener ingredientes y agregados para cada producto
        const productosConIngredientes = await Promise.all(
            productosRaw.map(async (p) => {
                const [ingredientes, agregados] = await Promise.all([
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
                        .where(eq(ProductoAgregadoTable.productoId, p.id))
                ]);

                const { categoriaIdCat, categoriaNombre, ...rest } = p
                return {
                    ...rest,
                    categoria: categoriaNombre ?? null,
                    ingredientes: ingredientes,
                    agregados: agregados,
                }
            })
        )

        return c.json({
            message: 'Datos obtenidos correctamente',
            success: true,
            data: {
                restaurante: restaurante[0],
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
    items: z.array(z.object({
        productoId: z.number().int().positive(),
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
    const { restauranteId, direccion, lat, lng, nombreCliente, telefono, notas, metodoPago, codigoDescuentoId, items } = c.req.valid('json')

    try {
        const uniqueProductosIds = [...new Set(items.map(i => i.productoId))]
        const productos = await db
            .select({
                producto: ProductoTable,
                puntos: ProductoPuntosTable
            })
            .from(ProductoTable)
            .leftJoin(ProductoPuntosTable, eq(ProductoTable.id, ProductoPuntosTable.productoId))
            .where(and(
                require('drizzle-orm').inArray(ProductoTable.id, uniqueProductosIds),
                eq(ProductoTable.restauranteId, restauranteId)
            ))

        if (productos.length !== uniqueProductosIds.length) {
            return c.json({ message: 'Algunos productos no fueron encontrados', success: false }, 400)
        }

        const productosMap = new Map(productos.map(p => [p.producto.id, p]))

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
            sistemaPuntos: RestauranteTable.sistemaPuntos,
            cucuruApiKey: RestauranteTable.cucuruApiKey,
            cucuruCollectorId: RestauranteTable.cucuruCollectorId,
            cucuruConfigurado: RestauranteTable.cucuruConfigurado,
            username: RestauranteTable.username,
            id: RestauranteTable.id
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
        const sistemaPuntosActivo = resRestaurante.length > 0 && resRestaurante[0].sistemaPuntos;

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

        // CRÍTICO: Cuando cucuruConfigurado, asumir transferencia si no se especificó
        const metodoPagoEfectivoDelivery = metodoPago || (resRestaurante[0]?.cucuruConfigurado ? 'transferencia' : null)

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
        })

        const pedidoId = Number(nuevoPedido[0].insertId)

        for (const item of items) {
            const row = productosMap.get(item.productoId)!
            let precioUnitario = item.esCanjePuntos ? '0.00' : row.producto.precio
            if (!item.esCanjePuntos && (row.producto.descuento || 0) > 0) {
                const descuentoPct = row.producto.descuento || 0
                precioUnitario = (parseFloat(row.producto.precio) * (1 - descuentoPct / 100)).toFixed(2)
            }
            await db.insert(ItemPedidoUnificadoTable).values({
                pedidoId,
                productoId: item.productoId,
                cantidad: item.cantidad,
                precioUnitario,
                ingredientesExcluidos: item.ingredientesExcluidos?.length ? item.ingredientesExcluidos : null,
                agregados: item.agregados?.length ? item.agregados : null,
                esCanjePuntos: item.esCanjePuntos || false
            })
        }

        let cuentaCucuru = null;
        if (metodoPagoEfectivoDelivery === 'transferencia' && resRestaurante[0]?.cucuruConfigurado) {
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

        // Notificación por WhatsApp
        const waitToPay = metodoPagoEfectivoDelivery === 'transferencia' && resRestaurante[0]?.cucuruConfigurado;
        try {
            const restaurante = await db.select({
                whatsappEnabled: RestauranteTable.whatsappEnabled,
                whatsappNumber: RestauranteTable.whatsappNumber,
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
                    total: metodoPago ? `${total.toFixed(2)} (${metodoPago})` : total.toFixed(2),
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
                cucuruAlias: cuentaCucuru?.alias,
                cucuruAccountNumber: cuentaCucuru?.accountNumber,
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
    items: z.array(z.object({
        productoId: z.number().int().positive(),
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
    const { restauranteId, nombreCliente, telefono, notas, metodoPago, codigoDescuentoId, items } = c.req.valid('json')

    try {
        const uniqueProductosIds = [...new Set(items.map(i => i.productoId))]
        const productos = await db
            .select({
                producto: ProductoTable,
                puntos: ProductoPuntosTable
            })
            .from(ProductoTable)
            .leftJoin(ProductoPuntosTable, eq(ProductoTable.id, ProductoPuntosTable.productoId))
            .where(and(
                require('drizzle-orm').inArray(ProductoTable.id, uniqueProductosIds),
                eq(ProductoTable.restauranteId, restauranteId)
            ))

        if (productos.length !== uniqueProductosIds.length) {
            return c.json({ message: 'Algunos productos no fueron encontrados', success: false }, 400)
        }

        const productosMap = new Map(productos.map(p => [p.producto.id, p]))

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
            sistemaPuntos: RestauranteTable.sistemaPuntos,
            cucuruApiKey: RestauranteTable.cucuruApiKey,
            cucuruCollectorId: RestauranteTable.cucuruCollectorId,
            cucuruConfigurado: RestauranteTable.cucuruConfigurado,
            username: RestauranteTable.username,
            id: RestauranteTable.id
        }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1)
        const sistemaPuntosActivo = resRestaurante.length > 0 && resRestaurante[0].sistemaPuntos;

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

        // CRÍTICO: Cuando cucuruConfigurado, asumir transferencia si no se especificó
        // (el frontend solo muestra esa opción en ese caso)
        const metodoPagoEfectivo = metodoPago || (resRestaurante[0]?.cucuruConfigurado ? 'transferencia' : null)

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
        })

        const pedidoId = Number(nuevoPedido[0].insertId)

        for (const item of items) {
            const row = productosMap.get(item.productoId)!
            let precioUnitario = item.esCanjePuntos ? '0.00' : row.producto.precio
            if (!item.esCanjePuntos && (row.producto.descuento || 0) > 0) {
                const descuentoPct = row.producto.descuento || 0
                precioUnitario = (parseFloat(row.producto.precio) * (1 - descuentoPct / 100)).toFixed(2)
            }
            await db.insert(ItemPedidoUnificadoTable).values({
                pedidoId,
                productoId: item.productoId,
                cantidad: item.cantidad,
                precioUnitario,
                ingredientesExcluidos: item.ingredientesExcluidos?.length ? item.ingredientesExcluidos : null,
                agregados: item.agregados?.length ? item.agregados : null,
                esCanjePuntos: item.esCanjePuntos || false
            })
        }

        let cuentaCucuru = null;
        if (metodoPagoEfectivo === 'transferencia' && resRestaurante[0]?.cucuruConfigurado) {
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

        // Notificación por WhatsApp
        const waitToPay = metodoPagoEfectivo === 'transferencia' && resRestaurante[0]?.cucuruConfigurado;
        try {
            const restaurante = await db.select({
                whatsappEnabled: RestauranteTable.whatsappEnabled,
                whatsappNumber: RestauranteTable.whatsappNumber,
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
                    total: metodoPago ? `${total.toFixed(2)} (${metodoPago})` : total.toFixed(2),
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
                cucuruAlias: cuentaCucuru?.alias,
                cucuruAccountNumber: cuentaCucuru?.accountNumber
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

export { publicRoute }
