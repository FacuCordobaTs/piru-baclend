import { Context, Next } from 'hono'
import * as jwt from 'jsonwebtoken'

/**
 * Auth del PANEL INTERNO (herramienta del fundador), separada por completo del JWT
 * por-restaurante. El authMiddleware normal scopea todo a un solo restaurante.id y no
 * sirve para operar cross-tenant (listar todos los locales, cambiarle el plan a
 * cualquiera). Acá validamos un JWT firmado con un secreto PROPIO
 * (INTERNO_JWT_SECRET, distinto de JWT_SECRET) para que un token de restaurante NUNCA
 * sirva en /interno/*, y viceversa.
 *
 * Debe ir después de nada: es la primera barrera de las rutas /interno/* (salvo login).
 */
export const internoAuthMiddleware = async (c: Context, next: Next) => {
  const authHeader = c.req.header('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization header required' }, 401)
  }

  const token = authHeader.substring(7)
  const secret = process.env.INTERNO_JWT_SECRET
  if (!secret) {
    console.error('❌ [Interno] Falta INTERNO_JWT_SECRET en el env')
    return c.json({ error: 'Panel interno no disponible' }, 503)
  }

  try {
    const decoded = jwt.verify(token, secret) as { scope?: string }
    if (decoded.scope !== 'interno') {
      return c.json({ error: 'Token inválido' }, 401)
    }
    await next()
  } catch {
    return c.json({ error: 'Token inválido' }, 401)
  }
}
