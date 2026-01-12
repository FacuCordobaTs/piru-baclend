import { Hono } from 'hono'
import { pool } from '../db'
import { restaurante as RestauranteTable, pedido as PedidoTable, itemPedido as ItemPedidoTable, producto as ProductoTable, pago as PagoTable, mesa as MesaTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth'
import { obtenerTokenValido, refrescarTokenRestaurante } from '../utils/mercadopago'
import { wsManager } from '../websocket/manager'

const MP_CLIENT_ID = process.env.MP_CLIENT_ID
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET
const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI || 'https://api.piru.app/api/mp/callback'
const MP_MARKETPLACE_FEE = Number(process.env.MP_MARKETPLACE_FEE) || 0 // Tu comisión en pesos
const ADMIN_URL = process.env.ADMIN_URL || 'https://admin.piru.app'
// Token de acceso de la plataforma (Piru) para consultar webhooks
const MP_PLATFORM_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN

const mercadopagoRoute = new Hono()

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
    return c.redirect(`${ADMIN_URL}/perfil?mp_status=error&mp_error=missing_params`)
  }

  if (!MP_CLIENT_ID || !MP_CLIENT_SECRET) {
    console.error('❌ MP Callback: Faltan credenciales de MercadoPago')
    return c.redirect(`${ADMIN_URL}/perfil?mp_status=error&mp_error=config_error`)
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
      return c.redirect(`${ADMIN_URL}/perfil?mp_status=error&mp_error=oauth_failed`)
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
    return c.redirect(`${ADMIN_URL}/perfil?mp_status=success`)
  } catch (error) {
    console.error('❌ Error en callback de MercadoPago:', error)
    return c.redirect(`${ADMIN_URL}/perfil?mp_status=error&mp_error=server_error`)
  }
})

/**
 * Crear preferencia de pago para MercadoPago
 * Esta ruta crea un link de pago usando el access_token del restaurante
 */
mercadopagoRoute.post('/crear-preferencia', async (c) => {
  const db = drizzle(pool)
  
  try {
    const body = await c.req.json()
    const { pedidoId, qrToken } = body

    if (!pedidoId) {
      return c.json({ success: false, error: 'pedidoId es requerido' }, 400)
    }

    // Obtener el pedido con sus items
    const pedido = await db.select()
      .from(PedidoTable)
      .where(eq(PedidoTable.id, pedidoId))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ success: false, error: 'Pedido no encontrado' }, 404)
    }

    const pedidoData = pedido[0]

    // Verificar que el pedido esté cerrado (listo para pagar)
    if (pedidoData.estado !== 'closed') {
      return c.json({ success: false, error: 'El pedido debe estar cerrado para pagarlo' }, 400)
    }

    // Obtener el restaurante con su access_token
    const restaurante = await db.select()
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, pedidoData.restauranteId!))
      .limit(1)

    if (!restaurante || restaurante.length === 0) {
      return c.json({ success: false, error: 'Restaurante no encontrado' }, 404)
    }

    const restauranteData = restaurante[0]

    if (!restauranteData.mpAccessToken || !restauranteData.mpConnected) {
      return c.json({ success: false, error: 'Restaurante no configurado para pagos con MercadoPago' }, 400)
    }

    // Obtener token válido (intenta refrescar si expiró)
    const tokenValido = await obtenerTokenValido(pedidoData.restauranteId!)
    if (!tokenValido) {
      return c.json({ success: false, error: 'El token de MercadoPago ha expirado. El restaurante debe reconectarse.' }, 401)
    }

    // Obtener items del pedido con nombres de productos
    const items = await db
      .select({
        id: ItemPedidoTable.id,
        productoId: ItemPedidoTable.productoId,
        cantidad: ItemPedidoTable.cantidad,
        precioUnitario: ItemPedidoTable.precioUnitario,
        nombreProducto: ProductoTable.nombre,
      })
      .from(ItemPedidoTable)
      .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
      .where(eq(ItemPedidoTable.pedidoId, pedidoId))

    if (items.length === 0) {
      return c.json({ success: false, error: 'El pedido no tiene items' }, 400)
    }

    // Construir items para MercadoPago
    const mpItems = items.map(item => ({
      title: item.nombreProducto || `Producto #${item.productoId}`,
      quantity: item.cantidad || 1,
      currency_id: 'ARS',
      unit_price: parseFloat(item.precioUnitario)
    }))

    // URLs de retorno
    const baseUrl = qrToken ? `https://my.piru.app/mesa/${qrToken}` : 'https://my.piru.app'
    
    // Crear preferencia usando el TOKEN DEL RESTAURANTE (validado/refrescado)
    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenValido}`
      },
      body: JSON.stringify({
        items: mpItems,
        marketplace_fee: MP_MARKETPLACE_FEE, // Tu ganancia como marketplace
        back_urls: {
          success: `${baseUrl}/pago-exitoso?pedido_id=${pedidoId}`,
          failure: `${baseUrl}/pago-fallido?pedido_id=${pedidoId}`,
          pending: `${baseUrl}/pago-pendiente?pedido_id=${pedidoId}`
        },
        auto_return: 'approved',
        external_reference: `piru-pedido-${pedidoId}`,
        notification_url: `https://api.piru.app/api/mp/webhook`,
        statement_descriptor: 'PIRU',
        expires: true,
        expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutos
      })
    })

    const preference = await mpResponse.json()

    if (!mpResponse.ok) {
      console.error('❌ Error al crear preferencia de MP:', preference)
      return c.json({ success: false, error: 'Error al crear preferencia de pago' }, 500)
    }

    console.log(`✅ Preferencia de pago creada: ${preference.id} para pedido ${pedidoId}`)

    // Devolver el init_point (URL de pago)
    return c.json({ 
      success: true,
      url_pago: preference.init_point,
      preference_id: preference.id
    })
  } catch (error) {
    console.error('❌ Error creando preferencia de pago:', error)
    return c.json({ success: false, error: 'Error interno del servidor' }, 500)
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
 * Webhook de MercadoPago
 * Recibe notificaciones de pagos aprobados, rechazados, etc.
 * MercadoPago envía la notificación aquí cuando cambia el estado de un pago
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
    const externalReference = paymentData.external_reference // Formato: "piru-pedido-{pedidoId}"
    const status = paymentData.status // approved, rejected, pending, etc.
    const statusDetail = paymentData.status_detail
    const transactionAmount = paymentData.transaction_amount

    console.log(`💳 [Webhook] Pago ${paymentId}: status=${status}, ref=${externalReference}, monto=${transactionAmount}`)

    // Validar que sea una referencia de Piru
    if (!externalReference || !externalReference.startsWith('piru-pedido-')) {
      console.log(`⏭️ [Webhook] Referencia externa no es de Piru: ${externalReference}`)
      return c.json({ status: 'ignored', message: 'Not a Piru payment' })
    }

    // Extraer el pedidoId de la referencia
    const pedidoId = parseInt(externalReference.replace('piru-pedido-', ''), 10)
    
    if (isNaN(pedidoId)) {
      console.error(`❌ [Webhook] No se pudo parsear pedidoId de: ${externalReference}`)
      return c.json({ status: 'error', message: 'Invalid external reference' })
    }

    // Buscar el pedido en la base de datos
    const pedido = await db.select()
      .from(PedidoTable)
      .where(eq(PedidoTable.id, pedidoId))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      console.error(`❌ [Webhook] Pedido ${pedidoId} no encontrado`)
      return c.json({ status: 'error', message: 'Order not found' })
    }

    const pedidoData = pedido[0]
    const restauranteId = pedidoData.restauranteId!
    const mesaId = pedidoData.mesaId!

    // Buscar si ya existe un registro de pago para este pedido
    const pagoExistente = await db.select()
      .from(PagoTable)
      .where(eq(PagoTable.mpPaymentId, String(paymentId)))
      .limit(1)

    // Si el pago ya fue procesado, no hacer nada
    if (pagoExistente.length > 0 && pagoExistente[0].estado === 'paid') {
      console.log(`⏭️ [Webhook] Pago ${paymentId} ya fue procesado anteriormente`)
      return c.json({ status: 'already_processed' })
    }

    // Obtener info de la mesa para la notificación
    const mesa = await db.select()
      .from(MesaTable)
      .where(eq(MesaTable.id, mesaId))
      .limit(1)
    
    const mesaNombre = mesa[0]?.nombre || `Mesa ${mesaId}`

    // Determinar estado del pago
    let estadoPago: 'pending' | 'paid' | 'failed' = 'pending'
    if (status === 'approved') {
      estadoPago = 'paid'
    } else if (status === 'rejected' || status === 'cancelled' || status === 'refunded') {
      estadoPago = 'failed'
    }

    // Insertar o actualizar el registro de pago
    if (pagoExistente.length === 0) {
      // Insertar nuevo registro de pago
      await db.insert(PagoTable).values({
        pedidoId: pedidoId,
        metodo: 'mercadopago',
        estado: estadoPago,
        monto: String(transactionAmount || pedidoData.total),
        mpPaymentId: String(paymentId),
      })
      console.log(`✅ [Webhook] Pago registrado: pedido=${pedidoId}, estado=${estadoPago}`)
    } else {
      // Actualizar registro existente
      await db.update(PagoTable)
        .set({
          estado: estadoPago,
          monto: String(transactionAmount || pedidoData.total),
        })
        .where(eq(PagoTable.mpPaymentId, String(paymentId)))
      console.log(`✅ [Webhook] Pago actualizado: pedido=${pedidoId}, estado=${estadoPago}`)
    }

    // Si el pago fue aprobado, notificar al admin por WebSocket
    if (status === 'approved') {
      console.log(`🔔 [Webhook] Notificando pago aprobado a restaurante ${restauranteId}`)
      
      // Usar el mismo método que usa pagarPedido en el websocket manager
      // Esto enviará la notificación PAGO_RECIBIDO al admin
      await wsManager.pagarPedido(
        pedidoId, 
        mesaId, 
        'mercadopago', 
        String(transactionAmount || pedidoData.total)
      )
      
      console.log(`✅ [Webhook] Notificación enviada - Pago de $${transactionAmount} en ${mesaNombre}`)
    } else if (status === 'rejected') {
      console.log(`❌ [Webhook] Pago rechazado: ${statusDetail}`)
      // Opcional: notificar al admin sobre pago rechazado
    }

    return c.json({ status: 'ok', processed: true })
  } catch (error) {
    console.error('❌ [Webhook] Error procesando webhook:', error)
    // Retornar 200 para evitar reintentos de MercadoPago
    return c.json({ status: 'error', message: 'Internal error' })
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

