import { Context, Next } from 'hono'
import * as jwt from 'jsonwebtoken'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { restaurante as RestauranteTable } from '../db/schema'
import { eq } from 'drizzle-orm'

export interface AuthenticatedContext extends Context {
  user: {
    id: number
    email: string
    nombre?: string
    splitPayment?: boolean
    itemTracking?: boolean
  }
}

export const authMiddleware = async (c: Context, next: Next) => {
  // For React Native apps, we only use Authorization header
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization header required' }, 401)
  }

  const token = authHeader.substring(7) // Remove 'Bearer ' prefix

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret') as { id: number }

    const db = drizzle(pool)
    const restauranteResult = await db.select().from(RestauranteTable).where(eq(RestauranteTable.id, decoded.id)).limit(1)

    if (!restauranteResult.length) {
      return c.json({ error: 'Restaurante no encontrado' }, 401)
    }

    const restaurante = restauranteResult[0]

      ; (c as AuthenticatedContext).user = {
        id: restaurante.id,
        email: restaurante.email,
        nombre: restaurante.nombre,
        splitPayment: restaurante.splitPayment,
        itemTracking: restaurante.itemTracking,
      }

    await next()
  } catch (error) {
    return c.json({ error: 'Token inválido' }, 401)
  }
}
