import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { asc, eq } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import * as jwt from 'jsonwebtoken'
import { restaurante as RestauranteTable, plan as PlanTable } from '../db/schema'
import { internoAuthMiddleware } from '../middleware/interno'
import { resolverSuscripcion } from '../lib/planes'
import { resumenWallet } from '../lib/mensajes-wallet'
import {
  resolverEstadoVigente,
  asignarPlanManual,
  type CicloPago,
} from '../lib/suscripciones'

// Panel interno del fundador. Auth por credencial fija en env (sin tabla de usuarios):
// POST /interno/login compara contra INTERNO_PASSWORD y emite un JWT propio firmado con
// INTERNO_JWT_SECRET (scope 'interno', ~12 h). El resto de las rutas exige ese token.
const INTERNO_TOKEN_TTL = '12h'

const internoRoute = new Hono()

/** Login: password fija → JWT de scope 'interno'. Fuera del middleware (es la puerta). */
const loginSchema = z.object({ password: z.string().min(1) })

internoRoute.post('/login', zValidator('json', loginSchema), async (c) => {
  const { password } = c.req.valid('json')
  const esperada = process.env.INTERNO_PASSWORD
  const secret = process.env.INTERNO_JWT_SECRET

  if (!esperada || !secret) {
    console.error('❌ [Interno] Falta INTERNO_PASSWORD o INTERNO_JWT_SECRET en el env')
    return c.json({ success: false, message: 'Panel interno no configurado' }, 503)
  }

  if (password !== esperada) {
    return c.json({ success: false, message: 'Contraseña incorrecta' }, 401)
  }

  const token = jwt.sign({ scope: 'interno' }, secret, { expiresIn: INTERNO_TOKEN_TTL })
  return c.json({ success: true, data: { token } }, 200)
})

// A partir de acá, todo exige el token interno.
internoRoute.use('*', internoAuthMiddleware)

/**
 * Lista de restaurantes con su plan, estado de suscripción, próximo cobro y consumo de
 * mensajes. Reusa resolverSuscripcion + resumenWallet y corre resolverEstadoVigente
 * antes de leer (para reflejar vencimientos sin cron). Es lo que permite cerrar clientes
 * por outreach antes de tener el billing 100% automatizado.
 */
internoRoute.get('/locales', async (c) => {
  const db = drizzle(pool)
  try {
    const restaurantes = await db
      .select({
        id: RestauranteTable.id,
        nombre: RestauranteTable.nombre,
        email: RestauranteTable.email,
        telefono: RestauranteTable.telefono,
      })
      .from(RestauranteTable)
      .orderBy(asc(RestauranteTable.id))

    const data = await Promise.all(
      restaurantes.map(async (r) => {
        // Transición lazy de estado antes de leer (vencido → gracia → suspendida).
        await resolverEstadoVigente(db, r.id)
        const sus = await resolverSuscripcion(db, r.id)
        const wallet = await resumenWallet(db, r.id)
        return {
          id: r.id,
          nombre: r.nombre,
          email: r.email,
          telefono: r.telefono,
          planId: sus.planId,
          planCodigo: sus.planCodigo,
          planNombre: sus.planNombre,
          estado: sus.estado,
          sinSuscripcion: sus.sinSuscripcion,
          mensajes: {
            ilimitado: wallet.ilimitado,
            disponible: wallet.utility.disponible,
            cupoPlan: wallet.utility.cupoPlan,
            pctConsumido: wallet.utility.pctConsumido,
          },
        }
      }),
    )

    return c.json({ success: true, data }, 200)
  } catch (error) {
    console.error('Error listando locales (interno):', error)
    return c.json({ success: false, message: 'Error al obtener los locales' }, 500)
  }
})

/** Catálogo de planes (para poblar el select de cambio de plan en el panel). */
internoRoute.get('/planes', async (c) => {
  const db = drizzle(pool)
  try {
    const planes = await db
      .select()
      .from(PlanTable)
      .where(eq(PlanTable.activo, true))
      .orderBy(asc(PlanTable.orden))
    return c.json({ success: true, data: planes }, 200)
  } catch (error) {
    console.error('Error listando planes (interno):', error)
    return c.json({ success: false, message: 'Error al obtener los planes' }, 500)
  }
})

/**
 * Alta/cambio de plan a mano, SIN pasar por MercadoPago (el punto de la tarea: dar de
 * alta por outreach). Upsert de la suscripción → activa, extiende el próximo cobro y
 * acredita el cupo utility del plan.
 */
const cambiarPlanSchema = z.object({
  planId: z.number().int().positive(),
  ciclo: z.enum(['mensual', 'anual']).optional(),
})

internoRoute.put(
  '/locales/:id/plan',
  zValidator('json', cambiarPlanSchema),
  async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number(c.req.param('id'))
    if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
      return c.json({ success: false, message: 'Local inválido' }, 400)
    }

    const { planId, ciclo: cicloInput } = c.req.valid('json')
    const ciclo: CicloPago = cicloInput === 'anual' ? 'anual' : 'mensual'

    try {
      const [rest] = await db
        .select({ id: RestauranteTable.id })
        .from(RestauranteTable)
        .where(eq(RestauranteTable.id, restauranteId))
        .limit(1)
      if (!rest) {
        return c.json({ success: false, message: 'Local no encontrado' }, 404)
      }

      const res = await asignarPlanManual(db, restauranteId, planId, ciclo)
      if (!res) {
        return c.json({ success: false, message: 'Plan no encontrado' }, 404)
      }

      return c.json({
        success: true,
        data: { planId: res.planId, fechaProximoCobro: res.periodoHasta },
      }, 200)
    } catch (error) {
      console.error('Error cambiando plan (interno):', error)
      return c.json({ success: false, message: 'Error al cambiar el plan' }, 500)
    }
  },
)

export { internoRoute }
