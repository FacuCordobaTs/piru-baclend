import { Context, Next } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { tieneAcceso, type FeatureKey } from '../lib/planes'

/**
 * Middleware de gating por plan. Se antepone a los handlers de endpoints que
 * pertenecen a una feature de pago (Intermedio+/Avanzado). El chequeo real vive
 * en el backend, siempre; ocultar el botón en la UI no alcanza.
 *
 * Debe correr DESPUÉS de authMiddleware (necesita (c).user.id).
 * Responde 403 con { upgradeRequired: true, feature } para que la UI muestre el
 * mensaje de upgrade en vez de un error genérico.
 */
export function requireFeature(feature: FeatureKey) {
  return async (c: Context, next: Next) => {
    const restauranteId = (c as any).user?.id
    if (!restauranteId) {
      return c.json({ success: false, message: 'No autenticado' }, 401)
    }

    const ok = await tieneAcceso(drizzle(pool), restauranteId, feature)
    if (!ok) {
      return c.json(
        {
          success: false,
          upgradeRequired: true,
          feature,
          message: 'Esta función no está incluida en tu plan actual',
        },
        403,
      )
    }

    await next()
  }
}
