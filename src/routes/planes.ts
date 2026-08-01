import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { eq, asc, and } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth'
import {
  plan as PlanTable,
  planFeature as PlanFeatureTable,
  restaurante as RestauranteTable,
} from '../db/schema'
import { resolverSuscripcion, tieneAccesoAlPanel } from '../lib/planes'
import { resumenWallet } from '../lib/mensajes-wallet'
import {
  crearPagoSuscripcionPendiente,
  setPagoSuscripcionPreferencia,
  cancelarSuscripcion,
  resolverEstadoVigente,
  listarPagosSuscripcion,
  montoPorCiclo,
  type CicloPago,
} from '../lib/suscripciones'

// Los pagos de la cuota del plan van a la cuenta de la PLATAFORMA (Piru), con el
// token de plataforma y sin marketplace_fee (100% a Piru). Checkout Pro, pago único.
const MP_PLATFORM_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
const ADMIN_URL = (process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')
const MP_WEBHOOK_URL = 'https://api.piru.app/api/mp/webhook'

const planesRoute = new Hono()

planesRoute.use('*', authMiddleware)

/**
 * Catálogo de planes activos con sus features. Alimenta la pantalla de pricing:
 * la UI muestra TODOS los planes (con candado en lo que falta) para que ver lo
 * bloqueado genere el upgrade. Una feature invisible no se desea.
 */
planesRoute.get('/catalogo', async (c) => {
  const db = drizzle(pool)

  try {
    const planes = await db
      .select()
      .from(PlanTable)
      .where(eq(PlanTable.activo, true))
      .orderBy(asc(PlanTable.orden))

    const features = await db
      .select({
        planId: PlanFeatureTable.planId,
        featureKey: PlanFeatureTable.featureKey,
        habilitado: PlanFeatureTable.habilitado,
      })
      .from(PlanFeatureTable)

    const featuresPorPlan = new Map<number, string[]>()
    for (const f of features) {
      if (!f.habilitado) continue
      if (!featuresPorPlan.has(f.planId)) featuresPorPlan.set(f.planId, [])
      featuresPorPlan.get(f.planId)!.push(f.featureKey)
    }

    const data = planes.map((p) => ({
      ...p,
      features: featuresPorPlan.get(p.id) || [],
    }))

    return c.json({ success: true, data }, 200)
  } catch (error) {
    console.error('Error getting catálogo de planes:', error)
    return c.json({ message: 'Error al obtener planes', success: false }, 500)
  }
})

/**
 * Suscripción vigente del restaurante autenticado + features habilitadas ahora
 * mismo + saldo de mensajes. Es lo que la UI usa para saber qué mostrar bloqueado.
 */
planesRoute.get('/mi-suscripcion', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    // Transición lazy de estado (venció el cobro → gracia → suspendida) antes de leer.
    const vigente = await resolverEstadoVigente(db, restauranteId)
    const suscripcion = await resolverSuscripcion(db, restauranteId)
    const wallet = await resumenWallet(db, restauranteId)
    const [restauranteRow] = await db
      .select({ requiereSuscripcion: RestauranteTable.requiereSuscripcion })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)
    const requiereSuscripcion = !!restauranteRow?.requiereSuscripcion

    return c.json(
      {
        success: true,
        data: {
          estado: suscripcion.estado,
          planId: suscripcion.planId,
          planCodigo: suscripcion.planCodigo,
          planNombre: suscripcion.planNombre,
          conAccesoAPago: suscripcion.conAccesoAPago,
          sinSuscripcion: suscripcion.sinSuscripcion,
          // Hard paywall: ¿puede entrar al panel? El gate y la página /suscribir lo usan.
          requiereSuscripcion,
          accesoPanel: tieneAccesoAlPanel(requiereSuscripcion, suscripcion),
          // Fechas de facturación (para mostrar próximo cobro / gracia en la UI).
          fechaProximoCobro: vigente?.fechaProximoCobro ?? null,
          graciaHasta: vigente?.graciaHasta ?? null,
          fechaCancelacion: vigente?.fechaCancelacion ?? null,
          precioMensual: vigente?.precioMensual ?? null,
          ciclo: vigente?.ciclo ?? null,
          // Lista de features de pago habilitadas ahora; la UI candadea el resto.
          features: Array.from(suscripcion.features),
          wallet,
        },
      },
      200,
    )
  } catch (error) {
    console.error('Error getting mi-suscripcion:', error)
    return c.json({ message: 'Error al obtener suscripción', success: false }, 500)
  }
})

/**
 * Inicia el pago de la cuota del plan vía Checkout Pro (pago único a la cuenta de
 * Piru). Crea un pago pendiente + preferencia de MP y devuelve el init_point para
 * redirigir. El precio SIEMPRE sale del plan en la DB (nunca del cliente). El acceso
 * NO se otorga acá: se activa recién en el webhook al aprobarse el pago.
 */
const suscribirSchema = z.object({
  planId: z.number().int().positive(),
  ciclo: z.enum(['mensual', 'anual']).optional(),
})

planesRoute.post('/suscribir', zValidator('json', suscribirSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { planId, ciclo: cicloInput } = c.req.valid('json')
  const ciclo: CicloPago = cicloInput === 'anual' ? 'anual' : 'mensual'

  if (!MP_PLATFORM_ACCESS_TOKEN) {
    console.error('❌ [Suscripción] Falta MP_ACCESS_TOKEN para cobrar la cuota del plan')
    return c.json({ message: 'Pagos no disponibles temporalmente', success: false }, 503)
  }

  try {
    const [planRow] = await db
      .select()
      .from(PlanTable)
      .where(and(eq(PlanTable.id, planId), eq(PlanTable.activo, true)))
      .limit(1)
    if (!planRow) {
      return c.json({ message: 'Plan no encontrado', success: false }, 404)
    }

    const precioMensual = parseFloat(String(planRow.precioMensual))
    const monto = montoPorCiclo(precioMensual, ciclo)

    if (monto <= 0) {
      // Plan gratis: no tiene sentido cobrarlo por MP. Debería activarse por otra vía.
      return c.json({ message: 'Este plan no requiere pago', success: false }, 400)
    }

    // 1. Pago pendiente (aún no da acceso; se activa en el webhook).
    const pagoId = await crearPagoSuscripcionPendiente(db, restauranteId, {
      planId,
      ciclo,
      monto,
    })

    const externalReference = `piru-plansub-${pagoId}`
    const backUrl = `${ADMIN_URL}/dashboard/ajustes/plan?plan=success`

    // 2. Preferencia de Checkout Pro con el token de plataforma (sin marketplace_fee).
    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MP_PLATFORM_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        items: [{
          title: `Piru ${planRow.nombre} · ${ciclo === 'anual' ? 'Anual' : 'Mensual'}`,
          quantity: 1,
          currency_id: 'ARS',
          unit_price: monto,
        }],
        back_urls: { success: backUrl, failure: backUrl, pending: backUrl },
        auto_return: 'approved',
        external_reference: externalReference,
        notification_url: MP_WEBHOOK_URL,
        statement_descriptor: 'PIRU',
        expires: true,
        expiration_date_to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    })

    const preference = await mpResponse.json() as any
    if (!mpResponse.ok) {
      console.error('❌ [Suscripción] Error creando preferencia MP:', preference)
      return c.json({ message: 'Error al iniciar el pago', success: false }, 502)
    }

    await setPagoSuscripcionPreferencia(db, pagoId, String(preference.id))

    return c.json({
      success: true,
      data: {
        pagoId,
        url_pago: preference.init_point,
        preference_id: preference.id,
        monto: monto.toFixed(2),
        ciclo,
      },
    }, 200)
  } catch (error) {
    console.error('Error en checkout de suscripción:', error)
    return c.json({ message: 'Error al iniciar el pago del plan', success: false }, 500)
  }
})

/** Baja voluntaria. No corta en el acto: mantiene acceso hasta el fin del período pago. */
planesRoute.post('/cancelar', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  try {
    const ok = await cancelarSuscripcion(db, restauranteId)
    if (!ok) return c.json({ message: 'No tenés una suscripción activa', success: false }, 404)
    return c.json({ success: true, message: 'Suscripción cancelada' }, 200)
  } catch (error) {
    console.error('Error cancelando suscripción:', error)
    return c.json({ message: 'Error al cancelar la suscripción', success: false }, 500)
  }
})

/** Historial de pagos de la cuota del plan (comprobantes). */
planesRoute.get('/pagos', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  try {
    const data = await listarPagosSuscripcion(db, restauranteId)
    return c.json({ success: true, data }, 200)
  } catch (error) {
    console.error('Error listando pagos de suscripción:', error)
    return c.json({ message: 'Error al obtener los pagos', success: false }, 500)
  }
})

export { planesRoute }
