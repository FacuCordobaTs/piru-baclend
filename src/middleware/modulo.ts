import { Context, Next } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { tieneModuloActivo, type ModuleKey } from '../lib/modulos'

/**
 * Gating canónico por módulo. Debe ejecutarse después de `authMiddleware`.
 * El contrato conserva `upgradeRequired` mientras existan admins que sólo
 * entienden el error legacy de planes.
 */
export function requireModulo(modulo: ModuleKey) {
  return async (c: Context, next: Next) => {
    const restauranteId = (c as any).user?.id
    if (!restauranteId) {
      return c.json({ success: false, message: 'No autenticado' }, 401)
    }

    const activo = await tieneModuloActivo(drizzle(pool), restauranteId, modulo)
    if (!activo) {
      return c.json({
        success: false,
        moduleRequired: true,
        module: modulo,
        // Compatibilidad temporal con el manejador de upgrades de admins viejos.
        upgradeRequired: true,
        message: 'Esta función requiere activar el módulo correspondiente',
      }, 403)
    }

    await next()
  }
}
