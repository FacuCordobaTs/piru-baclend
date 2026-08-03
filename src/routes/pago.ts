// src/routes/pago.ts
// Página de pago por link/QR: SIN autenticación. El token (creado por POST /mensajes/pago-qr,
// autenticado) es la única autorización de ese pago único. Sirve el patrón "la compu muestra,
// el celu paga": el desktop genera el QR, el dueño lo escanea con el celular y paga ahí, sin
// loguearse. Por ahora sólo MercadoPago como medio de pago. El crédito al wallet lo aplica el
// webhook de MP (external_reference `piru-recarga-{id}`), idéntico al checkout autenticado.
import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import { pool } from '../db'
import {
  recargaMensajes as RecargaMensajesTable,
  restaurante as RestauranteTable,
  packRecarga as PackRecargaTable,
} from '../db/schema'
import { getRecargaPorToken, setRecargaPreferencia } from '../lib/mensajes-wallet'
import { crearPreferenciaRecargaMP, pagosRecargaDisponibles } from '../lib/mp-recarga'

const ADMIN_URL = (process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')

const pagoRoute = new Hono()

type EstadoLink = 'pending' | 'paid' | 'expired'

/** Etiqueta legible del tipo de mensaje que recarga el pack. */
function unidad(categoria: string): string {
  return categoria === 'marketing' ? 'mensajes de campaña' : 'avisos por WhatsApp'
}

/** Carga la recarga por token + datos para mostrar (restaurante, pack) y resuelve el estado. */
async function cargarLink(db: ReturnType<typeof drizzle>, token: string) {
  const recarga = await getRecargaPorToken(db, token)
  if (!recarga) return null

  const [rest] = await db
    .select({ nombre: RestauranteTable.nombre })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, recarga.restauranteId))
    .limit(1)

  let packNombre: string | null = null
  if (recarga.packRecargaId) {
    const [pack] = await db
      .select({ nombre: PackRecargaTable.nombre })
      .from(PackRecargaTable)
      .where(eq(PackRecargaTable.id, recarga.packRecargaId))
      .limit(1)
    packNombre = pack?.nombre ?? null
  }

  const vencido = recarga.tokenExpiraEn ? new Date(recarga.tokenExpiraEn) < new Date() : false
  const estado: EstadoLink = recarga.estado === 'paid' ? 'paid' : vencido ? 'expired' : 'pending'

  return { recarga, restauranteNombre: rest?.nombre ?? 'El local', packNombre, estado }
}

/** Info pública del link de pago (para renderizar la página `/pago/:token`). */
pagoRoute.get('/:token', async (c) => {
  const db = drizzle(pool)
  const token = c.req.param('token')

  try {
    const info = await cargarLink(db, token)
    if (!info) return c.json({ message: 'Link de pago no encontrado', success: false }, 404)

    const { recarga, restauranteNombre, packNombre, estado } = info
    return c.json({
      success: true,
      data: {
        estado,
        restauranteNombre,
        concepto: packNombre ?? `${recarga.cantidad} ${unidad(recarga.categoria)}`,
        cantidad: recarga.cantidad,
        categoria: recarga.categoria,
        unidad: unidad(recarga.categoria),
        monto: recarga.monto,
      },
    }, 200)
  } catch (error) {
    console.error('Error obteniendo link de pago:', error)
    return c.json({ message: 'Error al obtener el link de pago', success: false }, 500)
  }
})

/**
 * Inicia el pago del link con MercadoPago: crea la preferencia de Checkout Pro sobre la
 * recarga pendiente del token y devuelve el init_point. Idempotente frente a estados: si ya
 * está pagado o vencido, no cobra de nuevo.
 */
pagoRoute.post('/:token/checkout', async (c) => {
  const db = drizzle(pool)
  const token = c.req.param('token')

  if (!pagosRecargaDisponibles()) {
    console.error('❌ [Pago QR] Falta MP_ACCESS_TOKEN para cobrar recargas')
    return c.json({ message: 'Pagos no disponibles temporalmente', success: false }, 503)
  }

  try {
    const info = await cargarLink(db, token)
    if (!info) return c.json({ message: 'Link de pago no encontrado', success: false }, 404)
    if (info.estado === 'paid') {
      return c.json({ message: 'Este pago ya fue realizado', success: false, estado: 'paid' }, 409)
    }
    if (info.estado === 'expired') {
      return c.json({ message: 'El link de pago venció. Pedí uno nuevo desde el panel.', success: false, estado: 'expired' }, 410)
    }

    const { recarga, packNombre } = info
    const precio = parseFloat(String(recarga.monto))
    const backUrl = `${ADMIN_URL}/pago/${token}?estado=success`

    const pref = await crearPreferenciaRecargaMP({
      recargaId: recarga.id,
      titulo: packNombre ?? `${recarga.cantidad} ${unidad(recarga.categoria)}`,
      precio,
      backUrl,
    })
    if (!pref.ok) {
      return c.json({ message: 'Error al iniciar el pago', success: false }, 502)
    }

    await setRecargaPreferencia(db, recarga.id, pref.preferenceId)
    return c.json({ success: true, data: { url_pago: pref.initPoint } }, 200)
  } catch (error) {
    console.error('Error en checkout del link de pago:', error)
    return c.json({ message: 'Error al iniciar el pago', success: false }, 500)
  }
})

export { pagoRoute }
