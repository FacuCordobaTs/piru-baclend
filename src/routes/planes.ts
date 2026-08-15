import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { eq, and, gte, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth'
import {
  restaurante as RestauranteTable,
  pedidoUnificado as PedidoUnificadoTable,
} from '../db/schema'
import { resolverSuscripcion } from '../lib/planes'
import {
  catalogoSuscripcionUnica,
  resolverSuscripcionUnica,
  tieneAccesoAlPanelSuscripcion,
} from '../lib/suscripcion'
import { resumenWallet } from '../lib/mensajes-wallet'
import {
  setPagoSuscripcionPreferencia,
  cancelarSuscripcion,
  reactivarSuscripcionProgramada,
  resolverEstadoVigente,
  listarPagosSuscripcion,
  type CicloPago,
} from '../lib/suscripciones'
import { crearPreferenciaSuscripcionMP } from '../lib/mp-suscripcion'
import { sendPaymentLinkWhatsApp } from '../services/whatsapp'
import { crearFacturaSuscripcionPendiente } from '../lib/facturacion-suscripcion'

/** Minutos de validez del link de pago (enviado por WhatsApp) antes de vencer. */
const PAGO_LINK_TTL_MIN = 60

// Los pagos de la cuota del plan van a la cuenta de la PLATAFORMA (Piru), con el
// token de plataforma y sin marketplace_fee (100% a Piru). Checkout Pro, pago único.
const MP_PLATFORM_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
const ADMIN_URL = (process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')

const planesRoute = new Hono()

planesRoute.use('*', authMiddleware)

/** Alias compatible: ya no hay tres planes, sólo la suscripción base de Piru. */
planesRoute.get('/catalogo', async (c) => {
  const db = drizzle(pool)

  try {
    return c.json({ success: true, data: await catalogoSuscripcionUnica(db) }, 200)
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
    const [suscripcion, suscripcionLegacy] = await Promise.all([
      resolverSuscripcionUnica(db, restauranteId),
      // Sólo rellena aliases de admins instalados hasta T43. Los módulos no se
      // derivan de este set: T22/T23 migrarán cada gate a requireModulo.
      resolverSuscripcion(db, restauranteId),
    ])
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
          accesoPanel: tieneAccesoAlPanelSuscripcion(requiereSuscripcion, suscripcion),
          // Fechas de facturación (para mostrar próximo cobro / gracia en la UI).
          fechaProximoCobro: suscripcion.fechaProximoCobro ?? vigente?.fechaProximoCobro ?? null,
          // Fin del trial + valor generado (para el contador de valor del panel, Tarea 6).
          trialFin,
          trialValor,
          // Valor acumulado para la pantalla de reactivación de un local pausado (Tarea 8).
          valorPausa,
          graciaHasta: suscripcion.graciaHasta ?? vigente?.graciaHasta ?? null,
          fechaCancelacion: suscripcion.fechaCancelacion ?? vigente?.fechaCancelacion ?? null,
          // Alias legacy: antes representaba el precio del plan. Ahora la
          // base vive en `suscripcionBase`; T07 sumará módulos facturables.
          precioMensual: suscripcion.precioBaseMensual ?? vigente?.precioMensual ?? null,
          ciclo: suscripcion.ciclo ?? vigente?.ciclo ?? null,
          // Lista de features de pago habilitadas ahora; la UI candadea el resto.
          features: Array.from(suscripcionLegacy.features),
          // Contrato nuevo, aditivo. No se quitan campos `plan*` hasta T43.
          suscripcionBase: suscripcion.configuracion,
          suscripcionId: suscripcion.suscripcionId,
          precioBaseMensual: suscripcion.precioBaseMensual,
          montoModulosMensual: suscripcion.montoModulosMensual,
          montoTotalMensual: suscripcion.montoTotalMensual,
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
  // planId se acepta temporalmente para admins instalados, pero se ignora: la
  // configuración única y los módulos se resuelven exclusivamente en servidor.
  planId: z.number().int().positive().optional(),
  ciclo: z.enum(['mensual', 'anual']).optional(),
})

const iniciarCheckoutSuscripcion = async (c: any) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { ciclo: cicloInput } = c.req.valid('json')
  const ciclo: CicloPago = cicloInput === 'anual' ? 'anual' : 'mensual'

  if (!MP_PLATFORM_ACCESS_TOKEN) {
    console.error('❌ [Suscripción] Falta MP_ACCESS_TOKEN para cobrar la cuota del plan')
    return c.json({ message: 'Pagos no disponibles temporalmente', success: false }, 503)
  }

  try {
    const factura = await crearFacturaSuscripcionPendiente(db, restauranteId, { ciclo })

    // Al volver de la primera activación mostramos el catálogo de módulos como
    // siguiente paso informativo; no se activa ningún módulo por esta redirección.
    const backUrl = `${ADMIN_URL}/dashboard/modulos?checkout=success&origen=suscripcion`

    // 2. Preferencia de Checkout Pro con el token de plataforma (sin marketplace_fee).
    const pref = await crearPreferenciaSuscripcionMP({
      pagoId: factura.pagoId,
      titulo: `Piru Suscripción · ${ciclo === 'anual' ? 'Anual' : 'Mensual'}`,
      precio: factura.montoTotal,
      backUrl,
    })
    if (!pref.ok) {
      return c.json({ message: 'Error al iniciar el pago', success: false }, 502)
    }

    await setPagoSuscripcionPreferencia(db, factura.pagoId, pref.preferenceId)

    return c.json({
      success: true,
      data: {
        pagoId: factura.pagoId,
        url_pago: pref.initPoint,
        preference_id: pref.preferenceId,
        monto: factura.montoTotal.toFixed(2),
        montoBase: factura.montoBase.toFixed(2),
        montoModulos: factura.montoModulos.toFixed(2),
        items: factura.items,
        ciclo,
      },
    }, 200)
  } catch (error) {
    console.error('Error en checkout de suscripción:', error)
    return c.json({ message: 'Error al iniciar el pago del plan', success: false }, 500)
  }
}

// Alias instalado + nombre canónico del contrato nuevo.
planesRoute.post('/suscribir', zValidator('json', suscribirSchema), iniciarCheckoutSuscripcion)
planesRoute.post('/checkout', zValidator('json', suscribirSchema), iniciarCheckoutSuscripcion)

/**
 * Envía al WhatsApp del DUEÑO el link para pagar la cuota del plan desde el celular (misma idea
 * que la recarga por link). Crea el pago pendiente CON token y manda la plantilla utility
 * `pago_link_v1` desde el número de Piru, con el botón apuntando a `/pago/:token` (no a MP directo).
 * El precio SIEMPRE sale del plan en la DB. La suscripción se activa recién en el webhook al pagarse.
 */
planesRoute.post('/pago-link-whatsapp', zValidator('json', suscribirSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { ciclo: cicloInput } = c.req.valid('json')
  const ciclo: CicloPago = cicloInput === 'anual' ? 'anual' : 'mensual'

  if (!MP_PLATFORM_ACCESS_TOKEN) {
    console.error('❌ [Pago link plan WhatsApp] Falta MP_ACCESS_TOKEN para cobrar la cuota')
    return c.json({ message: 'Pagos no disponibles temporalmente', success: false }, 503)
  }

  try {
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
    const factura = await crearFacturaSuscripcionPendiente(db, restauranteId, { ciclo, token, tokenExpiraEn })

    const nombresModulos = factura.items.filter((item) => item.tipo === 'modulo').map((item) => item.descripcion)
    const concepto = `${factura.items.find((item) => item.tipo === 'base')?.descripcion ?? 'Suscripción Piru'}${nombresModulos.length ? ` + ${nombresModulos.join(', ')}` : ''} · ${ciclo === 'anual' ? 'Anual' : 'Mensual'}`
    const montoFmt = new Intl.NumberFormat('es-AR', {
      style: 'currency', currency: 'ARS', maximumFractionDigits: 0,
    }).format(factura.montoTotal)

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

/** Revierte una baja programada; una suscripción ya vencida se reactiva con checkout. */
planesRoute.post('/reactivar', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  try {
    const ok = await reactivarSuscripcionProgramada(db, restauranteId)
    if (!ok) return c.json({ message: 'La suscripción ya no tiene una baja programada vigente', success: false }, 409)
    return c.json({ success: true, message: 'La suscripción continuará al finalizar el período actual' }, 200)
  } catch (error) {
    console.error('Error reactivando suscripción:', error)
    return c.json({ message: 'Error al reactivar la suscripción', success: false }, 500)
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

// Nombre canónico desde T05. `planesRoute` queda exportado como alias de código
// para evitar una migración masiva de imports durante la compatibilidad.
const suscripcionRoute = planesRoute

export { suscripcionRoute, planesRoute }
