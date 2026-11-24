import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { restaurante as RestauranteTable } from '../db/schema'
import { authMiddleware } from '../middleware/auth'
import { ESTADOS_SUSCRIPCION_CON_ACCESO } from '../lib/modulos'
import { calcularPasos, leerDatosPasos, resumenPasos } from '../lib/primeros-pasos'
import { RUBROS } from '../lib/productos-ejemplo'
import { configurarTiendaInicial, contarProductosEjemplo } from '../lib/productos-ejemplo-db'
import {
  esPlanPago,
  PLAN_CODIGOS,
  PLAN_GRATIS,
  PLAN_LEGADO,
  resolverPlanRestaurante,
} from '../lib/planes-tienda'
import { cancelarSuscripcion, reactivarSuscripcionProgramada, resolverEstadoVigente, setPagoSuscripcionPreferencia } from '../lib/suscripciones'
import { crearFacturaSuscripcionPendiente } from '../lib/facturacion-suscripcion'
import { crearPreferenciaSuscripcionMP, pagosSuscripcionDisponibles } from '../lib/mp-suscripcion'

const ADMIN_URL = (process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')

const db = () => drizzle(pool)

async function estadoDelLocal(restauranteId: number) {
  const sub = await resolverEstadoVigente(db(), restauranteId)
  const conAcceso = !!sub && (ESTADOS_SUSCRIPCION_CON_ACCESO as readonly string[]).includes(sub.estado)
  const plan = await resolverPlanRestaurante(db(), restauranteId, conAcceso)
  return { sub, plan }
}

/**
 * Planes de tienda del panel (`/api/planes-tienda`). Los precios salen de `plan_tienda`; el cobro
 * reusa la factura de suscripción y su webhook (sólo el pago aprobado cambia el plan). Evolución
 * —los locales de siempre— no cambia de plan desde acá: conserva su suscripción.
 */
export const planesTiendaRoute = new Hono()
  .use('*', authMiddleware)

  .get('/', async (c) => {
    const restauranteId = (c as any).user.id as number
    try {
      const { sub, plan } = await estadoDelLocal(restauranteId)
      return c.json({
        success: true,
        data: {
          contratado: plan.contratado,
          efectivo: plan.efectivo,
          esLegado: plan.esLegado,
          catalogo: plan.catalogo,
          suscripcion: sub
            ? {
                estado: sub.estado,
                ciclo: sub.ciclo,
                fechaProximoCobro: sub.fechaProximoCobro,
                fechaCancelacion: sub.fechaCancelacion,
                cancelacionProgramada: Boolean(sub.fechaCancelacion),
              }
            : null,
          pagosDisponibles: pagosSuscripcionDisponibles(),
        },
      })
    } catch (error) {
      console.error('[planes-tienda] Error leyendo el plan:', error)
      return c.json({ success: false, message: 'No se pudo leer tu plan' }, 500)
    }
  })

  /** Checklist de la tab "Primeros pasos" (sólo la ven los locales con plan, no Evolución). */
  .get('/primeros-pasos', async (c) => {
    const restauranteId = (c as any).user.id as number
    try {
      const { plan } = await estadoDelLocal(restauranteId)
      const [datos, [local], productosEjemplo] = await Promise.all([
        leerDatosPasos(db() as any, restauranteId),
        db().select({ rubro: RestauranteTable.rubro }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1),
        contarProductosEjemplo(db() as any, restauranteId),
      ])
      if (!datos || !local) return c.json({ success: false, message: 'Local no encontrado' }, 404)
      const pasos = calcularPasos(datos)
      return c.json({
        success: true,
        data: {
          visible: !plan.esLegado,
          pasos,
          ...resumenPasos(pasos),
          // Sin rubro, el dueño todavía no respondió las preguntas iniciales (`/configurar-tienda`).
          configurada: local.rubro != null,
          productosEjemplo,
        },
      })
    } catch (error) {
      console.error('[planes-tienda] Error calculando primeros pasos:', error)
      return c.json({ success: false, message: 'No se pudieron calcular los pasos' }, 500)
    }
  })

  /**
   * Preguntas iniciales de la tienda self-serve (rubro y formas de entrega). Guarda las respuestas y,
   * con la carta vacía, la arranca con productos de ejemplo del rubro (`lib/productos-ejemplo.ts`).
   */
  .post(
    '/configuracion-inicial',
    zValidator(
      'json',
      z
        .object({ rubro: z.enum(RUBROS), delivery: z.boolean(), takeaway: z.boolean() })
        .refine((d) => d.delivery || d.takeaway, { message: 'Elegí al menos una forma de entrega' }),
    ),
    async (c) => {
      const restauranteId = (c as any).user.id as number
      if ((c as any).user.demo) return c.json({ success: false, code: 'demo_sin_permiso', message: 'En la demo no se configura la tienda' }, 403)
      try {
        const { plan } = await estadoDelLocal(restauranteId)
        if (plan.esLegado) return c.json({ success: false, code: 'plan_legado', message: 'Tu tienda ya está configurada.' }, 409)
        const data = await configurarTiendaInicial(db() as any, restauranteId, c.req.valid('json'))
        return c.json({ success: true, data })
      } catch (error) {
        console.error('[planes-tienda] Error en la configuración inicial:', error)
        return c.json({ success: false, message: 'No se pudo configurar la tienda' }, 500)
      }
    },
  )

  /**
   * Elegir un plan. Pago: crea la factura y devuelve el link de Mercado Pago (el plan cambia recién
   * con el webhook aprobado). Inicial: programa la baja del plan pago al fin del período ya pagado
   * (después el local opera en Inicial solo, sin cortar la tienda). Evolución: se habla con ventas.
   */
  .post(
    '/elegir',
    zValidator('json', z.object({ codigo: z.enum(PLAN_CODIGOS), ciclo: z.enum(['mensual', 'anual']).optional() })),
    async (c) => {
      const restauranteId = (c as any).user.id as number
      if ((c as any).user.demo) return c.json({ success: false, code: 'demo_sin_permiso', message: 'En la demo no se cambia el plan' }, 403)
      const { codigo, ciclo: cicloInput } = c.req.valid('json')
      const ciclo = cicloInput === 'anual' ? 'anual' : 'mensual'
      try {
        const { sub, plan } = await estadoDelLocal(restauranteId)
        if (plan.esLegado) {
          return c.json({ success: false, code: 'plan_legado', message: 'Tu cuenta tiene el plan Evolución con tu suscripción de siempre.' }, 409)
        }
        if (codigo === PLAN_LEGADO) {
          return c.json({ success: false, code: 'a_medida', message: 'El plan Evolución se arma a medida: escribinos y lo vemos juntos.' }, 409)
        }

        const destino = plan.catalogo.find((p) => p.codigo === codigo)
        if (!destino) return c.json({ success: false, message: 'Plan no disponible' }, 404)

        if (codigo === PLAN_GRATIS) {
          if (!sub || !['activa', 'pago_pendiente', 'trial'].includes(sub.estado)) {
            return c.json({ success: true, data: { cambio: 'inmediato', plan: PLAN_GRATIS } })
          }
          await cancelarSuscripcion(db(), restauranteId)
          const vigente = await resolverEstadoVigente(db(), restauranteId)
          return c.json({ success: true, data: { cambio: 'al_fin_del_periodo', plan: PLAN_GRATIS, hasta: vigente?.fechaProximoCobro ?? null } })
        }

        if (!esPlanPago(destino)) return c.json({ success: false, message: 'Plan no disponible' }, 404)

        // Seguir con el mismo plan pago que tenía la baja programada: se deshace la baja, sin cobrar.
        if (codigo === plan.contratado && codigo === plan.efectivo && sub?.fechaCancelacion) {
          await reactivarSuscripcionProgramada(db(), restauranteId)
          return c.json({ success: true, data: { cambio: 'baja_cancelada', plan: codigo } })
        }
        if (codigo === plan.efectivo && sub?.estado === 'activa' && !sub.fechaCancelacion) {
          return c.json({ success: false, code: 'plan_actual', message: 'Ya estás en este plan.' }, 409)
        }

        if (!pagosSuscripcionDisponibles()) return c.json({ success: false, message: 'Pagos no disponibles temporalmente' }, 503)
        const factura = await crearFacturaSuscripcionPendiente(db(), restauranteId, { ciclo, planTiendaCodigo: codigo })
        const pref = await crearPreferenciaSuscripcionMP({
          pagoId: factura.pagoId,
          titulo: `Piru · Plan ${destino.nombre} · ${ciclo === 'anual' ? 'Anual' : 'Mensual'}`,
          precio: factura.montoTotal,
          backUrl: `${ADMIN_URL}/dashboard/planes?checkout=success&plan=${codigo}`,
        })
        if (!pref.ok) return c.json({ success: false, message: 'Error al iniciar el pago' }, 502)
        await setPagoSuscripcionPreferencia(db(), factura.pagoId, pref.preferenceId)
        return c.json({
          success: true,
          data: { cambio: 'pago', url_pago: pref.initPoint, pagoId: factura.pagoId, monto: factura.montoTotal.toFixed(2), ciclo },
        })
      } catch (error) {
        console.error('[planes-tienda] Error eligiendo plan:', error)
        const message = error instanceof Error ? error.message : 'No se pudo cambiar el plan'
        return c.json({ success: false, message }, 400)
      }
    },
  )
