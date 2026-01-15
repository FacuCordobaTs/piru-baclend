import { Hono } from 'hono'
import { pool } from '../db'
import { restaurante as RestauranteTable, pedido as PedidoTable, itemPedido as ItemPedidoTable, producto as ProductoTable, pago as PagoTable, mesa as MesaTable, pagoSubtotal as PagoSubtotalTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, inArray } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth'
import { obtenerTokenValido, refrescarTokenRestaurante } from '../utils/mercadopago'
import { wsManager } from '../websocket/manager'

const MP_CLIENT_ID = process.env.MP_CLIENT_ID
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET
const MP_REDIRECT_URI = process.env.MP_REDIRECT_URI || 'https://api.piru.app/api/mp/callback'
const MP_MARKETPLACE_FEE = 0 // Tu comisión en pesos
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
 * Crear preferencia de pago para MercadoPago
 * Esta ruta crea un link de pago usando el access_token del restaurante
 * Soporta pago completo o split payment (pago por subtotales de clientes específicos)
 */
mercadopagoRoute.post('/crear-preferencia', async (c) => {
  const db = drizzle(pool)
  
  try {
    const body = await c.req.json()
    const { pedidoId, qrToken, clientesAPagar } = body
    // clientesAPagar: string[] - array de nombres de clientes cuyos subtotales se van a pagar
    // Si está vacío o no se envía, se paga el total del pedido

    if (!pedidoId) {
      return c.json({ success: false, error: 'pedidoId es requerido' }, 400)
    }

    const isSplitPayment = clientesAPagar && Array.isArray(clientesAPagar) && clientesAPagar.length > 0

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

    // Obtener items del pedido con nombres de productos y cliente
    const items = await db
      .select({
        id: ItemPedidoTable.id,
        productoId: ItemPedidoTable.productoId,
        cantidad: ItemPedidoTable.cantidad,
        precioUnitario: ItemPedidoTable.precioUnitario,
        nombreProducto: ProductoTable.nombre,
        clienteNombre: ItemPedidoTable.clienteNombre,
      })
      .from(ItemPedidoTable)
      .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
      .where(eq(ItemPedidoTable.pedidoId, pedidoId))

    if (items.length === 0) {
      return c.json({ success: false, error: 'El pedido no tiene items' }, 400)
    }

    // Si es split payment, verificar que los clientes no estén ya pagados
    if (isSplitPayment) {
      const subtotalesExistentes = await db
        .select()
        .from(PagoSubtotalTable)
        .where(and(
          eq(PagoSubtotalTable.pedidoId, pedidoId),
          inArray(PagoSubtotalTable.clienteNombre, clientesAPagar),
          eq(PagoSubtotalTable.estado, 'paid')
        ))

      if (subtotalesExistentes.length > 0) {
        const clientesYaPagados = subtotalesExistentes.map(s => s.clienteNombre)
        return c.json({ 
          success: false, 
          error: `Los siguientes clientes ya pagaron: ${clientesYaPagados.join(', ')}`,
          clientesYaPagados
        }, 400)
      }

      // También verificar si hay pagos pendientes para evitar duplicados
      const subtotalesPendientes = await db
        .select()
        .from(PagoSubtotalTable)
        .where(and(
          eq(PagoSubtotalTable.pedidoId, pedidoId),
          inArray(PagoSubtotalTable.clienteNombre, clientesAPagar),
          eq(PagoSubtotalTable.estado, 'pending')
        ))

      // Si hay pendientes, marcarlos como fallidos (se creará uno nuevo)
      if (subtotalesPendientes.length > 0) {
        for (const subtotal of subtotalesPendientes) {
          await db.update(PagoSubtotalTable)
            .set({ estado: 'failed' })
            .where(eq(PagoSubtotalTable.id, subtotal.id))
        }
      }
    }

    // Filtrar items según si es split payment o pago total
    const itemsAPagar = isSplitPayment 
      ? items.filter(item => clientesAPagar.includes(item.clienteNombre))
      : items

    if (itemsAPagar.length === 0) {
      return c.json({ success: false, error: 'No hay items para los clientes seleccionados' }, 400)
    }

    // Construir items para MercadoPago
    const mpItems = itemsAPagar.map(item => ({
      title: isSplitPayment 
        ? `${item.nombreProducto || `Producto #${item.productoId}`} (${item.clienteNombre})`
        : item.nombreProducto || `Producto #${item.productoId}`,
      quantity: item.cantidad || 1,
      currency_id: 'ARS',
      unit_price: parseFloat(item.precioUnitario)
    }))

    // Calcular el total de este pago
    const totalPago = itemsAPagar.reduce((sum, item) => {
      return sum + (parseFloat(item.precioUnitario) * (item.cantidad || 1))
    }, 0)

    // URLs de retorno
    const baseUrl = qrToken ? `https://my.piru.app/mesa/${qrToken}` : 'https://my.piru.app'
    
    // Construir external_reference
    // Para split payment: piru-pedido-{id}-split-{base64(clientes)}
    // Para pago total: piru-pedido-{id}
    let externalReference = `piru-pedido-${pedidoId}`
    if (isSplitPayment) {
      const clientesBase64 = Buffer.from(JSON.stringify(clientesAPagar)).toString('base64')
      externalReference = `piru-pedido-${pedidoId}-split-${clientesBase64}`
    }

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
          success: `${baseUrl}/pago-exitoso?pedido_id=${pedidoId}${isSplitPayment ? '&split=true' : ''}`,
          failure: `${baseUrl}/pago-fallido?pedido_id=${pedidoId}`,
          pending: `${baseUrl}/pago-pendiente?pedido_id=${pedidoId}`
        },
        auto_return: 'approved',
        external_reference: externalReference,
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

    console.log(`✅ Preferencia de pago creada: ${preference.id} para pedido ${pedidoId}${isSplitPayment ? ` (split: ${clientesAPagar.join(', ')})` : ''}`)

    // Si es split payment, crear registros en pago_subtotal para cada cliente
    if (isSplitPayment) {
      // Calcular subtotal por cliente
      const subtotalesPorCliente = clientesAPagar.map(cliente => {
        const itemsCliente = itemsAPagar.filter(item => item.clienteNombre === cliente)
        const subtotal = itemsCliente.reduce((sum, item) => {
          return sum + (parseFloat(item.precioUnitario) * (item.cantidad || 1))
        }, 0)
        return { cliente, subtotal }
      })

      // Insertar registros de pago_subtotal
      for (const { cliente, subtotal } of subtotalesPorCliente) {
        await db.insert(PagoSubtotalTable).values({
          pedidoId,
          clienteNombre: cliente,
          monto: subtotal.toFixed(2),
          estado: 'pending',
          metodo: 'mercadopago',
          mpPreferenceId: preference.id
        })
      }

      console.log(`📝 Registros de pago_subtotal creados para clientes: ${clientesAPagar.join(', ')}`)
    }

    // Devolver el init_point (URL de pago)
    return c.json({ 
      success: true,
      url_pago: preference.init_point,
      preference_id: preference.id,
      total: totalPago.toFixed(2),
      isSplitPayment,
      clientesPagando: isSplitPayment ? clientesAPagar : null
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
 * Soporta tanto pagos completos como split payments
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

    // Validar que sea una referencia de Piru
    if (!externalReference || !externalReference.startsWith('piru-pedido-')) {
      console.log(`⏭️ [Webhook] Referencia externa no es de Piru: ${externalReference}`)
      return c.json({ status: 'ignored', message: 'Not a Piru payment' })
    }

    // Detectar si es un split payment
    // Formato split: piru-pedido-{id}-split-{base64(clientes)}
    // Formato normal: piru-pedido-{id}
    const isSplitPayment = externalReference.includes('-split-')
    let pedidoId: number
    let clientesPagados: string[] = []

    if (isSplitPayment) {
      // Parsear referencia de split payment
      const parts = externalReference.split('-split-')
      pedidoId = parseInt(parts[0].replace('piru-pedido-', ''), 10)
      try {
        const clientesBase64 = parts[1]
        clientesPagados = JSON.parse(Buffer.from(clientesBase64, 'base64').toString('utf-8'))
        console.log(`🔀 [Webhook] Split payment detectado - Clientes: ${clientesPagados.join(', ')}`)
      } catch (e) {
        console.error(`❌ [Webhook] Error parseando clientes del split payment: ${e}`)
        return c.json({ status: 'error', message: 'Invalid split reference' })
      }
    } else {
      pedidoId = parseInt(externalReference.replace('piru-pedido-', ''), 10)
    }
    
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

    if (isSplitPayment) {
      // ============ SPLIT PAYMENT ============
      // Verificar si los subtotales ya fueron pagados
      const subtotalesExistentes = await db.select()
        .from(PagoSubtotalTable)
        .where(and(
          eq(PagoSubtotalTable.pedidoId, pedidoId),
          inArray(PagoSubtotalTable.clienteNombre, clientesPagados),
          eq(PagoSubtotalTable.estado, 'paid')
        ))

      if (subtotalesExistentes.length > 0 && status === 'approved') {
        console.log(`⏭️ [Webhook] Subtotales ya pagados para clientes: ${subtotalesExistentes.map(s => s.clienteNombre).join(', ')}`)
        return c.json({ status: 'already_processed' })
      }

      // Actualizar registros de pago_subtotal
      for (const cliente of clientesPagados) {
        // Buscar el registro pendiente más reciente para este cliente
        const subtotalPendiente = await db.select()
          .from(PagoSubtotalTable)
          .where(and(
            eq(PagoSubtotalTable.pedidoId, pedidoId),
            eq(PagoSubtotalTable.clienteNombre, cliente),
            eq(PagoSubtotalTable.estado, 'pending')
          ))
          .limit(1)

        if (subtotalPendiente.length > 0) {
          await db.update(PagoSubtotalTable)
            .set({
              estado: estadoPago,
              mpPaymentId: String(paymentId)
            })
            .where(eq(PagoSubtotalTable.id, subtotalPendiente[0].id))
          console.log(`✅ [Webhook] Subtotal actualizado: cliente=${cliente}, estado=${estadoPago}`)
        } else {
          // Si no hay registro pendiente, crear uno nuevo (por si acaso)
          const itemsCliente = await db.select()
            .from(ItemPedidoTable)
            .where(and(
              eq(ItemPedidoTable.pedidoId, pedidoId),
              eq(ItemPedidoTable.clienteNombre, cliente)
            ))
          
          const subtotal = itemsCliente.reduce((sum, item) => {
            return sum + (parseFloat(item.precioUnitario) * (item.cantidad || 1))
          }, 0)

          await db.insert(PagoSubtotalTable).values({
            pedidoId,
            clienteNombre: cliente,
            monto: subtotal.toFixed(2),
            estado: estadoPago,
            metodo: 'mercadopago',
            mpPaymentId: String(paymentId)
          })
          console.log(`✅ [Webhook] Nuevo subtotal creado: cliente=${cliente}, estado=${estadoPago}`)
        }
      }

      // Si el pago fue aprobado, notificar por WebSocket
      if (status === 'approved') {
        console.log(`🔔 [Webhook] Notificando pago de subtotales a restaurante ${restauranteId}`)
        
        // Obtener todos los subtotales del pedido para enviar estado actualizado
        const todosSubtotales = await db.select()
          .from(PagoSubtotalTable)
          .where(eq(PagoSubtotalTable.pedidoId, pedidoId))

        // Notificar via WebSocket a clientes y admin
        await wsManager.notificarSubtotalesPagados(
          pedidoId,
          mesaId,
          clientesPagados,
          todosSubtotales.map(s => ({
            clienteNombre: s.clienteNombre,
            monto: s.monto,
            estado: s.estado || 'pending',
            metodo: s.metodo
          }))
        )
        
        console.log(`✅ [Webhook] Notificación de split payment enviada - Clientes: ${clientesPagados.join(', ')} en ${mesaNombre}`)
      }
    } else {
      // ============ PAGO COMPLETO (LEGACY) ============
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
      }
    }

    if (status === 'rejected') {
      console.log(`❌ [Webhook] Pago rechazado: ${statusDetail}`)
    }

    return c.json({ status: 'ok', processed: true, isSplitPayment })
  } catch (error) {
    console.error('❌ [Webhook] Error procesando webhook:', error)
    // Retornar 200 para evitar reintentos de MercadoPago
    return c.json({ status: 'error', message: 'Internal error' })
  }
})

/**
 * Obtener estado de subtotales de un pedido
 * Usado para saber qué clientes ya pagaron su parte
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

    // Obtener items del pedido para calcular subtotales por cliente
    const items = await db
      .select({
        clienteNombre: ItemPedidoTable.clienteNombre,
        cantidad: ItemPedidoTable.cantidad,
        precioUnitario: ItemPedidoTable.precioUnitario,
      })
      .from(ItemPedidoTable)
      .where(eq(ItemPedidoTable.pedidoId, pedidoId))

    // Calcular subtotal por cliente
    const subtotalesPorCliente: Record<string, { subtotal: number, pagado: boolean, metodo?: string }> = {}
    
    for (const item of items) {
      if (!subtotalesPorCliente[item.clienteNombre]) {
        subtotalesPorCliente[item.clienteNombre] = { subtotal: 0, pagado: false }
      }
      subtotalesPorCliente[item.clienteNombre].subtotal += parseFloat(item.precioUnitario) * (item.cantidad || 1)
    }

    // Marcar los que ya fueron pagados
    for (const subtotal of subtotales) {
      if (subtotal.estado === 'paid' && subtotalesPorCliente[subtotal.clienteNombre]) {
        subtotalesPorCliente[subtotal.clienteNombre].pagado = true
        subtotalesPorCliente[subtotal.clienteNombre].metodo = subtotal.metodo || undefined
      }
    }

    // Convertir a array
    const resultado = Object.entries(subtotalesPorCliente).map(([cliente, data]) => ({
      clienteNombre: cliente,
      subtotal: data.subtotal.toFixed(2),
      pagado: data.pagado,
      metodo: data.metodo
    }))

    // Calcular totales
    const totalPedido = resultado.reduce((sum, r) => sum + parseFloat(r.subtotal), 0)
    const totalPagado = resultado.filter(r => r.pagado).reduce((sum, r) => sum + parseFloat(r.subtotal), 0)
    const totalPendiente = totalPedido - totalPagado

    return c.json({ 
      success: true,
      subtotales: resultado,
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
 */
mercadopagoRoute.post('/pagar-efectivo', async (c) => {
  const db = drizzle(pool)
  
  try {
    const body = await c.req.json()
    const { pedidoId, clientesAPagar, qrToken } = body

    if (!pedidoId) {
      return c.json({ success: false, error: 'pedidoId es requerido' }, 400)
    }

    if (!clientesAPagar || !Array.isArray(clientesAPagar) || clientesAPagar.length === 0) {
      return c.json({ success: false, error: 'clientesAPagar es requerido' }, 400)
    }

    // Verificar que el pedido existe y está cerrado
    const pedido = await db.select()
      .from(PedidoTable)
      .where(eq(PedidoTable.id, pedidoId))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ success: false, error: 'Pedido no encontrado' }, 404)
    }

    if (pedido[0].estado !== 'closed') {
      return c.json({ success: false, error: 'El pedido debe estar cerrado para pagarlo' }, 400)
    }

    const mesaId = pedido[0].mesaId!

    // Verificar que los clientes no estén ya pagados
    const subtotalesYaPagados = await db.select()
      .from(PagoSubtotalTable)
      .where(and(
        eq(PagoSubtotalTable.pedidoId, pedidoId),
        inArray(PagoSubtotalTable.clienteNombre, clientesAPagar),
        eq(PagoSubtotalTable.estado, 'paid')
      ))

    if (subtotalesYaPagados.length > 0) {
      const clientesYaPagados = subtotalesYaPagados.map(s => s.clienteNombre)
      return c.json({ 
        success: false, 
        error: `Los siguientes clientes ya pagaron: ${clientesYaPagados.join(', ')}`,
        clientesYaPagados
      }, 400)
    }

    // Obtener items del pedido para calcular subtotales
    const items = await db
      .select({
        clienteNombre: ItemPedidoTable.clienteNombre,
        cantidad: ItemPedidoTable.cantidad,
        precioUnitario: ItemPedidoTable.precioUnitario,
      })
      .from(ItemPedidoTable)
      .where(eq(ItemPedidoTable.pedidoId, pedidoId))

    // Calcular y registrar subtotales por cliente
    for (const cliente of clientesAPagar) {
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

      // Insertar nuevo registro de pago en efectivo (directamente como pagado)
      await db.insert(PagoSubtotalTable).values({
        pedidoId,
        clienteNombre: cliente,
        monto: subtotal.toFixed(2),
        estado: 'paid',
        metodo: 'efectivo'
      })

      console.log(`✅ Pago en efectivo registrado: cliente=${cliente}, monto=${subtotal.toFixed(2)}`)
    }

    // Obtener todos los subtotales actualizados
    const todosSubtotales = await db.select()
      .from(PagoSubtotalTable)
      .where(eq(PagoSubtotalTable.pedidoId, pedidoId))

    // Notificar via WebSocket
    await wsManager.notificarSubtotalesPagados(
      pedidoId,
      mesaId,
      clientesAPagar,
      todosSubtotales.map(s => ({
        clienteNombre: s.clienteNombre,
        monto: s.monto,
        estado: s.estado || 'pending',
        metodo: s.metodo
      }))
    )

    console.log(`✅ Pago en efectivo completado para clientes: ${clientesAPagar.join(', ')}`)

    return c.json({ 
      success: true, 
      message: 'Pago en efectivo registrado correctamente',
      clientesPagados: clientesAPagar
    })
  } catch (error) {
    console.error('❌ Error registrando pago en efectivo:', error)
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

