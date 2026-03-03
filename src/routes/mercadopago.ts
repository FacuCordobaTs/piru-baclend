import { Hono } from 'hono'
import { pool } from '../db'
import { restaurante as RestauranteTable, pedido as PedidoTable, itemPedido as ItemPedidoTable, producto as ProductoTable, pago as PagoTable, mesa as MesaTable, pagoSubtotal as PagoSubtotalTable, pedidoDelivery as PedidoDeliveryTable, pedidoTakeaway as PedidoTakeawayTable } from '../db/schema'
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
 * Crear preferencia de pago para MercadoPago
 * Esta ruta crea un link de pago usando el access_token del restaurante
 * Soporta pago completo o split payment (pago por subtotales de clientes específicos)
 * También soporta pago de items individuales de Mozo mediante mozoItemIds
 */
mercadopagoRoute.post('/crear-preferencia', async (c) => {
  const db = drizzle(pool)

  try {
    const body = await c.req.json()
    const { pedidoId, qrToken, clientesAPagar, mozoItemIds } = body
    // clientesAPagar: string[] - array de nombres de clientes cuyos subtotales se van a pagar
    // mozoItemIds: number[] - array of item_pedido IDs for individual Mozo items
    // Si ambos están vacíos, se paga el total del pedido

    if (!pedidoId) {
      return c.json({ success: false, error: 'pedidoId es requerido' }, 400)
    }

    const hasClientes = clientesAPagar && Array.isArray(clientesAPagar) && clientesAPagar.length > 0
    const hasMozoItems = mozoItemIds && Array.isArray(mozoItemIds) && mozoItemIds.length > 0
    const isSplitPayment = hasClientes || hasMozoItems

    // Obtener el pedido con sus items
    const pedido = await db.select()
      .from(PedidoTable)
      .where(eq(PedidoTable.id, pedidoId))
      .limit(1)

    if (!pedido || pedido.length === 0) {
      return c.json({ success: false, error: 'Pedido no encontrado' }, 404)
    }

    const pedidoData = pedido[0]

    // 2. Obtener el restaurante PRIMERO para saber si es carrito
    const restaurante = await db.select()
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, pedidoData.restauranteId!))
      .limit(1)

    if (!restaurante || restaurante.length === 0) {
      return c.json({ success: false, error: 'Restaurante no encontrado' }, 404)
    }

    const restauranteData = restaurante[0]

    // 3. Validar estado del pedido según tipo de restaurante
    const esCarrito = restauranteData.esCarrito === true;

    if (esCarrito) {
      // En carrito se puede pagar si está preparing, delivered o closed
      if (pedidoData.estado === 'pending') {
        return c.json({ success: false, error: 'El pedido debe estar confirmado para pagarlo' }, 400)
      }
    } else {
      // En restaurante normal, DEBE estar cerrado
      if (pedidoData.estado !== 'closed') {
        return c.json({ success: false, error: 'El pedido debe estar cerrado para pagarlo' }, 400)
      }
    }

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

    // Build list of all clienteNombre keys to check (including Mozo:item:X format)
    const allKeysToCheck: string[] = []

    // Add regular client names (excluding "Mozo" since those are handled via mozoItemIds)
    if (hasClientes) {
      for (const cliente of clientesAPagar) {
        if (cliente !== 'Mozo') {
          allKeysToCheck.push(cliente)
        }
      }
    }

    // Add Mozo item keys
    if (hasMozoItems) {
      for (const itemId of mozoItemIds) {
        allKeysToCheck.push(createMozoItemKey(itemId))
      }
    }

    // Si es split payment, verificar que los clientes/items no estén ya pagados
    if (isSplitPayment && allKeysToCheck.length > 0) {
      const subtotalesExistentes = await db
        .select()
        .from(PagoSubtotalTable)
        .where(and(
          eq(PagoSubtotalTable.pedidoId, pedidoId),
          inArray(PagoSubtotalTable.clienteNombre, allKeysToCheck),
          eq(PagoSubtotalTable.estado, 'paid')
        ))

      if (subtotalesExistentes.length > 0) {
        const clientesYaPagados = subtotalesExistentes.map(s => s.clienteNombre)
        return c.json({
          success: false,
          error: `Los siguientes ya fueron pagados: ${clientesYaPagados.join(', ')}`,
          clientesYaPagados
        }, 400)
      }

      // También verificar si hay pagos pendientes para evitar duplicados
      const subtotalesPendientes = await db
        .select()
        .from(PagoSubtotalTable)
        .where(and(
          eq(PagoSubtotalTable.pedidoId, pedidoId),
          inArray(PagoSubtotalTable.clienteNombre, allKeysToCheck),
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
    let itemsAPagar = items

    if (isSplitPayment) {
      itemsAPagar = []

      // Add items from selected clients (but not "Mozo" - those come via mozoItemIds)
      if (hasClientes) {
        const clienteItems = items.filter(item =>
          clientesAPagar.includes(item.clienteNombre) && item.clienteNombre !== 'Mozo'
        )
        itemsAPagar.push(...clienteItems)
      }

      // Add specific Mozo items by ID
      if (hasMozoItems) {
        const mozoItemsToAdd = items.filter(item =>
          item.clienteNombre === 'Mozo' && mozoItemIds.includes(item.id)
        )
        itemsAPagar.push(...mozoItemsToAdd)
      }
    }

    if (itemsAPagar.length === 0) {
      return c.json({ success: false, error: 'No hay items para pagar' }, 400)
    }

    // Construir items para MercadoPago
    const mpItems = itemsAPagar.map(item => ({
      title: isSplitPayment
        ? `${item.nombreProducto || `Producto #${item.productoId}`} (${item.clienteNombre === 'Mozo' ? 'Mozo' : item.clienteNombre})`
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
    // Format: piru-pedido-{id} for full payment
    // Format: piru-pedido-{id}-split-{base64} for split payment
    // The base64 encodes: { clients: string[], mozoItems: number[] }
    let externalReference = `piru-pedido-${pedidoId}`
    if (isSplitPayment) {
      const splitData = {
        clients: hasClientes ? clientesAPagar.filter((c: string) => c !== 'Mozo') : [],
        mozoItems: hasMozoItems ? mozoItemIds : []
      }
      const splitBase64 = Buffer.from(JSON.stringify(splitData)).toString('base64')
      externalReference = `piru-pedido-${pedidoId}-split-${splitBase64}`
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
          success: `https://my.piru.app/pedido-cerrado`,
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

    console.log(`✅ Preferencia de pago creada: ${preference.id} para pedido ${pedidoId}${isSplitPayment ? ` (split)` : ''}`)

    // Si es split payment, crear registros en pago_subtotal para cada cliente e item de Mozo
    if (isSplitPayment) {
      const registeredKeys: string[] = []

      // Register regular clients (not Mozo)
      if (hasClientes) {
        const regularClients = clientesAPagar.filter((c: string) => c !== 'Mozo')
        for (const cliente of regularClients) {
          const itemsCliente = itemsAPagar.filter(item => item.clienteNombre === cliente)
          const subtotal = itemsCliente.reduce((sum, item) => {
            return sum + (parseFloat(item.precioUnitario) * (item.cantidad || 1))
          }, 0)

          if (subtotal > 0) {
            await db.insert(PagoSubtotalTable).values({
              pedidoId,
              clienteNombre: cliente,
              monto: subtotal.toFixed(2),
              estado: 'pending',
              metodo: 'mercadopago',
              mpPreferenceId: preference.id
            })
            registeredKeys.push(cliente)
          }
        }
      }

      // Register individual Mozo items
      if (hasMozoItems) {
        for (const itemId of mozoItemIds) {
          const item = itemsAPagar.find(i => i.id === itemId && i.clienteNombre === 'Mozo')
          if (!item) continue

          const subtotal = parseFloat(item.precioUnitario) * (item.cantidad || 1)
          const mozoKey = createMozoItemKey(itemId)

          await db.insert(PagoSubtotalTable).values({
            pedidoId,
            clienteNombre: mozoKey,
            monto: subtotal.toFixed(2),
            estado: 'pending',
            metodo: 'mercadopago',
            mpPreferenceId: preference.id
          })
          registeredKeys.push(mozoKey)
        }
      }

      console.log(`📝 Registros de pago_subtotal creados: ${registeredKeys.join(', ')}`)
    }

    // Devolver el init_point (URL de pago)
    return c.json({
      success: true,
      url_pago: preference.init_point,
      preference_id: preference.id,
      total: totalPago.toFixed(2),
      isSplitPayment,
      clientesPagando: isSplitPayment ? allKeysToCheck : null
    })
  } catch (error) {
    console.error('❌ Error creando preferencia de pago:', error)
    return c.json({ success: false, error: 'Error interno del servidor' }, 500)
  }
})

mercadopagoRoute.post('/crear-preferencia-externo', async (c) => {
  const db = drizzle(pool)
  try {
    const { pedidoId, tipoPedido } = await c.req.json()
    if (!pedidoId || !['delivery', 'takeaway'].includes(tipoPedido)) {
      return c.json({ success: false, error: 'Invalid config' }, 400)
    }

    let pedido, restauranteId, total, table
    if (tipoPedido === 'delivery') {
      const p = await db.select().from(PedidoDeliveryTable).where(eq(PedidoDeliveryTable.id, pedidoId)).limit(1)
      if (!p.length) return c.json({ success: false, error: 'Pedido no encontrado' }, 404)
      pedido = p[0]
      restauranteId = pedido.restauranteId!
      total = parseFloat(pedido.total || '0')
    } else {
      const p = await db.select().from(PedidoTakeawayTable).where(eq(PedidoTakeawayTable.id, pedidoId)).limit(1)
      if (!p.length) return c.json({ success: false, error: 'Pedido no encontrado' }, 404)
      pedido = p[0]
      restauranteId = pedido.restauranteId!
      total = parseFloat(pedido.total || '0')
    }

    const tokenValido = await obtenerTokenValido(restauranteId)
    if (!tokenValido) return c.json({ success: false, error: 'Restaurante MP error' }, 401)

    // Build the MP Item
    const mpItems = [{
      title: `Pedido ${tipoPedido} #${pedidoId}`,
      quantity: 1,
      currency_id: 'ARS',
      unit_price: total
    }]

    const baseUrl = 'https://my.piru.app'
    const externalReference = `piru-${tipoPedido}-${pedidoId}`

    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${tokenValido}`
      },
      body: JSON.stringify({
        items: mpItems,
        marketplace_fee: MP_MARKETPLACE_FEE,
        back_urls: {
          success: `${baseUrl}/success-delivery/${restauranteId}`, // User will see it processed
          failure: `${baseUrl}/success-delivery/${restauranteId}`,
          pending: `${baseUrl}/success-delivery/${restauranteId}`
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
    if (!mpResponse.ok) return c.json({ success: false, error: 'Error al crear preferencia' }, 500)

    return c.json({
      success: true,
      url_pago: preference.init_point,
      preference_id: preference.id,
      total: total.toFixed(2),
    })

  } catch (err) {
    return c.json({ success: false, error: 'Server err' }, 500)
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

    // Detectar si es un split payment o pedido de delivery/takeaway
    let isDelivery = externalReference.startsWith('piru-delivery-')
    let isTakeaway = externalReference.startsWith('piru-takeaway-')
    const isSplitPayment = externalReference.includes('-split-')
    let pedidoId: number
    let clientesPagados: string[] = []
    let mozoItemsPagados: number[] = []

    if (isDelivery || isTakeaway) {
      pedidoId = parseInt(externalReference.replace(isDelivery ? 'piru-delivery-' : 'piru-takeaway-', ''), 10)
    } else if (isSplitPayment) {
      // Parsear referencia de split payment
      const parts = externalReference.split('-split-')
      pedidoId = parseInt(parts[0].replace('piru-pedido-', ''), 10)
      try {
        const dataBase64 = parts[1]
        const parsedData = JSON.parse(Buffer.from(dataBase64, 'base64').toString('utf-8'))

        // Check if it's the new format or legacy format
        if (parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)) {
          // New format: { clients: [], mozoItems: [] }
          clientesPagados = parsedData.clients || []
          mozoItemsPagados = parsedData.mozoItems || []
          console.log(`🔀 [Webhook] Split payment (new format) - Clients: ${clientesPagados.join(', ')}, MozoItems: ${mozoItemsPagados.join(', ')}`)
        } else if (Array.isArray(parsedData)) {
          // Legacy format: ['client1', 'client2']
          clientesPagados = parsedData
          console.log(`🔀 [Webhook] Split payment (legacy) - Clientes: ${clientesPagados.join(', ')}`)
        } else {
          throw new Error('Unknown split payment format')
        }
      } catch (e) {
        console.error(`❌ [Webhook] Error parseando split payment: ${e}`)
        return c.json({ status: 'error', message: 'Invalid split reference' })
      }
    } else {
      pedidoId = parseInt(externalReference.replace('piru-pedido-', ''), 10)
    }

    if (isNaN(pedidoId)) {
      console.error(`❌ [Webhook] No se pudo parsear pedidoId de: ${externalReference}`)
      return c.json({ status: 'error', message: 'Invalid external reference' })
    }

    let pedidoData: any
    let mesaId: number | null = null
    let restauranteId: number

    if (isDelivery) {
      const pedido = await db.select().from(PedidoDeliveryTable).where(eq(PedidoDeliveryTable.id, pedidoId)).limit(1)
      if (!pedido || pedido.length === 0) return c.json({ status: 'error', message: 'Order not found' })
      pedidoData = pedido[0]
      restauranteId = pedidoData.restauranteId!
    } else if (isTakeaway) {
      const pedido = await db.select().from(PedidoTakeawayTable).where(eq(PedidoTakeawayTable.id, pedidoId)).limit(1)
      if (!pedido || pedido.length === 0) return c.json({ status: 'error', message: 'Order not found' })
      pedidoData = pedido[0]
      restauranteId = pedidoData.restauranteId!
    } else {
      const pedido = await db.select().from(PedidoTable).where(eq(PedidoTable.id, pedidoId)).limit(1)
      if (!pedido || pedido.length === 0) return c.json({ status: 'error', message: 'Order not found' })
      pedidoData = pedido[0]
      restauranteId = pedidoData.restauranteId!
      mesaId = pedidoData.mesaId!
    }

    // Obtener info de la mesa para la notificación si es mesa
    let mesaNombre = isDelivery ? 'Delivery' : (isTakeaway ? 'Take Away' : `Mesa ${mesaId}`)
    if (mesaId) {
      const mesa = await db.select()
        .from(MesaTable)
        .where(eq(MesaTable.id, mesaId))
        .limit(1)
      if (mesa.length > 0) mesaNombre = mesa[0].nombre
    }

    // Determinar estado del pago
    let estadoPago: 'pending' | 'paid' | 'failed' = 'pending'
    if (status === 'approved') {
      estadoPago = 'paid'
    } else if (status === 'rejected' || status === 'cancelled' || status === 'refunded') {
      estadoPago = 'failed'
    }

    if (isSplitPayment) {
      // ============ SPLIT PAYMENT ============
      // Build list of all keys to update (clients + Mozo item keys)
      const allKeysToUpdate: string[] = [...clientesPagados]
      for (const itemId of mozoItemsPagados) {
        allKeysToUpdate.push(createMozoItemKey(itemId))
      }

      // Verificar si los subtotales ya fueron pagados
      const subtotalesExistentes = await db.select()
        .from(PagoSubtotalTable)
        .where(and(
          eq(PagoSubtotalTable.pedidoId, pedidoId),
          inArray(PagoSubtotalTable.clienteNombre, allKeysToUpdate),
          eq(PagoSubtotalTable.estado, 'paid')
        ))

      if (subtotalesExistentes.length > 0 && status === 'approved') {
        console.log(`⏭️ [Webhook] Subtotales ya pagados: ${subtotalesExistentes.map(s => s.clienteNombre).join(', ')}`)
        return c.json({ status: 'already_processed' })
      }

      // Actualizar registros de pago_subtotal para cada key
      for (const key of allKeysToUpdate) {
        // Buscar el registro pendiente más reciente
        const subtotalPendiente = await db.select()
          .from(PagoSubtotalTable)
          .where(and(
            eq(PagoSubtotalTable.pedidoId, pedidoId),
            eq(PagoSubtotalTable.clienteNombre, key),
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
          console.log(`✅ [Webhook] Subtotal actualizado: key=${key}, estado=${estadoPago}`)
        } else {
          // Si no hay registro pendiente, crear uno nuevo (fallback)
          // For regular clients, calculate from items
          // For Mozo items, use the Mozo:item:X format
          let subtotal = 0

          if (isMozoItemKey(key)) {
            // Individual Mozo item
            const itemId = getMozoItemId(key)
            if (itemId) {
              const item = await db.select()
                .from(ItemPedidoTable)
                .where(and(
                  eq(ItemPedidoTable.pedidoId, pedidoId),
                  eq(ItemPedidoTable.id, itemId)
                ))
                .limit(1)

              if (item.length > 0) {
                subtotal = parseFloat(item[0].precioUnitario) * (item[0].cantidad || 1)
              }
            }
          } else {
            // Regular client
            const itemsCliente = await db.select()
              .from(ItemPedidoTable)
              .where(and(
                eq(ItemPedidoTable.pedidoId, pedidoId),
                eq(ItemPedidoTable.clienteNombre, key)
              ))

            subtotal = itemsCliente.reduce((sum, item) => {
              return sum + (parseFloat(item.precioUnitario) * (item.cantidad || 1))
            }, 0)
          }

          if (subtotal > 0) {
            await db.insert(PagoSubtotalTable).values({
              pedidoId,
              clienteNombre: key,
              monto: subtotal.toFixed(2),
              estado: estadoPago,
              metodo: 'mercadopago',
              mpPaymentId: String(paymentId)
            })
            console.log(`✅ [Webhook] Nuevo subtotal creado: key=${key}, estado=${estadoPago}`)
          }
        }
      }

      // Si el pago fue aprobado, notificar por WebSocket
      if (status === 'approved') {
        console.log(`🔔 [Webhook] Notificando pago de subtotales a restaurante ${restauranteId}`)

        // Obtener todos los subtotales del pedido para enviar estado actualizado (incluyendo clientes sin registro)
        const todosSubtotales = await getSubtotalesCompletos(pedidoId)

        // Notificar via WebSocket a clientes y admin
        await wsManager.notificarSubtotalesPagados(
          pedidoId,
          mesaId as number,
          allKeysToUpdate,
          todosSubtotales
        )

        console.log(`✅ [Webhook] Notificación de split payment enviada - Keys: ${allKeysToUpdate.join(', ')} en ${mesaNombre}`)
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
        // Insertar registro de pago
        const pagoValues: any = {
          metodo: 'mercadopago',
          estado: estadoPago,
          monto: String(transactionAmount || pedidoData.total),
          mpPaymentId: String(paymentId),
        }
        if (isDelivery) pagoValues.pedidoDeliveryId = pedidoId
        else if (isTakeaway) pagoValues.pedidoTakeawayId = pedidoId
        else pagoValues.pedidoId = pedidoId

        await db.insert(PagoTable).values(pagoValues)
        console.log(`✅ [Webhook] Pago registrado: pedido=${pedidoId}, estado=${estadoPago}`)

        // Actualizar tabla principal
        if (estadoPago === 'paid') {
          if (isDelivery) await db.update(PedidoDeliveryTable).set({ pagado: true, metodoPago: 'mercadopago' }).where(eq(PedidoDeliveryTable.id, pedidoId))
          else if (isTakeaway) await db.update(PedidoTakeawayTable).set({ pagado: true, metodoPago: 'mercadopago' }).where(eq(PedidoTakeawayTable.id, pedidoId))
          else await db.update(PedidoTable).set({ pagado: true, metodoPago: 'mercadopago' }).where(eq(PedidoTable.id, pedidoId))
        }
      } else {
        // Actualizar registro existente
        await db.update(PagoTable)
          .set({
            estado: estadoPago,
            monto: String(transactionAmount || pedidoData.total),
          })
          .where(eq(PagoTable.mpPaymentId, String(paymentId)))

        if (estadoPago === 'paid') {
          if (isDelivery) await db.update(PedidoDeliveryTable).set({ pagado: true, metodoPago: 'mercadopago' }).where(eq(PedidoDeliveryTable.id, pedidoId))
          else if (isTakeaway) await db.update(PedidoTakeawayTable).set({ pagado: true, metodoPago: 'mercadopago' }).where(eq(PedidoTakeawayTable.id, pedidoId))
          else await db.update(PedidoTable).set({ pagado: true, metodoPago: 'mercadopago' }).where(eq(PedidoTable.id, pedidoId))
        }

        console.log(`✅ [Webhook] Pago actualizado: pedido=${pedidoId}, estado=${estadoPago}`)
      }

      // Si el pago fue aprobado, notificar al admin por WebSocket
      if (status === 'approved') {
        console.log(`🔔 [Webhook] Notificando pago aprobado a restaurante ${restauranteId}`)

        // Usar el mismo método que usa pagarPedido en el websocket manager
        // Esto enviará la notificación PAGO_RECIBIDO al admin
        if (!isDelivery && !isTakeaway) {
          await wsManager.pagarPedido(
            pedidoId,
            mesaId as number,
            'mercadopago',
            String(transactionAmount || pedidoData.total)
          )
        } else {
          wsManager.broadcastAdminUpdate(restauranteId, isDelivery ? 'delivery' : 'takeaway')

          // Also notify WebSocket directly for public to update status
          const wsRoom = isDelivery ? `public:delivery:${pedidoId}` : `public:takeaway:${pedidoId}`
          // We'll trust the database refresh, but we can also broadcast it.
        }

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

    const esCarrito = restaurante[0]?.esCarrito === true;

    // 3. Validar estado
    if (esCarrito) {
      // En carrito se puede pagar si NO está pendiente (preparing, delivered, closed ok)
      if (pedido[0].estado === 'pending') {
        return c.json({ success: false, error: 'El pedido debe estar confirmado para pagarlo' }, 400)
      }
    } else {
      // En restaurante normal, DEBE estar cerrado
      if (pedido[0].estado !== 'closed') {
        return c.json({ success: false, error: 'El pedido debe estar cerrado para pagarlo' }, 400)
      }
    }

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

