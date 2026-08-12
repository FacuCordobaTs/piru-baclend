import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { eq, asc, and, gte, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth'
import {
  plan as PlanTable,
  planFeature as PlanFeatureTable,
  restaurante as RestauranteTable,
  suscripcion as SuscripcionTable,
  pedidoUnificado as PedidoUnificadoTable,
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
import { crearPreferenciaSuscripcionMP } from '../lib/mp-suscripcion'
import { sendPaymentLinkWhatsApp } from '../services/whatsapp'

/** Minutos de validez del link de pago (enviado por WhatsApp) antes de vencer. */
const PAGO_LINK_TTL_MIN = 60

// Los pagos de la cuota del plan van a la cuenta de la PLATAFORMA (Piru), con el
// token de plataforma y sin marketplace_fee (100% a Piru). Checkout Pro, pago único.
const MP_PLATFORM_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
const ADMIN_URL = (process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')

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

    // Contador de VALOR (no de días): "Recibiste X pedidos por $Y". Cuenta los pedidos que
    // ENTRARON por Piru (web, no anotados a mano) desde que arrancó el ciclo (`fechaInicio`).
    const contarValorPiru = async (desde: Date): Promise<{ pedidos: number; monto: number }> => {
      const [valorRow] = await db
        .select({
          pedidos: sql<number>`COUNT(*)`,
          monto: sql<string>`COALESCE(SUM(${PedidoUnificadoTable.total}), 0)`,
        })
        .from(PedidoUnificadoTable)
        .where(
          and(
            eq(PedidoUnificadoTable.restauranteId, restauranteId),
            eq(PedidoUnificadoTable.anotadoManualmente, false),
            gte(PedidoUnificadoTable.createdAt, desde),
          ),
        )
      return {
        pedidos: Number(valorRow?.pedidos ?? 0),
        monto: parseFloat(String(valorRow?.monto ?? '0')),
      }
    }

    // Trial (Tarea 6 del Claim Flow): el día del pago la pregunta es "¿dejo de recibir esto?".
    // Sólo en trial (evita el query en cuentas ya pagas). Aditivo: nullable.
    let trialFin: Date | null = null
    let trialValor: { pedidos: number; monto: number } | null = null
    // Pausado (Tarea 8): el mismo número, pero para el local suspendido/cancelado — "tenés $Y en
    // pedidos esperando reactivarse". Es el "números visibles" de la pantalla de reactivación por pago.
    let valorPausa: { pedidos: number; monto: number } | null = null
    const desde = vigente?.fechaInicio ?? null
    if (vigente?.estado === 'trial') {
      trialFin = vigente.trialFin ?? null
      if (desde) trialValor = await contarValorPiru(desde)
    } else if (
      desde &&
      (vigente?.estado === 'suspendida' || vigente?.estado === 'cancelada')
    ) {
      valorPausa = await contarValorPiru(desde)
    }

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
          // Fin del trial + valor generado (para el contador de valor del panel, Tarea 6).
          trialFin,
          trialValor,
          // Valor acumulado para la pantalla de reactivación de un local pausado (Tarea 8).
          valorPausa,
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
    const monto = montoPorCiclo(precioMensual, ciclo, planRow.descuentoAnual)

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

    const backUrl = `${ADMIN_URL}/dashboard/ajustes/plan?plan=success`

    // 2. Preferencia de Checkout Pro con el token de plataforma (sin marketplace_fee).
    const pref = await crearPreferenciaSuscripcionMP({
      pagoId,
      titulo: `Piru ${planRow.nombre} · ${ciclo === 'anual' ? 'Anual' : 'Mensual'}`,
      precio: monto,
      backUrl,
    })
    if (!pref.ok) {
      return c.json({ message: 'Error al iniciar el pago', success: false }, 502)
    }

    await setPagoSuscripcionPreferencia(db, pagoId, pref.preferenceId)

    return c.json({
      success: true,
      data: {
        pagoId,
        url_pago: pref.initPoint,
        preference_id: pref.preferenceId,
        monto: monto.toFixed(2),
        ciclo,
      },
    }, 200)
  } catch (error) {
    console.error('Error en checkout de suscripción:', error)
    return c.json({ message: 'Error al iniciar el pago del plan', success: false }, 500)
  }
})

/**
 * Envía al WhatsApp del DUEÑO el link para pagar la cuota del plan desde el celular (misma idea
 * que la recarga por link). Crea el pago pendiente CON token y manda la plantilla utility
 * `pago_link_v1` desde el número de Piru, con el botón apuntando a `/pago/:token` (no a MP directo).
 * El precio SIEMPRE sale del plan en la DB. La suscripción se activa recién en el webhook al pagarse.
 */
planesRoute.post('/pago-link-whatsapp', zValidator('json', suscribirSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { planId, ciclo: cicloInput } = c.req.valid('json')
  const ciclo: CicloPago = cicloInput === 'anual' ? 'anual' : 'mensual'

  if (!MP_PLATFORM_ACCESS_TOKEN) {
    console.error('❌ [Pago link plan WhatsApp] Falta MP_ACCESS_TOKEN para cobrar la cuota')
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
    const monto = montoPorCiclo(precioMensual, ciclo, planRow.descuentoAnual)
    if (monto <= 0) {
      return c.json({ message: 'Este plan no requiere pago', success: false }, 400)
    }

    const [rest] = await db
      .select({ telefono: RestauranteTable.telefono })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)

    const telefono = (rest?.telefono || '').replace(/\D/g, '')
    if (!telefono || telefono.length < 8) {
      return c.json({
        message: 'No tenés un número de WhatsApp verificado en tu cuenta para recibir el link.',
        success: false,
      }, 400)
    }

    const token = randomUUID()
    const tokenExpiraEn = new Date(Date.now() + PAGO_LINK_TTL_MIN * 60 * 1000)
    await crearPagoSuscripcionPendiente(db, restauranteId, { planId, ciclo, monto, token, tokenExpiraEn })

    const concepto = `Plan ${planRow.nombre} · ${ciclo === 'anual' ? 'Anual' : 'Mensual'}`
    const montoFmt = new Intl.NumberFormat('es-AR', {
      style: 'currency', currency: 'ARS', maximumFractionDigits: 0,
    }).format(monto)

    const envio = await sendPaymentLinkWhatsApp(c, { phone: telefono, concepto, monto: montoFmt, token })
    if (!envio.success) {
      return c.json({ message: 'No se pudo enviar el link por WhatsApp. Probá de nuevo.', success: false }, 502)
    }

    const telefonoMask = telefono.length > 4 ? `••••${telefono.slice(-4)}` : telefono
    return c.json({ success: true, data: { enviado: true, telefono: telefonoMask } }, 200)
  } catch (error) {
    console.error('Error enviando link de pago del plan por WhatsApp:', error)
    return c.json({ message: 'Error al enviar el link de pago', success: false }, 500)
  }
})

/**
 * DEBUG TEMPORAL. Envía un link de $10 que renueva exactamente el plan y ciclo actuales.
 * Conserva el mismo comprobante y webhook que un pago normal, por lo que la acreditación
 * es idéntica. Eliminar junto con el botón de Mi Plan al finalizar las pruebas.
 */
planesRoute.post('/debug/pago-link-whatsapp', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  if (!MP_PLATFORM_ACCESS_TOKEN) {
    return c.json({ message: 'Pagos no disponibles temporalmente', success: false }, 503)
  }

  try {
    const suscripcion = await resolverSuscripcion(db, restauranteId)
    if (!suscripcion.planId || suscripcion.sinSuscripcion) {
      return c.json({ message: 'No tenés un plan actual para renovar', success: false }, 400)
    }

    const [subRow] = await db
      .select({ ciclo: SuscripcionTable.ciclo })
      .from(SuscripcionTable)
      .where(eq(SuscripcionTable.restauranteId, restauranteId))
      .limit(1)
    const ciclo: CicloPago = subRow?.ciclo === 'anual' ? 'anual' : 'mensual'

    const [rest] = await db
      .select({ telefono: RestauranteTable.telefono })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)
    const telefono = (rest?.telefono || '').replace(/\D/g, '')
    if (!telefono || telefono.length < 8) {
      return c.json({ message: 'No tenés un número de WhatsApp verificado en tu cuenta para recibir el link.', success: false }, 400)
    }

    const token = randomUUID()
    const tokenExpiraEn = new Date(Date.now() + PAGO_LINK_TTL_MIN * 60 * 1000)
    await crearPagoSuscripcionPendiente(db, restauranteId, {
      planId: suscripcion.planId,
      ciclo,
      monto: 10,
      token,
      tokenExpiraEn,
    })

    const envio = await sendPaymentLinkWhatsApp(c, {
      phone: telefono,
      concepto: `DEBUG · Renovación ${suscripcion.planNombre ?? 'del plan'} (${ciclo})`,
      monto: '$10',
      token,
    })
    if (!envio.success) return c.json({ message: 'No se pudo enviar el link por WhatsApp. Probá de nuevo.', success: false }, 502)

    const telefonoMask = telefono.length > 4 ? `••••${telefono.slice(-4)}` : telefono
    return c.json({ success: true, data: { enviado: true, telefono: telefonoMask } }, 200)
  } catch (error) {
    console.error('Error enviando link DEBUG de renovación:', error)
    return c.json({ message: 'Error al enviar el link de pago de prueba', success: false }, 500)
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
