import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import { pool } from '../db'
import { restaurante as RestauranteTable } from '../db/schema'
import { authMiddleware } from '../middleware/auth'

const whatsappOauthRoute = new Hono()

const META_APP_ID = '939939975659282'
const META_APP_SECRET = process.env.META_APP_SECRET!
const META_API_VERSION = 'v22.0'

/**
 * POST /api/whatsapp-oauth/connect
 * Recibe el code del Embedded Signup, lo intercambia por un token de sistema,
 * obtiene el WABA ID y phone_number_id, suscribe el webhook, y guarda todo en DB.
 */
whatsappOauthRoute.post('/connect', authMiddleware, async (c) => {
  const restauranteId = (c as any).user.id
  const { code } = await c.req.json()

  if (!code) {
    return c.json({ success: false, message: 'Code requerido' }, 400)
  }

  const db = drizzle(pool)

  try {
    // 1. Intercambiar code por user access token.
    // El code viene del FB.login del SDK de JS, que corre en
    // https://admin.piru.app/dashboard/perfil. Con "modo estricto de redirect_uri"
    // activado en la app de Meta, el exchange debe mandar EXACTAMENTE el mismo
    // redirect_uri que está en "URI de redireccionamiento de OAuth válidos",
    // sino Meta devuelve OAuthException subcode 36008.
    const tokenRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: META_APP_ID,
          client_secret: META_APP_SECRET,
          redirect_uri: 'https://admin.piru.app/dashboard/perfil',
          code: code,
        }).toString(),
      }
    )
    const tokenData = await tokenRes.json() as any
    if (!tokenData.access_token) {
      console.error('[WA OAuth] Error intercambiando code:', tokenData)
      return c.json({ success: false, message: 'Error al obtener token de Meta' }, 400)
    }
    const userAccessToken = tokenData.access_token

    // 2. Obtener el WABA al que el restaurante dio acceso
    const debugRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/debug_token?` +
      `input_token=${userAccessToken}&access_token=${META_APP_ID}|${META_APP_SECRET}`
    )
    const debugData = await debugRes.json() as any
    console.log('[WA OAuth] debug_token:', JSON.stringify(debugData))

    const wabaScope = debugData.data?.granular_scopes?.find(
      (s: any) => s.scope === 'whatsapp_business_management'
    )
    const wabaId = wabaScope?.target_ids?.[0]
    if (!wabaId) {
      console.error('[WA OAuth] No se encontró WABA ID:', debugData)
      return c.json({ success: false, message: 'No se encontró la cuenta de WhatsApp Business' }, 400)
    }

    // 3. Obtener los phone numbers del WABA
    const phonesRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${wabaId}/phone_numbers?` +
      `access_token=${userAccessToken}`
    )
    const phonesData = await phonesRes.json() as any
    if (!phonesData.data?.length) {
      return c.json({ success: false, message: 'No se encontraron números de teléfono en la cuenta' }, 400)
    }
    const phoneNumberId = phonesData.data[0].id
    const phoneNumber = phonesData.data[0].display_phone_number

    // 4. Generar token de larga duración (60 días)
    const longTokenRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?` +
      `grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${userAccessToken}`
    )
    const longTokenData = await longTokenRes.json() as any
    const accessToken = longTokenData.access_token ?? userAccessToken
    const tokenExpiry = new Date(Date.now() + 55 * 24 * 60 * 60 * 1000) // 55 días

    // 5. Suscribir al webhook de Piru
    const subscribeRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}/subscribed_apps`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    )
    const subscribeData = await subscribeRes.json() as any
    if (!subscribeData.success) {
      console.warn('[WA OAuth] Warning suscribiendo webhook:', subscribeData)
    }

    // 6. Guardar en DB
    await db.update(RestauranteTable)
      .set({
        whatsappPhoneId: phoneNumberId,
        whatsappNumber: phoneNumber,
        whatsappWabaId: wabaId,
        whatsappAccessToken: accessToken,
        whatsappTokenExpiry: tokenExpiry,
        whatsappEnabled: true,
      })
      .where(eq(RestauranteTable.id, restauranteId))

    console.log(`✅ [WA OAuth] Restaurante ${restauranteId} conectó WhatsApp: ${phoneNumber} (${phoneNumberId})`)

    return c.json({
      success: true,
      phoneNumber,
      phoneNumberId,
      wabaId,
    })

  } catch (error) {
    console.error('[WA OAuth] Error:', error)
    return c.json({ success: false, message: 'Error inesperado al conectar WhatsApp' }, 500)
  }
})

/**
 * DELETE /api/whatsapp-oauth/disconnect
 */
whatsappOauthRoute.delete('/disconnect', authMiddleware, async (c) => {
  const restauranteId = (c as any).user.id
  const db = drizzle(pool)

  await db.update(RestauranteTable)
    .set({
      whatsappPhoneId: null,
      whatsappNumber: null,
      whatsappWabaId: null,
      whatsappAccessToken: null,
      whatsappTokenExpiry: null,
      whatsappEnabled: false,
    })
    .where(eq(RestauranteTable.id, restauranteId))

  return c.json({ success: true })
})

/**
 * GET /api/whatsapp-oauth/status
 */
whatsappOauthRoute.get('/status', authMiddleware, async (c) => {
  const restauranteId = (c as any).user.id
  const db = drizzle(pool)

  const [r] = await db
    .select({
      whatsappEnabled: RestauranteTable.whatsappEnabled,
      whatsappNumber: RestauranteTable.whatsappNumber,
      whatsappPhoneId: RestauranteTable.whatsappPhoneId,
      whatsappAccessToken: RestauranteTable.whatsappAccessToken,
      whatsappTokenExpiry: RestauranteTable.whatsappTokenExpiry,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  const conectado = !!(r?.whatsappEnabled && r?.whatsappPhoneId && r?.whatsappAccessToken)
  const tokenVencido = r?.whatsappTokenExpiry ? new Date(r.whatsappTokenExpiry) < new Date() : false

  return c.json({
    success: true,
    conectado,
    phoneNumber: r?.whatsappNumber ?? null,
    tokenVencido,
  })
})

export { whatsappOauthRoute }
