import { Hono } from 'hono'
import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { restaurante, sucursal } from '../db/schema'
import { authMiddleware, type AuthenticatedContext } from '../middleware/auth'
import { columnasLocalMarketing, tarjetaDelLocal } from '../lib/marketing-local'

/**
 * Lo que Marketing del panel (`admin/src/marketing/`) lee del local además de las rutas de
 * clientes, campañas, cupones y puntos: su tarjeta (ventas, módulos, día flojo, mensajes de hoy)
 * y sus sucursales con nombre y estado, nunca la fila completa, que guarda credenciales.
 */
export function createMarketingLocalRoute(
  getDb = () => drizzle(pool),
  auth = authMiddleware,
) {
  return new Hono()
    .use('*', auth)
    .get('/', async (c) => {
      const restauranteId = (c as unknown as AuthenticatedContext).user.id
      const db = getDb()
      const [local] = await db
        .select(columnasLocalMarketing)
        .from(restaurante)
        .where(eq(restaurante.id, restauranteId))
        .limit(1)
      if (!local) return c.json({ error: 'Local no encontrado' }, 404)
      return c.json(await tarjetaDelLocal(db, local, new Date()))
    })
    .get('/sucursales', async (c) => {
      const sucursales = await getDb()
        .select({
          id: sucursal.id,
          nombre: sucursal.nombre,
          activo: sucursal.activo,
        })
        .from(sucursal)
        .where(
          eq(
            sucursal.restauranteId,
            (c as unknown as AuthenticatedContext).user.id,
          ),
        )
        .orderBy(asc(sucursal.id))
      return c.json(sucursales)
    })
}
export const marketingLocalRoute = createMarketingLocalRoute()
