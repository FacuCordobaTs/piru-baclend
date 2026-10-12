import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { authMiddleware, type AuthenticatedContext } from '../middleware/auth'
import {
  borrarDatosEjemplo,
  estadoDatosEjemplo,
  sembrarDatosEjemplo,
} from '../lib/datos-ejemplo-db'

/**
 * Los datos de ejemplo de la demo (clientes, pedidos, campañas y un cupón marcados "EJEMPLO").
 * Los ve y los borra el dueño desde el panel: la demo de prospección y, ya reclamada la tienda, la
 * cuenta que sigue. El marketer y la app de marketing no los manejan (quedan fuera de sus listas).
 */
export function createDatosEjemploRoute(getDb = () => drizzle(pool), auth = authMiddleware) {
  const restauranteIdDe = (c: unknown) => (c as AuthenticatedContext).user.id
  return new Hono()
    .use('*', auth)
    .get('/', async (c) => {
      const data = await estadoDatosEjemplo(getDb() as never, restauranteIdDe(c))
      return c.json({ success: true, data })
    })
    // Volver a cargarlos (para repetir la demo). Sólo aplica a una tienda que todavía no tiene dueño.
    .post('/', async (c) => {
      const db = getDb() as never
      const id = restauranteIdDe(c)
      const resultado = await sembrarDatosEjemplo(db, id, { forzar: true })
      const data = await estadoDatosEjemplo(db, id)
      if (resultado.estado === 'no_aplica')
        return c.json(
          { success: false, message: 'Esta tienda ya tiene dueño: los datos de ejemplo no se vuelven a cargar.', data },
          409,
        )
      if (resultado.estado === 'sin_productos')
        return c.json({ success: false, message: 'Cargá al menos un producto con precio para armar los datos de ejemplo.', data }, 409)
      return c.json({ success: resultado.estado === 'sembrado', data })
    })
    .delete('/', async (c) => {
      const db = getDb() as never
      const id = restauranteIdDe(c)
      const { borrados } = await borrarDatosEjemplo(db, id)
      return c.json({ success: true, borrados, data: await estadoDatosEjemplo(db, id) })
    })
}

export const datosEjemploRoute = createDatosEjemploRoute()
