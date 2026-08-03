import { Hono } from 'hono'
import { randomUUID } from 'crypto'
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
  resolverPackAutoRecarga,
} from '../lib/mensajes-wallet'
import { crearPreferenciaRecargaMP } from '../lib/mp-recarga'

// Pago de recargas: van a la cuenta de la PLATAFORMA (Piru), no a la del restaurante,
// por eso se usa el access token de plataforma y sin marketplace_fee.
const MP_PLATFORM_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
const ADMIN_URL = (process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')

/** Minutos de validez del link/QR de pago antes de vencer. */
const PAGO_QR_TTL_MIN = 30

const mensajesRoute = new Hono()

mensajesRoute.use('*', authMiddleware)

type PackRow = { id: number; categoria: string; nombre: string; cantidad: number; precio: string | number }

/**
 * Crea la recarga pendiente + la preferencia de Checkout Pro (a la cuenta de Piru, sin
 * marketplace_fee) para comprar un pack. Compartido por la recarga manual y la auto-recarga.
 * El crédito se aplica recién en el webhook al aprobarse el pago.
 */
async function iniciarCheckoutRecarga(
  db: ReturnType<typeof drizzle>,
  restauranteId: number,
  pack: PackRow,
  origen: 'manual' | 'auto',
): Promise<
  | { ok: true; data: { recargaId: number; url_pago: string; preference_id: string; cantidad: number; monto: string } }
  | { ok: false; status: 502; message: string }
> {
  const categoria = pack.categoria as 'utility' | 'marketing'
  const precio = parseFloat(String(pack.precio))

  const recargaId = await crearRecargaPendiente(db, restauranteId, {
    categoria,
    cantidad: pack.cantidad,
    monto: pack.precio,
    packRecargaId: pack.id,
    origen,
  })

  const backUrl = `${ADMIN_URL}/dashboard/ajustes/plan?recarga=success`
  const pref = await crearPreferenciaRecargaMP({
    recargaId,
    titulo: `${pack.nombre} · ${pack.cantidad} mensajes`,
    precio,
    backUrl,
  })
  if (!pref.ok) {
    return { ok: false, status: 502, message: 'Error al iniciar el pago' }
  }

  await setRecargaPreferencia(db, recargaId, pref.preferenceId)

  return {
    ok: true,
    data: {
      recargaId,
      url_pago: pref.initPoint,
      preference_id: pref.preferenceId,
      cantidad: pack.cantidad,
      monto: precio.toFixed(2),
    },
  }
}

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

    const res = await iniciarCheckoutRecarga(db, restauranteId, pack, 'manual')
    if (!res.ok) return c.json({ message: res.message, success: false }, res.status)
    return c.json({ success: true, data: res.data }, 200)
  } catch (error) {
    console.error('Error en checkout de recarga:', error)
    return c.json({ message: 'Error al iniciar la recarga', success: false }, 500)
  }
})

/**
 * Genera un link/QR de pago para un pack (patrón "la compu muestra, el celu paga"): crea
 * la recarga pendiente con un token de un solo uso y devuelve la URL pública `/pago/:token`
 * para codificar en un QR. El pago en sí (elegir MP → Checkout Pro) ocurre en la página
 * pública, sin login. El precio SIEMPRE sale del pack en la DB.
 */
mensajesRoute.post('/pago-qr', zValidator('json', checkoutSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { packId } = c.req.valid('json')

  if (!MP_PLATFORM_ACCESS_TOKEN) {
    console.error('❌ [Pago QR] Falta MP_ACCESS_TOKEN para cobrar recargas')
    return c.json({ message: 'Pagos no disponibles temporalmente', success: false }, 503)
  }

  try {
    const pack = await getPack(db, packId)
    if (!pack) {
      return c.json({ message: 'Pack no encontrado', success: false }, 404)
    }

    const token = randomUUID()
    const expiraEn = new Date(Date.now() + PAGO_QR_TTL_MIN * 60 * 1000)

    const recargaId = await crearRecargaPendiente(db, restauranteId, {
      categoria: pack.categoria as 'utility' | 'marketing',
      cantidad: pack.cantidad,
      monto: pack.precio,
      packRecargaId: pack.id,
      origen: 'manual',
      token,
      tokenExpiraEn: expiraEn,
    })

    return c.json({
      success: true,
      data: {
        recargaId,
        token,
        url: `${ADMIN_URL}/pago/${token}`,
        expiraEn: expiraEn.toISOString(),
      },
    }, 200)
  } catch (error) {
    console.error('Error generando link de pago QR:', error)
    return c.json({ message: 'Error al generar el link de pago', success: false }, 500)
  }
})

/**
 * Auto-recarga asistida: sin card-on-file no se cobra en silencio. Cuando el saldo cae
 * bajo el umbral configurado, el local activa la auto-recarga y con un tap dispara este
 * endpoint, que elige el pack por su config y arma el Checkout Pro listo para pagar
 * (origen 'auto'). No requiere que elija pack ni recuerde el precio.
 */
mensajesRoute.post('/auto-recarga/checkout', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  if (!MP_PLATFORM_ACCESS_TOKEN) {
    console.error('❌ [Auto-recarga] Falta MP_ACCESS_TOKEN para cobrar recargas')
    return c.json({ message: 'Pagos no disponibles temporalmente', success: false }, 503)
  }

  try {
    const resumen = await resumenWallet(db, restauranteId)
    if (!resumen.autoRecarga.habilitada) {
      return c.json({ message: 'La auto-recarga no está activada', success: false }, 400)
    }

    const pack = await resolverPackAutoRecarga(db, restauranteId)
    if (!pack) {
      return c.json({ message: 'No hay packs de recarga disponibles', success: false }, 404)
    }

    const res = await iniciarCheckoutRecarga(db, restauranteId, pack, 'auto')
    if (!res.ok) return c.json({ message: res.message, success: false }, res.status)
    return c.json({ success: true, data: res.data }, 200)
  } catch (error) {
    console.error('Error en checkout de auto-recarga:', error)
    return c.json({ message: 'Error al iniciar la auto-recarga', success: false }, 500)
  }
})

export { mensajesRoute }
