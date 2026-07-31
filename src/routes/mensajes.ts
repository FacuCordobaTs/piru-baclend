import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import {
  resumenWallet,
  listarTransacciones,
  setAutoRecarga,
  listarPacks,
  getPack,
  crearRecargaPendiente,
  setRecargaPreferencia,
} from '../lib/mensajes-wallet'

// Pago de recargas: van a la cuenta de la PLATAFORMA (Piru), no a la del restaurante,
// por eso se usa el access token de plataforma y sin marketplace_fee.
const MP_PLATFORM_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
const ADMIN_URL = (process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')
const MP_WEBHOOK_URL = 'https://api.piru.app/api/mp/webhook'

const mensajesRoute = new Hono()

mensajesRoute.use('*', authMiddleware)

/** Saldo / wallet de mensajes del restaurante autenticado (para el widget de saldo + recarga). */
mensajesRoute.get('/saldo', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  try {
    const data = await resumenWallet(db, restauranteId)
    return c.json({ success: true, data }, 200)
  } catch (error) {
    console.error('Error getting saldo de mensajes:', error)
    return c.json({ message: 'Error al obtener el saldo', success: false }, 500)
  }
})

/** Historial de movimientos (ledger) — auditoría y resolución de reclamos. */
mensajesRoute.get('/transacciones', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const page = Number(c.req.query('page')) || 1
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
  const offset = (page - 1) * limit
  try {
    const data = await listarTransacciones(db, restauranteId, { limit, offset })
    return c.json({
      success: true,
      data,
      pagination: { page, limit, hasMore: data.length === limit },
    }, 200)
  } catch (error) {
    console.error('Error getting transacciones de mensajes:', error)
    return c.json({ message: 'Error al obtener movimientos', success: false }, 500)
  }
})

/** Configurar auto-recarga (el que no quiere pensar, la activa y listo). */
const autoRecargaSchema = z.object({
  habilitada: z.boolean(),
  umbral: z.number().int().min(0).nullable().optional(),
  cantidad: z.number().int().positive().nullable().optional(),
})

mensajesRoute.put('/auto-recarga', zValidator('json', autoRecargaSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const cfg = c.req.valid('json')
  try {
    await setAutoRecarga(db, restauranteId, cfg)
    const data = await resumenWallet(db, restauranteId)
    return c.json({ success: true, message: 'Auto-recarga actualizada', data }, 200)
  } catch (error) {
    console.error('Error updating auto-recarga:', error)
    return c.json({ message: 'Error al actualizar auto-recarga', success: false }, 500)
  }
})

/** Packs de recarga disponibles (para el selector de recarga en 2 taps). */
mensajesRoute.get('/packs', async (c) => {
  const db = drizzle(pool)
  const categoria = c.req.query('categoria') as 'utility' | 'marketing' | undefined
  try {
    const packs = await listarPacks(db, categoria === 'marketing' ? 'marketing' : categoria === 'utility' ? 'utility' : undefined)
    return c.json({ success: true, data: packs }, 200)
  } catch (error) {
    console.error('Error getting packs de recarga:', error)
    return c.json({ message: 'Error al obtener packs', success: false }, 500)
  }
})

/**
 * Inicia la compra de un pack: crea la recarga pendiente y una preferencia de
 * MercadoPago (pago a la cuenta de Piru). Devuelve el init_point para redirigir.
 * El precio SIEMPRE sale del pack en la DB (nunca del cliente).
 */
const checkoutSchema = z.object({ packId: z.number().int().positive() })

mensajesRoute.post('/recarga/checkout', zValidator('json', checkoutSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { packId } = c.req.valid('json')

  if (!MP_PLATFORM_ACCESS_TOKEN) {
    console.error('❌ [Recarga] Falta MP_ACCESS_TOKEN para cobrar recargas')
    return c.json({ message: 'Pagos no disponibles temporalmente', success: false }, 503)
  }

  try {
    const pack = await getPack(db, packId)
    if (!pack) {
      return c.json({ message: 'Pack no encontrado', success: false }, 404)
    }

    const categoria = pack.categoria as 'utility' | 'marketing'
    const precio = parseFloat(String(pack.precio))

    // 1. Recarga pendiente (aún no acredita saldo; se acredita en el webhook).
    const recargaId = await crearRecargaPendiente(db, restauranteId, {
      categoria,
      cantidad: pack.cantidad,
      monto: pack.precio,
      packRecargaId: pack.id,
      origen: 'manual',
    })

    const externalReference = `piru-recarga-${recargaId}`
    const backUrl = `${ADMIN_URL}/dashboard/ajustes/plan?recarga=success`

    // 2. Preferencia de MercadoPago con el token de la plataforma (sin marketplace_fee).
    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MP_PLATFORM_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        items: [{
          title: `${pack.nombre} · ${pack.cantidad} mensajes`,
          quantity: 1,
          currency_id: 'ARS',
          unit_price: precio,
        }],
        back_urls: { success: backUrl, failure: backUrl, pending: backUrl },
        auto_return: 'approved',
        external_reference: externalReference,
        notification_url: MP_WEBHOOK_URL,
        statement_descriptor: 'PIRU',
        expires: true,
        expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    })

    const preference = await mpResponse.json() as any
    if (!mpResponse.ok) {
      console.error('❌ [Recarga] Error creando preferencia MP:', preference)
      return c.json({ message: 'Error al iniciar el pago', success: false }, 502)
    }

    await setRecargaPreferencia(db, recargaId, String(preference.id))

    return c.json({
      success: true,
      data: {
        recargaId,
        url_pago: preference.init_point,
        preference_id: preference.id,
        cantidad: pack.cantidad,
        monto: precio.toFixed(2),
      },
    }, 200)
  } catch (error) {
    console.error('Error en checkout de recarga:', error)
    return c.json({ message: 'Error al iniciar la recarga', success: false }, 500)
  }
})

export { mensajesRoute }
