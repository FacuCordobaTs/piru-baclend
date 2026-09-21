import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { pool } from '../db'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, asc, desc, inArray } from 'drizzle-orm'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import UUID = require('uuid-js')
import {
  restaurante as RestauranteTable,
  ropaProducto as RopaProductoTable,
  ropaPedido as RopaPedidoTable,
  ropaPedidoItem as RopaPedidoItemTable,
  ropaPago as RopaPagoTable,
} from '../db/schema'
import { authMiddleware, type AuthenticatedContext } from '../middleware/auth'
import { MODULE_KEYS, tieneModuloActivo } from '../lib/modulos'
import { obtenerTokenValido } from '../utils/mercadopago'
import { asignarAliasAPedido } from '../services/cucuru'
import {
  METODO_PAGO,
  buildMetodosPublicosList,
  rowToPagoRow,
} from '../lib/metodos-pago'
import {
  calcularTotales,
  hexDeColor,
  leerColores,
  leerImagenes,
  leerTalles,
  validarVariante,
  type ItemPedidoCalculado,
} from '../lib/ropa'

/**
 * Tienda de indumentaria de Alfajor (restaurante id 6) — ver docs/ORDERS.md.
 *
 * Todo el catálogo y los pedidos viven en las tablas `ropa_*`, separadas de
 * `pedido_unificado` a propósito: la ropa no tiene mesa, mozos, cocina, puntos ni reparto,
 * y meterla en el agregado de comida obligaría a tocar el flujo de pedidos de comida.
 *
 * Autorización: la pantalla del admin es de un solo local, así que el gate es un chequeo
 * literal de `restauranteId === 6` (mismo criterio que el `restauranteId === 6` de
 * mercadopago.ts), no un módulo comercial. Ocultar la UI no autoriza: el chequeo va acá.
 */

/** Único local con tienda de indumentaria. */
const ROPA_RESTAURANTE_ID = 6

/** Origen público para los `back_urls` de Checkout Pro. Sin barra final. */
const ROPA_PUBLIC_ORIGIN = (
  process.env.ALFAJOR_PUBLIC_ORIGIN || 'https://alfajorconpapas.com'
).replace(/\/$/, '')

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, '')

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
  console.error('FATAL ERROR: Faltan variables de entorno de Cloudflare R2. La aplicación no puede manejar imágenes.')
  process.exit(1)
}

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
})

/**
 * Espeja el `saveImage` de routes/producto.ts (que ya está duplicado en restaruante.ts y
 * onboarding.ts). Se mantiene una copia local en vez de refactorizar tres routers ajenos:
 * la convención del repo es que cada router de imágenes tenga la suya.
 */
async function saveImage(base64String: string): Promise<string> {
  const match = base64String.match(/^data:(image\/\w+);base64,/)
  if (!match) throw new Error('Formato de base64 inválido para saveImage')

  const mimeType = match[1]
  const fileExtension = mimeType.split('/')[1] || 'png'
  const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '')
  const buffer = Buffer.from(base64Data, 'base64')
  const fileName = `ropa/${UUID.create().toString()}.${fileExtension}`

  await s3Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: fileName,
    Body: buffer,
    ContentType: mimeType,
  }))

  return `${R2_PUBLIC_URL}/${fileName}`
}

async function deleteImage(imageUrl: string): Promise<void> {
  if (!imageUrl || !imageUrl.startsWith(R2_PUBLIC_URL!)) {
    console.warn('deleteImage: URL inválida o no pertenece a R2 gestionado:', imageUrl)
    return
  }
  try {
    const key = new URL(imageUrl).pathname.substring(1)
    await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }))
  } catch (error) {
    // No es fatal: la fila ya se borró y a lo sumo queda un objeto huérfano en R2.
    console.error('deleteImage: error borrando de R2:', imageUrl, error)
  }
}

/** Un data URL se sube a R2; una URL http ya subida se conserva tal cual. */
async function resolverImagenes(entrantes: string[] | undefined, previas: string[]): Promise<string[]> {
  if (!entrantes) return previas
  const resueltas: string[] = []
  for (const img of entrantes) {
    if (typeof img !== 'string' || !img.trim()) continue
    resueltas.push(img.startsWith('data:') ? await saveImage(img) : img)
  }
  return resueltas
}

/** Gate de la pantalla de ropa. Devuelve la respuesta 403, o `null` si puede seguir. */
function gateRopa(c: Context): Response | null {
  const user = (c as AuthenticatedContext).user
  if (!user || user.id !== ROPA_RESTAURANTE_ID) {
    return c.json({ success: false, error: 'No autorizado' }, 403)
  }
  return null
}

type DrizzleDb = ReturnType<typeof drizzle>

/** Resuelve el local por `username` (misma regla literal que public.ts). */
async function restaurantePorUsername(db: DrizzleDb, username: string) {
  const rows = await db
    .select()
    .from(RestauranteTable)
    .where(eq(RestauranteTable.username, username))
    .limit(1)
  return rows[0] ?? null
}

/** Fila pública del catálogo: expone lo que la tienda necesita, sin columnas internas. */
function aProductoPublico(p: typeof RopaProductoTable.$inferSelect) {
  return {
    id: p.id,
    nombre: p.nombre,
    subtitulo: p.subtitulo,
    descripcion: p.descripcion,
    composicion: p.composicion,
    fit: p.fit,
    precio: Number(p.precio),
    precioAnterior: p.precioAnterior != null ? Number(p.precioAnterior) : null,
    categoria: p.categoria,
    imagenes: leerImagenes(p.imagenes),
    talles: leerTalles(p.talles),
    colores: leerColores(p.colores),
    stock: p.stock,
    activo: p.activo,
    orden: p.orden,
  }
}

const ropaRoute = new Hono()

// ═══════════════════════════════════════════════════════════════════════════════
// Público — la tienda. Acotado por :username, sin auth.
// ═══════════════════════════════════════════════════════════════════════════════

ropaRoute.get('/public/:username/productos', async (c) => {
  const db = drizzle(pool)
  try {
    const restaurante = await restaurantePorUsername(db, c.req.param('username'))
    if (!restaurante) {
      return c.json({ success: false, error: 'Tienda no encontrada' }, 404)
    }

    const productos = await db
      .select()
      .from(RopaProductoTable)
      .where(and(
        eq(RopaProductoTable.restauranteId, restaurante.id),
        eq(RopaProductoTable.activo, true),
      ))
      .orderBy(asc(RopaProductoTable.orden), asc(RopaProductoTable.id))

    const mercadopagoActivo = await tieneModuloActivo(db, restaurante.id, MODULE_KEYS.MERCADOPAGO)

    const pagoRow = rowToPagoRow({
      metodosPagoConfig: restaurante.metodosPagoConfig,
      cardsPaymentsEnabled: restaurante.cardsPaymentsEnabled,
      mpConnected: restaurante.mpConnected,
      mpPublicKey: restaurante.mpPublicKey,
      cucuruConfigurado: restaurante.cucuruConfigurado,
      cucuruEnabled: restaurante.cucuruEnabled,
      proveedorPago: restaurante.proveedorPago,
      taloClientId: restaurante.taloClientId,
      taloClientSecret: restaurante.taloClientSecret,
      taloUserId: restaurante.taloUserId,
      transferenciaAlias: restaurante.transferenciaAlias,
      mercadopagoHabilitado: mercadopagoActivo,
    })

    // El efectivo no existe en la tienda de ropa: no hay mostrador donde pagar al retirar
    // sin que el dueño tenga que perseguir el cobro. Sólo se ofrecen medios verificables.
    const metodos = buildMetodosPublicosList(pagoRow)
      .filter((m) => m.id !== METODO_PAGO.CASH)
      .map((m) => ({ id: m.id, label: m.label, automatico: m.automatico }))

    return c.json({
      success: true,
      data: {
        productos: productos.map(aProductoPublico),
        envio: {
          habilitado: restaurante.ropaEnvioEnabled,
          costo: Number(restaurante.ropaCostoEnvio),
        },
        metodosPago: metodos,
      },
    })
  } catch (error) {
    console.error('❌ [Ropa] Error listando catálogo:', error)
    return c.json({ success: false, error: 'Error al cargar el catálogo' }, 500)
  }
})

ropaRoute.get('/public/:username/productos/:id', async (c) => {
  const db = drizzle(pool)
  try {
    const restaurante = await restaurantePorUsername(db, c.req.param('username'))
    if (!restaurante) {
      return c.json({ success: false, error: 'Tienda no encontrada' }, 404)
    }

    const id = parseInt(c.req.param('id'), 10)
    if (isNaN(id)) return c.json({ success: false, error: 'Id inválido' }, 400)

    const rows = await db
      .select()
      .from(RopaProductoTable)
      .where(and(
        eq(RopaProductoTable.id, id),
        eq(RopaProductoTable.restauranteId, restaurante.id),
      ))
      .limit(1)

    if (!rows.length) return c.json({ success: false, error: 'Prenda no encontrada' }, 404)

    return c.json({ success: true, data: aProductoPublico(rows[0]) })
  } catch (error) {
    console.error('❌ [Ropa] Error leyendo producto:', error)
    return c.json({ success: false, error: 'Error al cargar la prenda' }, 500)
  }
})

const crearPedidoSchema = z.object({
  nombreCliente: z.string().trim().min(2).max(255),
  telefono: z.string().trim().min(6).max(50),
  email: z.string().trim().email().max(255).nullish(),
  tipoEntrega: z.enum(['retiro', 'envio']),
  direccion: z.string().trim().max(512).nullish(),
  ciudad: z.string().trim().max(255).nullish(),
  codigoPostal: z.string().trim().max(20).nullish(),
  notas: z.string().trim().max(500).nullish(),
  metodoPago: z.string().trim().min(1).max(64),
  items: z.array(z.object({
    productoId: z.number().int().positive(),
    talle: z.string().trim().max(50).nullish(),
    colorNombre: z.string().trim().max(100).nullish(),
    cantidad: z.number().int().min(1).max(20),
  })).min(1).max(50),
})

ropaRoute.post('/public/:username/pedidos', zValidator('json', crearPedidoSchema), async (c) => {
  const db = drizzle(pool)
  try {
    const restaurante = await restaurantePorUsername(db, c.req.param('username'))
    if (!restaurante) {
      return c.json({ success: false, error: 'Tienda no encontrada' }, 404)
    }

    const body = c.req.valid('json')

    if (body.tipoEntrega === 'envio') {
      if (!restaurante.ropaEnvioEnabled) {
        return c.json({ success: false, error: 'El envío a domicilio no está disponible' }, 400)
      }
      if (!body.direccion || body.direccion.length < 5) {
        return c.json({ success: false, error: 'Falta la dirección de envío' }, 400)
      }
    }

    // ── Precios: SIEMPRE recalculados desde la DB. Nunca se confía en lo que manda el cliente.
    const ids = [...new Set(body.items.map((i) => i.productoId))]
    const productos = await db
      .select()
      .from(RopaProductoTable)
      .where(and(
        inArray(RopaProductoTable.id, ids),
        eq(RopaProductoTable.restauranteId, restaurante.id),
        eq(RopaProductoTable.activo, true),
      ))

    const porId = new Map(productos.map((p) => [p.id, p]))

    const items: ItemPedidoCalculado[] = []
    for (const solicitado of body.items) {
      const producto = porId.get(solicitado.productoId)
      if (!producto) {
        return c.json({
          success: false,
          error: `La prenda #${solicitado.productoId} ya no está disponible`,
        }, 400)
      }

      const errorVariante = validarVariante(producto, solicitado.talle, solicitado.colorNombre)
      if (errorVariante) return c.json({ success: false, error: errorVariante }, 400)

      if (producto.stock != null && producto.stock < solicitado.cantidad) {
        return c.json({
          success: false,
          error: `No hay stock suficiente de "${producto.nombre}" (quedan ${producto.stock})`,
        }, 400)
      }

      items.push({
        productoId: producto.id,
        nombreProducto: producto.nombre,
        imagenUrl: leerImagenes(producto.imagenes)[0] ?? null,
        talle: solicitado.talle ?? null,
        colorNombre: solicitado.colorNombre ?? null,
        colorHex: hexDeColor(producto, solicitado.colorNombre ?? null),
        cantidad: solicitado.cantidad,
        precioUnitario: Number(producto.precio),
      })
    }

    const totales = calcularTotales(items, body.tipoEntrega, Number(restaurante.ropaCostoEnvio))

    // ── Método de pago: se valida contra los medios que el local realmente ofrece.
    const mercadopagoActivo = await tieneModuloActivo(db, restaurante.id, MODULE_KEYS.MERCADOPAGO)
    const pagoRow = rowToPagoRow({
      metodosPagoConfig: restaurante.metodosPagoConfig,
      cardsPaymentsEnabled: restaurante.cardsPaymentsEnabled,
      mpConnected: restaurante.mpConnected,
      mpPublicKey: restaurante.mpPublicKey,
      cucuruConfigurado: restaurante.cucuruConfigurado,
      cucuruEnabled: restaurante.cucuruEnabled,
      proveedorPago: restaurante.proveedorPago,
      taloClientId: restaurante.taloClientId,
      taloClientSecret: restaurante.taloClientSecret,
      taloUserId: restaurante.taloUserId,
      transferenciaAlias: restaurante.transferenciaAlias,
      mercadopagoHabilitado: mercadopagoActivo,
    })
    const metodos = buildMetodosPublicosList(pagoRow).filter((m) => m.id !== METODO_PAGO.CASH)
    const metodo = metodos.find((m) => m.id === body.metodoPago)
    if (!metodo) {
      return c.json({ success: false, error: 'El medio de pago elegido no está disponible' }, 400)
    }

    // ── Persistencia
    const pedidoId = await db.transaction(async (tx) => {
      const [inserted] = await tx.insert(RopaPedidoTable).values({
        restauranteId: restaurante.id,
        nombreCliente: body.nombreCliente,
        telefono: body.telefono,
        email: body.email ?? null,
        tipoEntrega: body.tipoEntrega,
        direccion: body.tipoEntrega === 'envio' ? (body.direccion ?? null) : null,
        ciudad: body.tipoEntrega === 'envio' ? (body.ciudad ?? null) : null,
        codigoPostal: body.tipoEntrega === 'envio' ? (body.codigoPostal ?? null) : null,
        notas: body.notas ?? null,
        subtotal: totales.subtotal.toFixed(2),
        costoEnvio: totales.costoEnvio.toFixed(2),
        total: totales.total.toFixed(2),
        metodoPago: metodo.id,
        pagado: false,
        estadoPago: 'pendiente',
        estado: 'pendiente',
      })

      const nuevoId = inserted.insertId

      await tx.insert(RopaPedidoItemTable).values(items.map((item) => ({
        pedidoId: nuevoId,
        productoId: item.productoId,
        nombreProducto: item.nombreProducto,
        imagenUrl: item.imagenUrl,
        talle: item.talle,
        colorNombre: item.colorNombre,
        colorHex: item.colorHex,
        cantidad: item.cantidad,
        precioUnitario: item.precioUnitario.toFixed(2),
      })))

      // Descuento de stock. `null` = el producto no controla stock.
      for (const item of items) {
        const producto = porId.get(item.productoId)!
        if (producto.stock == null) continue
        await tx
          .update(RopaProductoTable)
          .set({ stock: Math.max(0, producto.stock - item.cantidad) })
          .where(eq(RopaProductoTable.id, producto.id))
      }

      await tx.insert(RopaPagoTable).values({
        pedidoId: nuevoId,
        metodo: metodo.id,
        estado: 'pending',
        monto: totales.total.toFixed(2),
      })

      return nuevoId
    })

    // ── Transferencia automática: se mintea un CVU/alias nuevo y exclusivo para este pedido.
    //
    // `asignarAliasAPedido` sólo admite tipoPedido 'delivery' | 'takeaway' (el enum de
    // account_pool no tiene un valor de ropa), así que se manda 'delivery'. No hay
    // ambigüedad: los pedidos de ropa viven en ropa_pedido, con su propia numeración, y el
    // webhook de Cucuru resuelve por `pedido_unificado`, donde estos ids no existen.
    //
    // Consecuencia: el pago NO se acredita solo (ver docs/ORDERS.md). El comprador ve el
    // alias, transfiere, y el dueño marca "pago recibido" en el admin.
    let aliasDinamico: string | null = null
    let cvuDinamico: string | null = null

    if (metodo.id === METODO_PAGO.TRANSFERENCIA_AUTO_CUCURU) {
      try {
        const asignado = await asignarAliasAPedido({
          db,
          restaurante,
          pedidoId,
          slug: restaurante.username || 'alfajor',
          tipoPedido: 'delivery',
        })
        aliasDinamico = asignado.alias
        cvuDinamico = asignado.accountNumber

        await db
          .update(RopaPedidoTable)
          .set({ aliasTransferencia: aliasDinamico, cvuTransferencia: cvuDinamico })
          .where(eq(RopaPedidoTable.id, pedidoId))
      } catch (error) {
        // El pedido ya está creado y es válido; que falle el minteo del alias no debe
        // perderlo. El dueño lo ve en el admin y puede pasarle el alias a mano.
        console.error(`⚠️ [Ropa] No se pudo asignar alias dinámico al pedido ${pedidoId}:`, error)
      }
    }

    return c.json({
      success: true,
      data: {
        id: pedidoId,
        subtotal: totales.subtotal,
        costoEnvio: totales.costoEnvio,
        total: totales.total,
        estado: 'pendiente',
        pagado: false,
        metodoPago: metodo.id,
        tipoEntrega: body.tipoEntrega,
        // Alias fijo del local: el fallback cuando no hay transferencia automática configurada.
        transferenciaAliasDestino: restaurante.transferenciaAlias ?? null,
        aliasDinamico,
        cvuDinamico,
      },
    })
  } catch (error) {
    console.error('❌ [Ropa] Error creando pedido:', error)
    return c.json({ success: false, error: 'Error al crear el pedido' }, 500)
  }
})

ropaRoute.get('/public/:username/pedidos/:id', async (c) => {
  const db = drizzle(pool)
  try {
    const restaurante = await restaurantePorUsername(db, c.req.param('username'))
    if (!restaurante) return c.json({ success: false, error: 'Tienda no encontrada' }, 404)

    const id = parseInt(c.req.param('id'), 10)
    if (isNaN(id)) return c.json({ success: false, error: 'Id inválido' }, 400)

    const pedidos = await db
      .select()
      .from(RopaPedidoTable)
      .where(and(
        eq(RopaPedidoTable.id, id),
        eq(RopaPedidoTable.restauranteId, restaurante.id),
      ))
      .limit(1)

    if (!pedidos.length) return c.json({ success: false, error: 'Pedido no encontrado' }, 404)
    const pedido = pedidos[0]

    const items = await db
      .select()
      .from(RopaPedidoItemTable)
      .where(eq(RopaPedidoItemTable.pedidoId, id))

    return c.json({
      success: true,
      data: {
        id: pedido.id,
        estado: pedido.estado,
        pagado: pedido.pagado,
        estadoPago: pedido.estadoPago,
        metodoPago: pedido.metodoPago,
        tipoEntrega: pedido.tipoEntrega,
        nombreCliente: pedido.nombreCliente,
        direccion: pedido.direccion,
        ciudad: pedido.ciudad,
        notas: pedido.notas,
        subtotal: Number(pedido.subtotal),
        costoEnvio: Number(pedido.costoEnvio),
        total: Number(pedido.total),
        aliasDinamico: pedido.aliasTransferencia,
        cvuDinamico: pedido.cvuTransferencia,
        transferenciaAliasDestino: restaurante.transferenciaAlias ?? null,
        createdAt: pedido.createdAt,
        items: items.map((i) => ({
          productoId: i.productoId,
          nombreProducto: i.nombreProducto,
          imagenUrl: i.imagenUrl,
          talle: i.talle,
          colorNombre: i.colorNombre,
          colorHex: i.colorHex,
          cantidad: i.cantidad,
          precioUnitario: Number(i.precioUnitario),
        })),
      },
    })
  } catch (error) {
    console.error('❌ [Ropa] Error leyendo pedido:', error)
    return c.json({ success: false, error: 'Error al cargar el pedido' }, 500)
  }
})

ropaRoute.post('/public/:username/pedidos/:id/preferencia-mp', async (c) => {
  const db = drizzle(pool)
  try {
    const restaurante = await restaurantePorUsername(db, c.req.param('username'))
    if (!restaurante) return c.json({ success: false, error: 'Tienda no encontrada' }, 404)

    const id = parseInt(c.req.param('id'), 10)
    if (isNaN(id)) return c.json({ success: false, error: 'Id inválido' }, 400)

    const pedidos = await db
      .select()
      .from(RopaPedidoTable)
      .where(and(
        eq(RopaPedidoTable.id, id),
        eq(RopaPedidoTable.restauranteId, restaurante.id),
      ))
      .limit(1)

    if (!pedidos.length) return c.json({ success: false, error: 'Pedido no encontrado' }, 404)
    const pedido = pedidos[0]

    if (pedido.pagado) {
      return c.json({ success: false, error: 'Este pedido ya está pagado' }, 400)
    }

    if (!(await tieneModuloActivo(db, restaurante.id, MODULE_KEYS.MERCADOPAGO))) {
      return c.json({
        success: false,
        moduleRequired: true,
        module: MODULE_KEYS.MERCADOPAGO,
        error: 'Mercado Pago no está habilitado para este local',
      }, 403)
    }

    const tokenValido = await obtenerTokenValido(restaurante.id)
    if (!tokenValido) return c.json({ success: false, error: 'El local no tiene Mercado Pago conectado' }, 401)

    const total = Number(pedido.total)

    const items = await db
      .select()
      .from(RopaPedidoItemTable)
      .where(eq(RopaPedidoItemTable.pedidoId, id))

    // El detalle va ítem por ítem (no un único "Pedido #N") para que el comprador vea en
    // el checkout de MP qué está pagando, con talle y color en el título.
    const mpItems = items.map((i) => ({
      title: [i.nombreProducto, i.talle, i.colorNombre].filter(Boolean).join(' · ').slice(0, 255),
      quantity: i.cantidad,
      currency_id: 'ARS',
      unit_price: Number(i.precioUnitario),
    }))

    if (Number(pedido.costoEnvio) > 0) {
      mpItems.push({
        title: 'Envío',
        quantity: 1,
        currency_id: 'ARS',
        unit_price: Number(pedido.costoEnvio),
      })
    }

    const successUrl = `${ROPA_PUBLIC_ORIGIN}/ropa/pedido/${id}`
    const externalReference = `piru-ropa-${id}`

    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenValido}`,
      },
      body: JSON.stringify({
        items: mpItems,
        back_urls: { success: successUrl, failure: successUrl, pending: successUrl },
        auto_return: 'approved',
        external_reference: externalReference,
        notification_url: 'https://api.piru.app/api/mp/webhook',
        statement_descriptor: 'PIRU',
        expires: true,
        expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    })

    const preference = await mpResponse.json()
    if (!mpResponse.ok) {
      console.error('❌ [Ropa] Error al crear preferencia de MP:', preference)
      return c.json({ success: false, error: 'Error al iniciar el pago' }, 500)
    }

    await db
      .update(RopaPagoTable)
      .set({ mpPreferenceId: String(preference.id) })
      .where(eq(RopaPagoTable.pedidoId, id))

    console.log(`✅ [Ropa] Preferencia ${preference.id} creada para pedido ${id} ($${total})`)

    return c.json({
      success: true,
      url_pago: preference.init_point,
      preference_id: preference.id,
      total: total.toFixed(2),
    })
  } catch (error) {
    console.error('❌ [Ropa] Error creando preferencia:', error)
    return c.json({ success: false, error: 'Error al iniciar el pago' }, 500)
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// Admin — pantalla de gestión. Auth + gate literal de restaurante id 6.
// ═══════════════════════════════════════════════════════════════════════════════

ropaRoute.use('/admin/*', authMiddleware)

ropaRoute.get('/admin/resumen', async (c) => {
  const gate = gateRopa(c)
  if (gate) return gate
  const db = drizzle(pool)
  try {
    const pendientes = await db
      .select({ id: RopaPedidoTable.id, pagado: RopaPedidoTable.pagado, estado: RopaPedidoTable.estado })
      .from(RopaPedidoTable)
      .where(eq(RopaPedidoTable.restauranteId, ROPA_RESTAURANTE_ID))

    const productos = await db
      .select({ id: RopaProductoTable.id })
      .from(RopaProductoTable)
      .where(eq(RopaProductoTable.restauranteId, ROPA_RESTAURANTE_ID))

    return c.json({
      success: true,
      data: {
        // Lo que el dueño necesita ver de un vistazo: pedidos sin cobrar y sin entregar.
        pendientesPago: pendientes.filter((p) => !p.pagado).length,
        pendientesEntrega: pendientes.filter(
          (p) => p.estado !== 'entregado' && p.estado !== 'cancelado',
        ).length,
        totalPedidos: pendientes.length,
        totalProductos: productos.length,
      },
    })
  } catch (error) {
    console.error('❌ [Ropa] Error en resumen:', error)
    return c.json({ success: false, error: 'Error al cargar el resumen' }, 500)
  }
})

ropaRoute.get('/admin/productos', async (c) => {
  const gate = gateRopa(c)
  if (gate) return gate
  const db = drizzle(pool)
  try {
    const productos = await db
      .select()
      .from(RopaProductoTable)
      .where(eq(RopaProductoTable.restauranteId, ROPA_RESTAURANTE_ID))
      .orderBy(asc(RopaProductoTable.orden), asc(RopaProductoTable.id))

    return c.json({ success: true, productos: productos.map(aProductoPublico) })
  } catch (error) {
    console.error('❌ [Ropa] Error listando productos (admin):', error)
    return c.json({ success: false, error: 'Error al cargar los productos' }, 500)
  }
})

const colorSchema = z.object({
  nombre: z.string().trim().min(1).max(100),
  hex: z.string().trim().min(1).max(20),
})

const productoRopaSchema = z.object({
  nombre: z.string().trim().min(1).max(255),
  subtitulo: z.string().trim().max(255).nullish(),
  descripcion: z.string().trim().max(500).nullish(),
  composicion: z.string().trim().max(255).nullish(),
  fit: z.string().trim().max(100).nullish(),
  precio: z.number().min(0),
  precioAnterior: z.number().min(0).nullish(),
  categoria: z.string().trim().max(50).nullish(),
  /** Cada entrada es un data URL (se sube a R2) o una URL ya subida (se conserva). */
  imagenes: z.array(z.string()).max(5).optional(),
  talles: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  colores: z.array(colorSchema).max(30).optional(),
  stock: z.number().int().min(0).nullish(),
  activo: z.boolean().optional(),
  orden: z.number().int().optional(),
})

ropaRoute.post('/admin/productos', zValidator('json', productoRopaSchema), async (c) => {
  const gate = gateRopa(c)
  if (gate) return gate
  const db = drizzle(pool)
  try {
    const body = c.req.valid('json')

    const imagenes = await resolverImagenes(body.imagenes, [])

    const [inserted] = await db.insert(RopaProductoTable).values({
      restauranteId: ROPA_RESTAURANTE_ID,
      nombre: body.nombre,
      subtitulo: body.subtitulo ?? null,
      descripcion: body.descripcion ?? null,
      composicion: body.composicion ?? null,
      fit: body.fit ?? null,
      precio: body.precio.toFixed(2),
      precioAnterior: body.precioAnterior != null ? body.precioAnterior.toFixed(2) : null,
      categoria: body.categoria ?? null,
      imagenes,
      talles: body.talles ?? [],
      colores: body.colores ?? [],
      stock: body.stock ?? null,
      activo: body.activo ?? true,
      orden: body.orden ?? 0,
    })

    return c.json({ success: true, id: inserted.insertId })
  } catch (error) {
    console.error('❌ [Ropa] Error creando producto:', error)
    return c.json({ success: false, error: 'Error al crear el producto' }, 500)
  }
})

ropaRoute.put('/admin/productos/:id', zValidator('json', productoRopaSchema.partial()), async (c) => {
  const gate = gateRopa(c)
  if (gate) return gate
  const db = drizzle(pool)
  try {
    const id = parseInt(c.req.param('id'), 10)
    if (isNaN(id)) return c.json({ success: false, error: 'Id inválido' }, 400)

    const rows = await db
      .select()
      .from(RopaProductoTable)
      .where(and(
        eq(RopaProductoTable.id, id),
        eq(RopaProductoTable.restauranteId, ROPA_RESTAURANTE_ID),
      ))
      .limit(1)

    if (!rows.length) return c.json({ success: false, error: 'Producto no encontrado' }, 404)
    const previo = rows[0]
    const body = c.req.valid('json')

    const imagenesPrevias = leerImagenes(previo.imagenes)
    const imagenes = await resolverImagenes(body.imagenes, imagenesPrevias)

    const updates: Partial<typeof RopaProductoTable.$inferInsert> = {}
    if (body.nombre !== undefined) updates.nombre = body.nombre
    if (body.subtitulo !== undefined) updates.subtitulo = body.subtitulo ?? null
    if (body.descripcion !== undefined) updates.descripcion = body.descripcion ?? null
    if (body.composicion !== undefined) updates.composicion = body.composicion ?? null
    if (body.fit !== undefined) updates.fit = body.fit ?? null
    if (body.precio !== undefined) updates.precio = body.precio.toFixed(2)
    if (body.precioAnterior !== undefined) {
      updates.precioAnterior = body.precioAnterior != null ? body.precioAnterior.toFixed(2) : null
    }
    if (body.categoria !== undefined) updates.categoria = body.categoria ?? null
    if (body.talles !== undefined) updates.talles = body.talles
    if (body.colores !== undefined) updates.colores = body.colores
    if (body.stock !== undefined) updates.stock = body.stock ?? null
    if (body.activo !== undefined) updates.activo = body.activo
    if (body.orden !== undefined) updates.orden = body.orden
    if (body.imagenes !== undefined) updates.imagenes = imagenes

    if (Object.keys(updates).length > 0) {
      await db.update(RopaProductoTable).set(updates).where(eq(RopaProductoTable.id, id))
    }

    // Las imágenes que el dueño sacó del producto se borran de R2 para no acumular basura.
    if (body.imagenes !== undefined) {
      const conservadas = new Set(imagenes)
      for (const previa of imagenesPrevias) {
        if (!conservadas.has(previa)) await deleteImage(previa)
      }
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('❌ [Ropa] Error actualizando producto:', error)
    return c.json({ success: false, error: 'Error al actualizar el producto' }, 500)
  }
})

ropaRoute.delete('/admin/productos/:id', async (c) => {
  const gate = gateRopa(c)
  if (gate) return gate
  const db = drizzle(pool)
  try {
    const id = parseInt(c.req.param('id'), 10)
    if (isNaN(id)) return c.json({ success: false, error: 'Id inválido' }, 400)

    const rows = await db
      .select()
      .from(RopaProductoTable)
      .where(and(
        eq(RopaProductoTable.id, id),
        eq(RopaProductoTable.restauranteId, ROPA_RESTAURANTE_ID),
      ))
      .limit(1)

    if (!rows.length) return c.json({ success: false, error: 'Producto no encontrado' }, 404)

    // Los pedidos ya hechos guardan su propio snapshot (ropa_pedido_item), así que borrar el
    // producto no rompe el historial. Es la razón por la que item_pedido_item no tiene FK.
    await db.delete(RopaProductoTable).where(eq(RopaProductoTable.id, id))

    for (const imagen of leerImagenes(rows[0].imagenes)) {
      await deleteImage(imagen)
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('❌ [Ropa] Error borrando producto:', error)
    return c.json({ success: false, error: 'Error al borrar el producto' }, 500)
  }
})

ropaRoute.get('/admin/pedidos', async (c) => {
  const gate = gateRopa(c)
  if (gate) return gate
  const db = drizzle(pool)
  try {
    const estado = c.req.query('estado')

    const where = estado
      ? and(
          eq(RopaPedidoTable.restauranteId, ROPA_RESTAURANTE_ID),
          eq(RopaPedidoTable.estado, estado as typeof RopaPedidoTable.$inferSelect['estado']),
        )
      : eq(RopaPedidoTable.restauranteId, ROPA_RESTAURANTE_ID)

    const pedidos = await db
      .select()
      .from(RopaPedidoTable)
      .where(where)
      .orderBy(desc(RopaPedidoTable.createdAt))

    if (!pedidos.length) return c.json({ success: true, pedidos: [] })

    // Se traen los ítems de todos los pedidos en una sola query en vez de N+1.
    const items = await db
      .select()
      .from(RopaPedidoItemTable)
      .where(inArray(RopaPedidoItemTable.pedidoId, pedidos.map((p) => p.id)))

    const itemsPorPedido = new Map<number, typeof items>()
    for (const item of items) {
      const lista = itemsPorPedido.get(item.pedidoId) ?? []
      lista.push(item)
      itemsPorPedido.set(item.pedidoId, lista)
    }

    return c.json({
      success: true,
      pedidos: pedidos.map((p) => ({
        id: p.id,
        nombreCliente: p.nombreCliente,
        telefono: p.telefono,
        email: p.email,
        tipoEntrega: p.tipoEntrega,
        direccion: p.direccion,
        ciudad: p.ciudad,
        codigoPostal: p.codigoPostal,
        notas: p.notas,
        subtotal: Number(p.subtotal),
        costoEnvio: Number(p.costoEnvio),
        total: Number(p.total),
        metodoPago: p.metodoPago,
        pagado: p.pagado,
        estadoPago: p.estadoPago,
        estado: p.estado,
        aliasTransferencia: p.aliasTransferencia,
        cvuTransferencia: p.cvuTransferencia,
        createdAt: p.createdAt,
        items: (itemsPorPedido.get(p.id) ?? []).map((i) => ({
          id: i.id,
          productoId: i.productoId,
          nombreProducto: i.nombreProducto,
          imagenUrl: i.imagenUrl,
          talle: i.talle,
          colorNombre: i.colorNombre,
          colorHex: i.colorHex,
          cantidad: i.cantidad,
          precioUnitario: Number(i.precioUnitario),
        })),
      })),
    })
  } catch (error) {
    console.error('❌ [Ropa] Error listando pedidos:', error)
    return c.json({ success: false, error: 'Error al cargar los pedidos' }, 500)
  }
})

const ESTADOS_ROPA = ['pendiente', 'preparando', 'enviado', 'entregado', 'cancelado'] as const

ropaRoute.put('/admin/pedidos/:id/estado', zValidator('json', z.object({
  estado: z.enum(ESTADOS_ROPA),
})), async (c) => {
  const gate = gateRopa(c)
  if (gate) return gate
  const db = drizzle(pool)
  try {
    const id = parseInt(c.req.param('id'), 10)
    if (isNaN(id)) return c.json({ success: false, error: 'Id inválido' }, 400)

    const { estado } = c.req.valid('json')

    const rows = await db
      .select({ id: RopaPedidoTable.id })
      .from(RopaPedidoTable)
      .where(and(
        eq(RopaPedidoTable.id, id),
        eq(RopaPedidoTable.restauranteId, ROPA_RESTAURANTE_ID),
      ))
      .limit(1)

    if (!rows.length) return c.json({ success: false, error: 'Pedido no encontrado' }, 404)

    await db.update(RopaPedidoTable).set({ estado }).where(eq(RopaPedidoTable.id, id))
    return c.json({ success: true })
  } catch (error) {
    console.error('❌ [Ropa] Error cambiando estado:', error)
    return c.json({ success: false, error: 'Error al cambiar el estado' }, 500)
  }
})

ropaRoute.put('/admin/pedidos/:id/pagado', zValidator('json', z.object({
  pagado: z.boolean(),
})), async (c) => {
  const gate = gateRopa(c)
  if (gate) return gate
  const db = drizzle(pool)
  try {
    const id = parseInt(c.req.param('id'), 10)
    if (isNaN(id)) return c.json({ success: false, error: 'Id inválido' }, 400)

    const { pagado } = c.req.valid('json')

    const rows = await db
      .select({ id: RopaPedidoTable.id, total: RopaPedidoTable.total, metodoPago: RopaPedidoTable.metodoPago })
      .from(RopaPedidoTable)
      .where(and(
        eq(RopaPedidoTable.id, id),
        eq(RopaPedidoTable.restauranteId, ROPA_RESTAURANTE_ID),
      ))
      .limit(1)

    if (!rows.length) return c.json({ success: false, error: 'Pedido no encontrado' }, 404)

    await db
      .update(RopaPedidoTable)
      .set({ pagado, estadoPago: pagado ? 'pagado' : 'pendiente' })
      .where(eq(RopaPedidoTable.id, id))

    // Espeja el estado en ropa_pago para que el registro de pago quede consistente con el
    // pedido, igual que hace el flujo de comida al confirmar efectivo.
    await db
      .update(RopaPagoTable)
      .set({ estado: pagado ? 'paid' : 'pending' })
      .where(eq(RopaPagoTable.pedidoId, id))

    return c.json({ success: true })
  } catch (error) {
    console.error('❌ [Ropa] Error marcando pago:', error)
    return c.json({ success: false, error: 'Error al marcar el pago' }, 500)
  }
})

ropaRoute.get('/admin/config', async (c) => {
  const gate = gateRopa(c)
  if (gate) return gate
  const db = drizzle(pool)
  try {
    const rows = await db
      .select({
        ropaEnvioEnabled: RestauranteTable.ropaEnvioEnabled,
        ropaCostoEnvio: RestauranteTable.ropaCostoEnvio,
      })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, ROPA_RESTAURANTE_ID))
      .limit(1)

    if (!rows.length) return c.json({ success: false, error: 'Local no encontrado' }, 404)

    return c.json({
      success: true,
      data: {
        ropaEnvioEnabled: rows[0].ropaEnvioEnabled,
        ropaCostoEnvio: Number(rows[0].ropaCostoEnvio),
      },
    })
  } catch (error) {
    console.error('❌ [Ropa] Error leyendo config:', error)
    return c.json({ success: false, error: 'Error al cargar la configuración' }, 500)
  }
})

ropaRoute.put('/admin/config', zValidator('json', z.object({
  ropaEnvioEnabled: z.boolean().optional(),
  ropaCostoEnvio: z.number().min(0).optional(),
})), async (c) => {
  const gate = gateRopa(c)
  if (gate) return gate
  const db = drizzle(pool)
  try {
    const body = c.req.valid('json')

    const updates: Partial<typeof RestauranteTable.$inferInsert> = {}
    if (body.ropaEnvioEnabled !== undefined) updates.ropaEnvioEnabled = body.ropaEnvioEnabled
    if (body.ropaCostoEnvio !== undefined) updates.ropaCostoEnvio = body.ropaCostoEnvio.toFixed(2)

    if (Object.keys(updates).length > 0) {
      await db.update(RestauranteTable).set(updates).where(eq(RestauranteTable.id, ROPA_RESTAURANTE_ID))
    }

    return c.json({ success: true })
  } catch (error) {
    console.error('❌ [Ropa] Error guardando config:', error)
    return c.json({ success: false, error: 'Error al guardar la configuración' }, 500)
  }
})

export default ropaRoute
export { ropaRoute }
