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
import { marketerPuede } from '../lib/marketer-permisos'

export interface AuthenticatedContext extends Context {
  user: {
    id: number
    marketerId?: number
    email?: string | null
    nombre?: string | null
    splitPayment?: boolean
    itemTracking?: boolean
    rapiboyToken?: string
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

    let decoded: { id: number; scope?: string; marketerId?: number }
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
    }
    const restauranteResult = await db
      .select({
        id: RestauranteTable.id,
        email: RestauranteTable.email,
        nombre: RestauranteTable.nombre,
        rapiboyToken:
          decoded.marketerId === undefined
            ? RestauranteTable.rapiboyToken
            : sql<null>`NULL`,
      })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, decoded.id))
      .limit(1)

    if (!restauranteResult.length) {
      return c.json({ error: 'Restaurante no encontrado' }, 401)
    }

    const restaurante = restauranteResult[0]

    ;(c as AuthenticatedContext).user = {
      id: restaurante.id,
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
