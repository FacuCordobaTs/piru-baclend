import { Hono } from 'hono'
import { pool } from '../db'
import { restaurante as RestauranteTable, pedido as PedidoTable, itemPedido as ItemPedidoTable, producto as ProductoTable, pago as PagoTable, mesa as MesaTable, pagoSubtotal as PagoSubtotalTable, pedidoUnificado as PedidoUnificadoTable, itemPedidoUnificado as ItemPedidoUnificadoTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, inArray } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth'
import { obtenerTokenValido, refrescarTokenRestaurante } from '../utils/mercadopago'
import { wsManager } from '../websocket/manager'
import { sendOrderWhatsApp } from '../services/whatsapp'

const MP_CLIENT_ID = process.env.MP_CLIENT_ID
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET
const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI || 'https://api.piru.app/api/mp/callback'
/** Comisión marketplace Piru (1% del monto cobrado). */
const MP_MARKETPLACE_FEE_RATE = 0.01

/** Monto fijo en moneda del pago (MP: `marketplace_fee` en preferencias, `application_fee` en Payments API). */
function marketplaceFeeFromAmount(amount: number): number {
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * MP_MARKETPLACE_FEE_RATE * 100) / 100
}

const ADMIN_URL = process.env.ADMIN_URL || 'https://admin.piru.app'
// Token de acceso de la plataforma (Piru) para consultar webhooks
const MP_PLATFORM_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN

const mercadopagoRoute = new Hono()

/**
 * Constants for Mozo item identification
 * Mozo items are stored in pagoSubtotal with clienteNombre format: "Mozo:item:{itemId}"
 */
const MOZO_ITEM_PREFIX = 'Mozo:item:'

function isMozoItemKey(key: string): boolean {
  return key.startsWith(MOZO_ITEM_PREFIX)
}

function getMozoItemId(key: string): number | null {
  if (!isMozoItemKey(key)) return null
  return parseInt(key.replace(MOZO_ITEM_PREFIX, ''), 10)
}

function createMozoItemKey(itemId: number): string {
  return `${MOZO_ITEM_PREFIX}${itemId}`
}

/** `piru-{id}` = pedido unificado. Compatibilidad: `piru-delivery-{id}` / `piru-takeaway-{id}`. */
function parseMercadoPagoPiruPedidoUnificadoId(externalReference: string): number | null {
  const unified = externalReference.match(/^piru-(\d+)$/)
  if (unified) return parseInt(unified[1], 10)
  const legacy = externalReference.match(/^piru-(?:delivery|takeaway)-(\d+)$/)
  if (legacy) return parseInt(legacy[1], 10)
  return null
}

/**
 * Helper función para obtener los subtotales completos de un pedido
 * Incluye TODOS los clientes (con y sin registro de pago) + items individuales de Mozo
 */
async function getSubtotalesCompletos(pedidoId: number) {
  const db = drizzle(pool)

  // Obtener todos los registros de pago del pedido
  const pagos = await db.select()
    .from(PagoSubtotalTable)
    .where(eq(PagoSubtotalTable.pedidoId, pedidoId))

  // Obtener items del pedido para calcular subtotales por cliente
  const items = await db
    .select({
      id: ItemPedidoTable.id,
      clienteNombre: ItemPedidoTable.clienteNombre,
      cantidad: ItemPedidoTable.cantidad,
      precioUnitario: ItemPedidoTable.precioUnitario,
    })
    .from(ItemPedidoTable)
    .where(eq(ItemPedidoTable.pedidoId, pedidoId))

  // Calcular subtotal por cliente (TODOS los clientes excepto Mozo)
  const subtotalesPorCliente: Record<string, { monto: number, estado: string, metodo: string | null }> = {}

  // Separate tracking for individual Mozo items
  const mozoItems: Array<{ itemId: number, monto: number, estado: string, metodo: string | null }> = []

  for (const item of items) {
    if (item.clienteNombre === 'Mozo') {
      // Track Mozo items individually
      mozoItems.push({
        itemId: item.id,
        monto: parseFloat(item.precioUnitario) * (item.cantidad || 1),
        estado: 'pending',
        metodo: null
      })
    } else {
      // Regular client - group by name
      if (!subtotalesPorCliente[item.clienteNombre]) {
        subtotalesPorCliente[item.clienteNombre] = { monto: 0, estado: 'pending', metodo: null }
      }
      subtotalesPorCliente[item.clienteNombre].monto += parseFloat(item.precioUnitario) * (item.cantidad || 1)
    }
  }

  // Actualizar con datos de pagos existentes
  for (const pago of pagos) {
    if (isMozoItemKey(pago.clienteNombre)) {
      // This is an individual Mozo item payment
      const itemId = getMozoItemId(pago.clienteNombre)
      const mozoItem = mozoItems.find(m => m.itemId === itemId)
      if (mozoItem) {
        mozoItem.estado = pago.estado || 'pending'
        mozoItem.metodo = pago.metodo
      }
    } else if (subtotalesPorCliente[pago.clienteNombre]) {
      // Regular client payment
      subtotalesPorCliente[pago.clienteNombre].estado = pago.estado || 'pending'
      subtotalesPorCliente[pago.clienteNombre].metodo = pago.metodo
    }
  }

  // Convertir a array
  const clienteSubtotales = Object.entries(subtotalesPorCliente).map(([clienteNombre, data]) => ({
    clienteNombre,
    monto: data.monto.toFixed(2),
    estado: data.estado,
    metodo: data.metodo
  }))

  // Add Mozo items with their special format
  const mozoSubtotales = mozoItems.map(item => ({
    clienteNombre: createMozoItemKey(item.itemId),
    monto: item.monto.toFixed(2),
    estado: item.estado,
    metodo: item.metodo,
    itemId: item.itemId,
    isMozoItem: true
  }))

  return [...clienteSubtotales, ...mozoSubtotales]
}

/**
 * Callback OAuth de MercadoPago
 * Esta ruta recibe el código de autorización después de que el restaurante
 * autoriza a Piru a cobrar en su nombre
 */
mercadopagoRoute.get('/callback', async (c) => {
  const db = drizzle(pool)
  const code = c.req.query('code')
  const state = c.req.query('state') // Este es el ID del restaurante que enviamos antes

  if (!code || !state) {
    console.error('❌ MP Callback: Faltan code o state')
    return c.redirect(`${ADMIN_URL}/dashboard/perfil?mp_status=error&mp_error=missing_params`)
  }

  if (!MP_CLIENT_ID || !MP_CLIENT_SECRET) {
    console.error('❌ MP Callback: Faltan credenciales de MercadoPago')
    return c.redirect(`${ADMIN_URL}/dashboard/perfil?mp_status=error&mp_error=config_error`)
  }

  try {
    // Intercambiar el "code" por el "access_token"
    const response = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: MP_CLIENT_ID,
        client_secret: MP_CLIENT_SECRET,
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: MP_REDIRECT_URI,
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('❌ Error al intercambiar código con MP:', data)
      return c.redirect(`${ADMIN_URL}/dashboard/perfil?mp_status=error&mp_error=oauth_failed`)
    }

    // Guardar las credenciales en la DB del restaurante correspondiente
    await db.update(RestauranteTable)
      .set({
        mpAccessToken: data.access_token,
        mpPublicKey: data.public_key,
        mpRefreshToken: data.refresh_token,
        mpUserId: String(data.user_id),
        mpConnected: true
      })
      .where(eq(RestauranteTable.id, Number(state)))

    console.log(`✅ Restaurante ${state} vinculado con MercadoPago exitosamente`)

    // Redirigir al admin con éxito
    return c.redirect(`${ADMIN_URL}/dashboard/perfil?mp_status=success`)
  } catch (error) {
    console.error('❌ Error en callback de MercadoPago:', error)
    return c.redirect(`${ADMIN_URL}/dashboard/perfil?mp_status=error&mp_error=server_error`)
  }
})

/**
 * Crear preferencia de pago (Checkout Pro) para pedidos unificados.
 * Usa PedidoUnificadoTable. Sin split payment.
 * El usuario ya se encuentra en la pantalla /:username/success cuando clickea pagar.
 * MercadoPago lo redirige de vuelta a esa misma pantalla tras completar el pago.
 */
mercadopagoRoute.post('/crear-preferencia-externo', async (c) => {
  const db = drizzle(pool)
  try {
    const { pedidoId } = await c.req.json()
    if (!pedidoId) {
      return c.json({ success: false, error: 'pedidoId es requerido' }, 400)
    }

    // 1. Obtener pedido unificado
    const rows = await db.select().from(PedidoUnificadoTable).where(eq(PedidoUnificadoTable.id, pedidoId)).limit(1)
    if (!rows.length) return c.json({ success: false, error: 'Pedido no encontrado' }, 404)
    const pedido = rows[0]
    const restauranteId = pedido.restauranteId!
    const total = parseFloat(String(pedido.total || '0'))

    // 2. Obtener token MP válido
    const tokenValido = await obtenerTokenValido(restauranteId)
    if (!tokenValido) return c.json({ success: false, error: 'Restaurante MP error' }, 401)

    // 3. Obtener username del restaurante (todavía útil para fallback)
    const restauranteRows = await db.select({ username: RestauranteTable.username })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)

    // 4. Construir URL de retorno: /pedido/:id — caso especial para Alfajor (id=6) con dominio propio
    let successUrl: string
    if (restauranteId === 6) {
      successUrl = `https://alfajorconpapas.com/pedido/${pedidoId}`
    } else {
      successUrl = `https://my.piru.app/pedido/${pedidoId}`
    }

    const mpItems = [{
      title: `Pedido #${pedidoId}`,
      quantity: 1,
      currency_id: 'ARS',
      unit_price: total
    }]

    const externalReference = `piru-${pedidoId}`

    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenValido}`
      },
      body: JSON.stringify({
        items: mpItems,
        marketplace_fee: marketplaceFeeFromAmount(total),
        back_urls: {
          success: successUrl,
          failure: successUrl,
          pending: successUrl
        },
        auto_return: 'approved',
        external_reference: externalReference,
        notification_url: `https://api.piru.app/api/mp/webhook`,
        statement_descriptor: 'PIRU',
        expires: true,
        expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      })
    })

    const preference = await mpResponse.json()
    if (!mpResponse.ok) {
      console.error('❌ Error al crear preferencia de MP:', preference)
      return c.json({ success: false, error: 'Error al crear preferencia' }, 500)
    }

    console.log(`✅ Preferencia de pago creada: ${preference.id} para pedido ${pedidoId} → ${successUrl}`)

    return c.json({
      success: true,
      url_pago: preference.init_point,
      preference_id: preference.id,
      total: total.toFixed(2),
    })

  } catch (err) {
    console.error('❌ Error creando preferencia de pago:', err)
    return c.json({ success: false, error: 'Server err' }, 500)
  }
})

mercadopagoRoute.post('/process-brick', async (c) => {
  const db = drizzle(pool)
  try {
    const body = await c.req.json()
    const { token, installments, payer, payment_method_id, issuer_id, pedidoId } = body

    if (!pedidoId) {
      return c.json({ success: false, error: 'Datos inválidos' }, 400)
    }
    if (!token || !payer?.email) {
      return c.json({ success: false, error: 'Datos de pago incompletos' }, 400)
    }

    const pedidos = await db.select()
      .from(PedidoUnificadoTable)
      .where(eq(PedidoUnificadoTable.id, pedidoId))
      .limit(1)

    if (pedidos.length === 0) return c.json({ success: false, error: 'Pedido no encontrado' }, 404)
    const pedido = pedidos[0]
    const tipoPedido = pedido.tipo

    const tokenValido = await obtenerTokenValido(pedido.restauranteId!)
    if (!tokenValido) return c.json({ success: false, error: 'Error de conexión con Mercado Pago' }, 401)

    const transactionAmount = parseFloat(String(pedido.total))
    const applicationFee = marketplaceFeeFromAmount(transactionAmount)

    const mpPayload: Record<string, unknown> = {
      transaction_amount: transactionAmount,
      token,
      description: `Pedido #${pedidoId}`,
      installments,
      payment_method_id,
      payer: {
        email: payer.email,
        identification: payer.identification
      },
      external_reference: `piru-${pedidoId}`,
      notification_url: `https://api.piru.app/api/mp/webhook`
    }
    if (applicationFee > 0) {
      mpPayload.application_fee = applicationFee
    }
    if (issuer_id != null && issuer_id !== '') {
      mpPayload.issuer_id = Number(issuer_id)
    }

    const mpResponse = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenValido}`,
        'X-Idempotency-Key': `${pedidoId}-${Date.now()}`
      },
      body: JSON.stringify(mpPayload)
    })

    const paymentData = await mpResponse.json()

    if (!mpResponse.ok) {
      console.error('Error MP:', paymentData)
      return c.json({ success: false, error: 'El pago fue rechazado por la tarjeta.' }, 400)
    }

    const pedidoWhere = eq(PedidoUnificadoTable.id, pedidoId)

    if (paymentData.status === 'approved') {
      await db.update(PedidoUnificadoTable)
        .set({ pagado: true, metodoPago: 'mercadopago_bricks' })
        .where(pedidoWhere)

      await db.insert(PagoTable).values({
        pedidoUnificadoId: pedidoId,
        metodo: 'mercadopago',
        estado: 'paid',
        monto: String(paymentData.transaction_amount),
        mpPaymentId: String(paymentData.id)
      })

      const mesaNombre = tipoPedido === 'delivery' ? 'Delivery' : 'Take Away'
      void wsManager.notifyAdmins(pedido.restauranteId!, {
        id: `notif-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        tipo: 'NUEVO_PEDIDO',
        mesaId: 0,
        mesaNombre,
        mensaje: `Nuevo pedido de ${mesaNombre} (MP Aprobado)`,
        detalles: `${pedido.nombreCliente || 'Cliente'} - $${pedido.total}`,
        timestamp: new Date().toISOString(),
        leida: false,
        pedidoId: pedidoId
      })

      wsManager.broadcastAdminUpdate(pedido.restauranteId!, tipoPedido)
      wsManager.notifyPublicClientPayment(tipoPedido, pedidoId)

      try {
        const restaurante = await db.select({
          whatsappEnabled: RestauranteTable.whatsappEnabled,
          whatsappNumber: RestauranteTable.whatsappNumber,
          deliveryFee: RestauranteTable.deliveryFee
        }).from(RestauranteTable).where(eq(RestauranteTable.id, pedido.restauranteId!)).limit(1)

        if (restaurante[0]?.whatsappEnabled && restaurante[0]?.whatsappNumber) {
          const itemsRaw = await db.select({
            cantidad: ItemPedidoUnificadoTable.cantidad,
            nombreProducto: ProductoTable.nombre,
            esCanjePuntos: ItemPedidoUnificadoTable.esCanjePuntos
          })
            .from(ItemPedidoUnificadoTable)
            .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
            .where(eq(ItemPedidoUnificadoTable.pedidoId, pedido.id))

          const orderItemsForWa = itemsRaw.map(item => ({
            name: item.esCanjePuntos ? `${item.nombreProducto} (Canje Puntos)` : item.nombreProducto!,
            quantity: item.cantidad!
          }))

          if (tipoPedido === 'delivery' && restaurante[0].deliveryFee) {
            orderItemsForWa.push({ name: 'Delivery', quantity: 1 })
          }

          sendOrderWhatsApp(c, {
            phone: restaurante[0].whatsappNumber,
            customerName: pedido.nombreCliente || 'Cliente no especificado',
            address: tipoPedido === 'delivery' ? (pedido.direccion || 'Sin dirección') : 'Retira en local (Take Away)',
            total: `${pedido.total} (mercadopago)`,
            items: orderItemsForWa,
            orderId: pedido.id.toString()
          }).catch(console.error)
        }
      } catch (waErr) {
        console.error('Error enviando WhatsApp post-pago MP brick:', waErr)
      }

      return c.json({ success: true, status: 'approved' })
    }

    if (paymentData.status === 'in_process' || paymentData.status === 'pending') {
      await db.insert(PagoTable).values({
        pedidoUnificadoId: pedidoId,
        metodo: 'mercadopago',
        estado: 'pending',
        monto: String(paymentData.transaction_amount),
        mpPaymentId: String(paymentData.id)
      })

      return c.json({ success: true, status: 'pending' })
    }

    return c.json({ success: true, status: 'rejected', message: paymentData.status_detail })
  } catch (error) {
    console.error('Error procesando brick:', error)
    return c.json({ success: false, error: 'Error interno' }, 500)
  }
})

/**
 * Desconectar MercadoPago de un restaurante
 * Requiere autenticación del restaurante
 */
mercadopagoRoute.post('/desconectar', authMiddleware, async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    await db.update(RestauranteTable)
      .set({
        mpAccessToken: null,
        mpPublicKey: null,
        mpRefreshToken: null,
        mpUserId: null,
        mpConnected: false
      })
      .where(eq(RestauranteTable.id, restauranteId))

    console.log(`✅ Restaurante ${restauranteId} desconectado de MercadoPago`)

    return c.json({ success: true, message: 'MercadoPago desconectado correctamente' })
  } catch (error) {
    console.error('❌ Error desconectando MercadoPago:', error)
    return c.json({ success: false, error: 'Error al desconectar MercadoPago' }, 500)
  }
})

/**
 * Verificar estado de conexión de MercadoPago
 * Requiere autenticación del restaurante
 */
mercadopagoRoute.get('/estado', authMiddleware, async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    const restaurante = await db.select({
      mpConnected: RestauranteTable.mpConnected,
      mpUserId: RestauranteTable.mpUserId,
    })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)

    if (!restaurante || restaurante.length === 0) {
      return c.json({ success: false, error: 'Restaurante no encontrado' }, 404)
    }

    return c.json({
      success: true,
      mpConnected: restaurante[0].mpConnected || false,
      mpUserId: restaurante[0].mpUserId || null
    })
  } catch (error) {
    console.error('❌ Error verificando estado de MP:', error)
    return c.json({ success: false, error: 'Error al verificar estado' }, 500)
  }
})

/**
 * Webhook de MercadoPago (pedido unificado; external_reference `piru-{id}`).
 */
mercadopagoRoute.post('/webhook', async (c) => {
  const db = drizzle(pool)

  try {
    // MercadoPago puede enviar datos en query params o body
    const query = c.req.query()
    let body: any = {}

    try {
      body = await c.req.json()
    } catch {
      // Si no hay body JSON, usar query params
    }

    // Obtener el ID del pago y el tipo de notificación
    const paymentId = query['data.id'] || query['id'] || body?.data?.id
    const type = query['type'] || body?.type
    const topic = query['topic'] || body?.topic

    console.log(`📨 [Webhook] Recibido - type: ${type}, topic: ${topic}, paymentId: ${paymentId}`)

    // Solo procesar notificaciones de pagos
    if ((type !== 'payment' && topic !== 'payment') || !paymentId) {
      console.log(`⏭️ [Webhook] Ignorando notificación: type=${type}, topic=${topic}`)
      return c.json({ status: 'ignored' })
    }

    // Consultar detalles del pago a MercadoPago
    // Usamos el token de la plataforma (Piru) ya que como marketplace podemos ver los pagos
    if (!MP_PLATFORM_ACCESS_TOKEN) {
      console.error('❌ [Webhook] Falta MP_ACCESS_TOKEN para consultar pagos')
      return c.json({ status: 'error', message: 'Missing platform token' }, 500)
    }

    const paymentResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        'Authorization': `Bearer ${MP_PLATFORM_ACCESS_TOKEN}`
      }
    })

    if (!paymentResponse.ok) {
      console.error(`❌ [Webhook] Error consultando pago ${paymentId}: ${paymentResponse.status}`)
      // Retornar 200 para que MP no reintente (pero logeamos el error)
      return c.json({ status: 'error', message: 'Payment not found' })
    }

    const paymentData = await paymentResponse.json()

    // Extraer información relevante
    const externalReference = paymentData.external_reference
    const status = paymentData.status // approved, rejected, pending, etc.
    const statusDetail = paymentData.status_detail
    const transactionAmount = paymentData.transaction_amount

    console.log(`💳 [Webhook] Pago ${paymentId}: status=${status}, ref=${externalReference}, monto=${transactionAmount}`)

    if (!externalReference || typeof externalReference !== 'string') {
      console.log(`⏭️ [Webhook] Sin external_reference`)
      return c.json({ status: 'ignored' })
    }

    const pedidoId = parseMercadoPagoPiruPedidoUnificadoId(externalReference)

    if (pedidoId == null || isNaN(pedidoId)) {
      console.log(`⏭️ [Webhook] Referencia no es pedido unificado Piru: ${externalReference}`)
      return c.json({ status: 'ignored' })
    }

    const pedidoWhere = eq(PedidoUnificadoTable.id, pedidoId)

    const pedidos = await db.select()
      .from(PedidoUnificadoTable)
      .where(pedidoWhere)
      .limit(1)

    if (pedidos.length === 0) return c.json({ status: 'error', message: 'Order not found' })

    const pedidoData = pedidos[0]
    const tipoPedido = pedidoData.tipo
    const restauranteId = pedidoData.restauranteId!

    const pagoPorMpId = await db.select()
      .from(PagoTable)
      .where(eq(PagoTable.mpPaymentId, String(paymentId)))
      .limit(1)

    if (status === 'approved') {
      if (pedidoData.pagado) {
        console.log(`⏭️ [Webhook] Pedido ${pedidoId} ya figuraba como pagado.`)
        return c.json({ status: 'already_processed' })
      }
      if (pagoPorMpId.length > 0 && pagoPorMpId[0].estado === 'paid') {
        console.log(`⏭️ [Webhook] Pago ${paymentId} ya registrado como paid.`)
        return c.json({ status: 'already_processed' })
      }

      const mpMetodo =
        pedidoData.metodoPago === 'mercadopago_bricks' ? 'mercadopago_bricks' : 'mercadopago_checkout'
      await db.update(PedidoUnificadoTable)
        .set({ pagado: true, metodoPago: mpMetodo })
        .where(pedidoWhere)

      const montoStr = String(transactionAmount ?? pedidoData.total)
      if (pagoPorMpId.length > 0 && pagoPorMpId[0].estado === 'pending') {
        await db.update(PagoTable)
          .set({ estado: 'paid', monto: montoStr })
          .where(eq(PagoTable.mpPaymentId, String(paymentId)))
      } else {
        await db.insert(PagoTable).values({
          pedidoUnificadoId: pedidoId,
          metodo: 'mercadopago',
          estado: 'paid',
          monto: montoStr,
          mpPaymentId: String(paymentId),
        })
      }

      console.log(`✅ [Webhook] Pago actualizado: pedido=${pedidoId}, estado=paid`)

      const mesaNombre = tipoPedido === 'delivery' ? 'Delivery' : 'Take Away'

      void wsManager.notifyAdmins(restauranteId, {
        id: `notif-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        tipo: 'NUEVO_PEDIDO',
        mesaId: 0,
        mesaNombre,
        mensaje: `Nuevo pedido de ${mesaNombre} (Pagado vía Webhook)`,
        detalles: `${pedidoData.nombreCliente || 'Cliente'} - $${pedidoData.total}`,
        timestamp: new Date().toISOString(),
        leida: false,
        pedidoId: pedidoId
      })

      wsManager.broadcastAdminUpdate(restauranteId, tipoPedido)
      wsManager.notifyPublicClientPayment(tipoPedido, pedidoId)

      try {
        const restaurante = await db.select({
          whatsappEnabled: RestauranteTable.whatsappEnabled,
          whatsappNumber: RestauranteTable.whatsappNumber,
          deliveryFee: RestauranteTable.deliveryFee
        }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1)

        if (restaurante[0]?.whatsappEnabled && restaurante[0]?.whatsappNumber) {
          const itemsRaw = await db.select({
            cantidad: ItemPedidoUnificadoTable.cantidad,
            nombreProducto: ProductoTable.nombre,
            esCanjePuntos: ItemPedidoUnificadoTable.esCanjePuntos
          })
            .from(ItemPedidoUnificadoTable)
            .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
            .where(eq(ItemPedidoUnificadoTable.pedidoId, pedidoData.id))

          const orderItemsForWa = itemsRaw.map(item => ({
            name: item.esCanjePuntos ? `${item.nombreProducto} (Canje Puntos)` : item.nombreProducto!,
            quantity: item.cantidad!
          }))

          if (tipoPedido === 'delivery' && restaurante[0].deliveryFee) {
            orderItemsForWa.push({ name: 'Delivery', quantity: 1 })
          }

          sendOrderWhatsApp(c, {
            phone: restaurante[0].whatsappNumber,
            customerName: pedidoData.nombreCliente || 'Cliente no especificado',
            address: tipoPedido === 'delivery' ? (pedidoData.direccion || 'Sin dirección') : 'Retira en local (Take Away)',
            total: `${pedidoData.total} (mercadopago webhook)`,
            items: orderItemsForWa,
            orderId: pedidoData.id.toString()
          }).catch(console.error)
        }
      } catch (waErr) {
        console.error('Error enviando WhatsApp post-webhook MP:', waErr)
      }
    }

    if (status === 'rejected' || status === 'cancelled' || status === 'refunded') {
      console.log(`❌ [Webhook] Pago no exitoso: ${status} — ${statusDetail}`)
      if (pagoPorMpId.length > 0 && pagoPorMpId[0].estado === 'pending') {
        await db.update(PagoTable)
          .set({ estado: 'failed' })
          .where(eq(PagoTable.mpPaymentId, String(paymentId)))
      }
    }

    return c.json({ status: 'ok', processed: true })
  } catch (error) {
    console.error('❌ [Webhook] Error procesando webhook:', error)
    // Retornar 200 para evitar reintentos de MercadoPago
    return c.json({ status: 'error', message: 'Internal error' })
  }
})

/**
 * Obtener estado de subtotales de un pedido
 * Usado para saber qué clientes ya pagaron su parte
 * Ahora incluye items individuales de Mozo con su estado de pago
 */
mercadopagoRoute.get('/subtotales/:pedidoId', async (c) => {
  const db = drizzle(pool)
  const pedidoId = Number(c.req.param('pedidoId'))

  if (!pedidoId || isNaN(pedidoId)) {
    return c.json({ success: false, error: 'pedidoId inválido' }, 400)
  }

  try {
    // Obtener todos los subtotales pagados del pedido
    const subtotales = await db.select()
      .from(PagoSubtotalTable)
      .where(eq(PagoSubtotalTable.pedidoId, pedidoId))

    // Obtener items del pedido con nombres de productos
    const items = await db
      .select({
        id: ItemPedidoTable.id,
        clienteNombre: ItemPedidoTable.clienteNombre,
        cantidad: ItemPedidoTable.cantidad,
        precioUnitario: ItemPedidoTable.precioUnitario,
        nombreProducto: ProductoTable.nombre,
      })
      .from(ItemPedidoTable)
      .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
      .where(eq(ItemPedidoTable.pedidoId, pedidoId))

    // Calcular subtotal por cliente (EXCEPTO Mozo - se manejan individualmente)
    const subtotalesPorCliente: Record<string, { subtotal: number, pagado: boolean, metodo?: string, estado?: string }> = {}

    // Track individual Mozo items
    const mozoItems: Array<{
      itemId: number,
      subtotal: number,
      pagado: boolean,
      metodo?: string,
      estado: string,
      nombreProducto: string,
      cantidad: number
    }> = []

    for (const item of items) {
      const itemTotal = parseFloat(item.precioUnitario) * (item.cantidad || 1)

      if (item.clienteNombre === 'Mozo') {
        // Track Mozo items individually
        mozoItems.push({
          itemId: item.id,
          subtotal: itemTotal,
          pagado: false,
          estado: 'pending',
          nombreProducto: item.nombreProducto || `Producto #${item.id}`,
          cantidad: item.cantidad || 1
        })
      } else {
        // Regular client - group by name
        if (!subtotalesPorCliente[item.clienteNombre]) {
          subtotalesPorCliente[item.clienteNombre] = { subtotal: 0, pagado: false, estado: 'pending' }
        }
        subtotalesPorCliente[item.clienteNombre].subtotal += itemTotal
      }
    }

    // Marcar los que ya fueron pagados o tienen pending_cash
    for (const subtotal of subtotales) {
      if (isMozoItemKey(subtotal.clienteNombre)) {
        // This is an individual Mozo item payment
        const itemId = getMozoItemId(subtotal.clienteNombre)
        const mozoItem = mozoItems.find(m => m.itemId === itemId)
        if (mozoItem) {
          mozoItem.estado = subtotal.estado || 'pending'
          mozoItem.metodo = subtotal.metodo || undefined
          mozoItem.pagado = subtotal.estado === 'paid'
        }
      } else if (subtotalesPorCliente[subtotal.clienteNombre]) {
        // Regular client payment
        subtotalesPorCliente[subtotal.clienteNombre].estado = subtotal.estado || 'pending'
        subtotalesPorCliente[subtotal.clienteNombre].metodo = subtotal.metodo || undefined
        subtotalesPorCliente[subtotal.clienteNombre].pagado = subtotal.estado === 'paid'
      }
    }

    // Convertir clientes regulares a array
    const resultadoClientes = Object.entries(subtotalesPorCliente).map(([cliente, data]) => ({
      clienteNombre: cliente,
      subtotal: data.subtotal.toFixed(2),
      pagado: data.pagado,
      metodo: data.metodo,
      estado: data.estado || 'pending'
    }))

    // Convertir Mozo items a array con su formato especial
    const resultadoMozoItems = mozoItems.map(item => ({
      clienteNombre: createMozoItemKey(item.itemId),
      subtotal: item.subtotal.toFixed(2),
      pagado: item.pagado,
      metodo: item.metodo,
      estado: item.estado,
      // Extra fields for Mozo items
      isMozoItem: true,
      itemId: item.itemId,
      nombreProducto: item.nombreProducto,
      cantidad: item.cantidad
    }))

    // Combine results
    const resultado = [...resultadoClientes, ...resultadoMozoItems]

    // Calcular totales
    const totalPedido = resultado.reduce((sum, r) => sum + parseFloat(r.subtotal), 0)
    const totalPagado = resultado.filter(r => r.pagado).reduce((sum, r) => sum + parseFloat(r.subtotal), 0)
    const totalPendiente = totalPedido - totalPagado

    return c.json({
      success: true,
      subtotales: resultadoClientes,
      mozoItems: resultadoMozoItems,
      resumen: {
        totalPedido: totalPedido.toFixed(2),
        totalPagado: totalPagado.toFixed(2),
        totalPendiente: totalPendiente.toFixed(2),
        todoPagado: totalPendiente <= 0
      }
    })
  } catch (error) {
    console.error('❌ Error obteniendo subtotales:', error)
    return c.json({ success: false, error: 'Error interno del servidor' }, 500)
  }
})

/**
 * Pagar subtotales en efectivo
 * Registra el pago de uno o más clientes como efectivo
 * También soporta pago de items individuales de Mozo mediante mozoItemIds
 */
mercadopagoRoute.post('/pagar-efectivo', async (c) => {
  const db = drizzle(pool)

  try {
    const body = await c.req.json()
    const { pedidoId, clientesAPagar, mozoItemIds, qrToken, metodoPago = 'efectivo' } = body
    // mozoItemIds: number[] - array of item_pedido IDs for individual Mozo items to pay

    if (!pedidoId) {
      return c.json({ success: false, error: 'pedidoId es requerido' }, 400)
    }

    const hasClientes = clientesAPagar && Array.isArray(clientesAPagar) && clientesAPagar.length > 0
    const hasMozoItems = mozoItemIds && Array.isArray(mozoItemIds) && mozoItemIds.length > 0

    if (!hasClientes && !hasMozoItems) {
      return c.json({ success: false, error: 'clientesAPagar o mozoItemIds es requerido' }, 400)
    }

    // Verificar que el pedido existe y está cerrado
    const pedido = await db.select()
      .from(PedidoTable)
      .where(eq(PedidoTable.id, pedidoId))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ success: false, error: 'Pedido no encontrado' }, 404)
    }

    // 2. Obtener restaurante para verificar si es carrito
    const restaurante = await db.select()
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, pedido[0].restauranteId!))
      .limit(1)

    const mesaId = pedido[0].mesaId!

    // Build list of all clienteNombre keys to check (including Mozo:item:X format)
    const allKeysToCheck: string[] = [...(clientesAPagar || [])]
    if (hasMozoItems) {
      for (const itemId of mozoItemIds) {
        allKeysToCheck.push(createMozoItemKey(itemId))
      }
    }

    // Verificar que los clientes/items no estén ya pagados
    const subtotalesYaPagados = await db.select()
      .from(PagoSubtotalTable)
      .where(and(
        eq(PagoSubtotalTable.pedidoId, pedidoId),
        inArray(PagoSubtotalTable.clienteNombre, allKeysToCheck),
        eq(PagoSubtotalTable.estado, 'paid')
      ))

    if (subtotalesYaPagados.length > 0) {
      const clientesYaPagados = subtotalesYaPagados.map(s => s.clienteNombre)
      return c.json({
        success: false,
        error: `Los siguientes ya fueron pagados: ${clientesYaPagados.join(', ')}`,
        clientesYaPagados
      }, 400)
    }

    // Obtener items del pedido para calcular subtotales
    const items = await db
      .select({
        id: ItemPedidoTable.id,
        clienteNombre: ItemPedidoTable.clienteNombre,
        cantidad: ItemPedidoTable.cantidad,
        precioUnitario: ItemPedidoTable.precioUnitario,
      })
      .from(ItemPedidoTable)
      .where(eq(ItemPedidoTable.pedidoId, pedidoId))

    // Track all keys that get registered for payment
    const registeredKeys: string[] = []

    // Calcular y registrar subtotales por cliente
    if (hasClientes) {
      for (const cliente of clientesAPagar) {
        // Skip "Mozo" - those are handled individually via mozoItemIds
        if (cliente === 'Mozo') continue

        const itemsCliente = items.filter(item => item.clienteNombre === cliente)
        const subtotal = itemsCliente.reduce((sum, item) => {
          return sum + (parseFloat(item.precioUnitario) * (item.cantidad || 1))
        }, 0)

        // Marcar cualquier registro pendiente anterior como fallido
        await db.update(PagoSubtotalTable)
          .set({ estado: 'failed' })
          .where(and(
            eq(PagoSubtotalTable.pedidoId, pedidoId),
            eq(PagoSubtotalTable.clienteNombre, cliente),
            eq(PagoSubtotalTable.estado, 'pending')
          ))

        // Insertar nuevo registro de pago en efectivo como PENDIENTE DE CONFIRMACIÓN
        await db.insert(PagoSubtotalTable).values({
          pedidoId,
          clienteNombre: cliente,
          monto: subtotal.toFixed(2),
          estado: 'pending_cash',
          metodo: metodoPago
        })

        registeredKeys.push(cliente)
        console.log(`⏳ Pago en efectivo pendiente de confirmación: cliente=${cliente}, monto=${subtotal.toFixed(2)}`)
      }
    }

    // Handle individual Mozo item payments
    if (hasMozoItems) {
      for (const itemId of mozoItemIds) {
        const item = items.find(i => i.id === itemId && i.clienteNombre === 'Mozo')
        if (!item) {
          console.log(`⚠️ Mozo item ${itemId} not found, skipping`)
          continue
        }

        const subtotal = parseFloat(item.precioUnitario) * (item.cantidad || 1)
        const mozoKey = createMozoItemKey(itemId)

        // Marcar cualquier registro pendiente anterior como fallido
        await db.update(PagoSubtotalTable)
          .set({ estado: 'failed' })
          .where(and(
            eq(PagoSubtotalTable.pedidoId, pedidoId),
            eq(PagoSubtotalTable.clienteNombre, mozoKey),
            eq(PagoSubtotalTable.estado, 'pending')
          ))

        // Insertar nuevo registro de pago en efectivo para este item específico
        await db.insert(PagoSubtotalTable).values({
          pedidoId,
          clienteNombre: mozoKey,
          monto: subtotal.toFixed(2),
          estado: 'pending_cash',
          metodo: metodoPago
        })

        registeredKeys.push(mozoKey)
        console.log(`⏳ Pago pendiente de confirmación: mozoItem=${itemId}, monto=${subtotal.toFixed(2)}, metodo=${metodoPago}`)
      }
    }

    // Obtener todos los subtotales actualizados (incluyendo clientes sin registro de pago)
    const todosSubtotales = await getSubtotalesCompletos(pedidoId)

    // Notificar via WebSocket
    await wsManager.notificarSubtotalesPagados(
      pedidoId,
      mesaId,
      registeredKeys,
      todosSubtotales
    )

    console.log(`⏳ Pago(s) en efectivo registrado(s) (pendiente confirmación): ${registeredKeys.join(', ')}`)

    return c.json({
      success: true,
      message: 'Pago en efectivo registrado. El cajero debe confirmar el pago.',
      clientesPendientes: registeredKeys
    })
  } catch (error) {
    console.error('❌ Error registrando pago en efectivo:', error)
    return c.json({ success: false, error: 'Error interno del servidor' }, 500)
  }
})

/**
 * Confirmar pago en efectivo (solo admin)
 * El admin confirma que el cliente pagó físicamente
 */
mercadopagoRoute.post('/confirmar-efectivo', authMiddleware, async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    const body = await c.req.json()
    const { pedidoId, clienteNombre, metodoPago } = body

    if (!pedidoId) {
      return c.json({ success: false, error: 'pedidoId es requerido' }, 400)
    }

    if (!clienteNombre) {
      return c.json({ success: false, error: 'clienteNombre es requerido' }, 400)
    }

    // Verificar que el pedido pertenece al restaurante del admin
    const pedido = await db.select()
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.id, pedidoId),
        eq(PedidoTable.restauranteId, restauranteId)
      ))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ success: false, error: 'Pedido no encontrado o no pertenece a este restaurante' }, 404)
    }

    const mesaId = pedido[0].mesaId!

    // Buscar el registro de pago en estado pending_cash o similar
    // Note: We also allow confirming something that might not be pending if they hit it directly, but let's stick to the current logic
    const pagoSubtotal = await db.select()
      .from(PagoSubtotalTable)
      .where(and(
        eq(PagoSubtotalTable.pedidoId, pedidoId),
        eq(PagoSubtotalTable.clienteNombre, clienteNombre),
        eq(PagoSubtotalTable.estado, 'pending_cash')
      ))
      .limit(1)

    if (!pagoSubtotal || pagoSubtotal.length === 0) {
      // Verificar si ya está pagado
      const yaPagado = await db.select()
        .from(PagoSubtotalTable)
        .where(and(
          eq(PagoSubtotalTable.pedidoId, pedidoId),
          eq(PagoSubtotalTable.clienteNombre, clienteNombre),
          eq(PagoSubtotalTable.estado, 'paid')
        ))
        .limit(1)

      if (yaPagado.length > 0) {
        // Just update method if requested
        if (metodoPago && yaPagado[0].metodo !== metodoPago) {
          await db.update(PagoSubtotalTable)
            .set({ metodo: metodoPago })
            .where(eq(PagoSubtotalTable.id, yaPagado[0].id))
        }
        return c.json({ success: false, error: 'Este cliente ya tiene su pago confirmado' }, 400)
      }

      return c.json({ success: false, error: 'No hay pago en efectivo pendiente para este cliente' }, 404)
    }

    // Actualizar estado a 'paid' y método si se especificó
    const updateData: any = { estado: 'paid' }
    if (metodoPago) {
      updateData.metodo = metodoPago
    }

    await db.update(PagoSubtotalTable)
      .set(updateData)
      .where(eq(PagoSubtotalTable.id, pagoSubtotal[0].id))

    console.log(`✅ Pago CONFIRMADO por admin: cliente=${clienteNombre}, monto=${pagoSubtotal[0].monto}, metodo=${metodoPago || pagoSubtotal[0].metodo}`)

    // Obtener todos los subtotales actualizados (incluyendo clientes sin registro de pago)
    const todosSubtotales = await getSubtotalesCompletos(pedidoId)

    // Notificar via WebSocket a clientes y admin
    await wsManager.notificarSubtotalesPagados(
      pedidoId,
      mesaId,
      [clienteNombre],
      todosSubtotales
    )

    return c.json({
      success: true,
      message: 'Pago en efectivo confirmado correctamente',
      clienteConfirmado: clienteNombre
    })
  } catch (error) {
    console.error('❌ Error confirmando pago en efectivo:', error)
    return c.json({ success: false, error: 'Error interno del servidor' }, 500)
  }
})

/**
 * Refrescar token manualmente (para uso interno o cron)
 * Requiere autenticación del restaurante
 */
mercadopagoRoute.post('/refresh-token', authMiddleware, async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    const restaurante = await db.select({
      mpRefreshToken: RestauranteTable.mpRefreshToken,
      mpConnected: RestauranteTable.mpConnected,
    })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)

    if (!restaurante || restaurante.length === 0) {
      return c.json({ success: false, error: 'Restaurante no encontrado' }, 404)
    }

    if (!restaurante[0].mpConnected || !restaurante[0].mpRefreshToken) {
      return c.json({ success: false, error: 'MercadoPago no está conectado' }, 400)
    }

    const nuevoToken = await refrescarTokenRestaurante(restauranteId, restaurante[0].mpRefreshToken)

    if (!nuevoToken) {
      return c.json({ success: false, error: 'No se pudo refrescar el token' }, 500)
    }

    return c.json({ success: true, message: 'Token refrescado correctamente' })
  } catch (error) {
    console.error('❌ Error refrescando token:', error)
    return c.json({ success: false, error: 'Error interno' }, 500)
  }
})

export { mercadopagoRoute }

