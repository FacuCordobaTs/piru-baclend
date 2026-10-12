import { Context, Next } from 'hono'
import * as jwt from 'jsonwebtoken'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import {
  restaurante as RestauranteTable,
  restauranteMarketer,
  marketer,
  marketerAccion,
} from '../db/schema'
import { and, eq, sql } from 'drizzle-orm'
import {
  duenioAppMarketingPuede,
  marketerPuede,
} from '../lib/marketer-permisos'
import {
  demoBloqueaEnAppMarketing,
  demoPuede,
  esProspectoSinReclamar,
  ocultarSecretos,
} from '../lib/demo-panel'

export interface AuthenticatedContext extends Context {
  user: {
    id: number
    marketerId?: number
    email?: string | null
    nombre?: string | null
    splitPayment?: boolean
    itemTracking?: boolean
    rapiboyToken?: string
    altaInterna?: boolean
    accesoTemporalInterno?: boolean
    /** Sesión de la demo de prospección: ver lib/demo-panel.ts. */
    demo?: boolean
  }
}

export const createAuthMiddleware =
  (getDb = () => drizzle(pool)) =>
  async (c: Context, next: Next) => {
    // For React Native apps, we only use Authorization header
    const authHeader = c.req.header('Authorization')

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Authorization header required' }, 401)
    }

    const token = authHeader.substring(7) // Remove 'Bearer ' prefix

    let decoded: {
      id: number
      scope?: string
      marketerId?: number
      appMarketing?: unknown
      demo?: unknown
      altaInterna?: boolean
      accesoTemporalInterno?: boolean
    }
    try {
      decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'fallback-secret',
      ) as typeof decoded
    } catch {
      return c.json({ error: 'Token inválido' }, 401)
    }

    if (
      decoded.scope === 'marketer' ||
      !Number.isInteger(decoded.id) ||
      decoded.id <= 0
    ) {
      return c.json({ error: 'Token de local requerido' }, 401)
    }

    const db = getDb()
    // Sesión de la demo de prospección (/demo-panel/sesion): la pide cualquiera que abra el link de
    // la tienda demo, así que nunca es la del dueño. Sólo vale mientras la tienda no tenga dueño
    // (se vuelve a verificar abajo) y se limita a una lista cerrada de operaciones.
    if (
      decoded.demo !== undefined &&
      (decoded.demo !== true ||
        decoded.scope !== 'restaurante' ||
        decoded.marketerId !== undefined ||
        decoded.altaInterna === true ||
        decoded.accesoTemporalInterno === true)
    )
      return c.json({ error: 'Token inválido' }, 401)
    if (decoded.marketerId !== undefined) {
      if (
        decoded.scope !== 'restaurante' ||
        !Number.isInteger(decoded.marketerId) ||
        decoded.marketerId <= 0
      )
        return c.json({ error: 'Token inválido' }, 401)
      const [vinculo] = await db
        .select({ id: restauranteMarketer.id })
        .from(restauranteMarketer)
        .innerJoin(marketer, eq(marketer.id, restauranteMarketer.marketerId))
        .where(
          and(
            eq(restauranteMarketer.restauranteId, decoded.id),
            eq(restauranteMarketer.marketerId, decoded.marketerId),
            eq(restauranteMarketer.estado, 'activo'),
            eq(marketer.activo, true),
          ),
        )
        .limit(1)
      if (!vinculo)
        return c.json(
          {
            error: 'El local te quitó el acceso',
            code: 'acceso_marketer_revocado',
          },
          401,
        )
      if (!marketerPuede(c.req.method, c.req.path))
        return c.json(
          {
            error: 'Esto lo maneja el dueño del local',
            code: 'marketer_sin_permiso',
          },
          403,
        )
    } else if (decoded.appMarketing !== undefined) {
      // Sesión del dueño en la app de marketers (/marketing-duenio/sesion): es su local, pero
      // sólo alcanza lo que esa app usa. Lo demás se sigue manejando desde el panel.
      if (decoded.appMarketing !== true || decoded.scope !== 'restaurante')
        return c.json({ error: 'Token inválido' }, 401)
      if (!duenioAppMarketingPuede(c.req.method, c.req.path))
        return c.json(
          {
            error: 'Esto se maneja desde tu panel de Piru',
            code: 'app_marketing_sin_permiso',
          },
          403,
        )
      if (
        decoded.demo === true &&
        demoBloqueaEnAppMarketing(c.req.method, c.req.path)
      )
        return c.json(
          {
            error: 'Esto no está disponible en la demo',
            code: 'demo_sin_permiso',
          },
          403,
        )
    } else if (decoded.demo === true) {
      if (!demoPuede(c.req.method, c.req.path))
        return c.json(
          {
            error:
              'Esto no está disponible en la demo. Cuando tengas tu cuenta lo manejás desde acá.',
            code: 'demo_sin_permiso',
          },
          403,
        )
    }
    const demo = decoded.demo === true
    const restringido =
      decoded.marketerId !== undefined ||
      decoded.appMarketing !== undefined ||
      demo
    const restauranteResult = await db
      .select({
        id: RestauranteTable.id,
        email: RestauranteTable.email,
        nombre: RestauranteTable.nombre,
        origen: RestauranteTable.origen,
        claimedAt: RestauranteTable.claimedAt,
        telefonoVerificado: RestauranteTable.telefonoVerificado,
        rapiboyToken: restringido
          ? sql<null>`NULL`
          : RestauranteTable.rapiboyToken,
      })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, decoded.id))
      .limit(1)

    if (!restauranteResult.length) {
      return c.json({ error: 'Restaurante no encontrado' }, 401)
    }

    const restaurante = restauranteResult[0]

    // La demo termina cuando el dueño reclama la tienda: las sesiones que quedaron abiertas dejan de servir.
    if (demo && !esProspectoSinReclamar(restaurante))
      return c.json(
        {
          error: 'La demo terminó: esta tienda ya tiene dueño. Entrá con tu cuenta.',
          code: 'demo_vencida',
        },
        401,
      )

    ;(c as AuthenticatedContext).user = {
      id: restaurante.id,
      altaInterna: decoded.altaInterna === true,
      accesoTemporalInterno: decoded.accesoTemporalInterno === true,
      ...(demo ? { demo: true } : {}),
      ...(decoded.marketerId === undefined
        ? {}
        : { marketerId: decoded.marketerId }),
      email: restaurante.email,
      nombre: restaurante.nombre,
      rapiboyToken: restaurante.rapiboyToken
        ? restaurante.rapiboyToken
        : undefined,
    }

    await next()
    if (demo && (c.res.headers.get('content-type') ?? '').includes('application/json')) {
      // La demo nunca recibe credenciales: `/restaurante/profile` y `/sucursales/list` devuelven la
      // fila completa. Se limpia acá, en un solo lugar, y no en cada handler.
      try {
        const limpio = ocultarSecretos(await c.res.clone().json())
        const headers = new Headers(c.res.headers)
        headers.delete('content-length')
        c.res = new Response(JSON.stringify(limpio), {
          status: c.res.status,
          headers,
        })
      } catch {
        // Sin cuerpo JSON legible no hay nada que limpiar.
      }
    }
    if (
      decoded.marketerId !== undefined &&
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)
    ) {
      void db
        .insert(marketerAccion)
        .values({
          marketerId: decoded.marketerId,
          restauranteId: decoded.id,
          metodo: c.req.method,
          ruta: c.req.path.slice(0, 255),
          status: c.res.status,
          createdAt: new Date(),
        })
        .then(
          () => {},
          () => console.error('[marketer] No se pudo registrar la acción'),
        )
    }
  }
export const authMiddleware = createAuthMiddleware()
