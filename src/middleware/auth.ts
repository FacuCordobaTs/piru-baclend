import { Context, Next } from 'hono'
import * as jwt from 'jsonwebtoken'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { usuarioAdmin as UsuarioAdminTable } from '../db/schema'
import { eq } from 'drizzle-orm'

export interface AuthenticatedContext extends Context {
  user: {
    id: number
    email: string
    name?: string
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
    const usuarioAdminResult = await db.select().from(UsuarioAdminTable).where(eq(UsuarioAdminTable.id, decoded.id)).limit(1)
    
    if (!usuarioAdminResult.length) {
      return c.json({ error: 'Usuario admin no encontrado' }, 401)
    }

    const usuarioAdmin = usuarioAdminResult[0]
    
    ;(c as AuthenticatedContext).user = {
      id: usuarioAdmin.id,
      email: usuarioAdmin.email,
      name: usuarioAdmin.name,
    }

    await next()
  } catch (error) {
    return c.json({ error: 'Token inválido' }, 401)
  }
}
