import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'
import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { restaurante, sucursal } from '../db/schema'
import { authMiddleware, type AuthenticatedContext } from '../middleware/auth'
import {
  columnasLocalCartera,
  tarjetasDeCartera,
} from '../lib/marketer-cartera-db'
import { urlAppMarketing } from '../lib/marketer-identidad'

const secreto = () => process.env.JWT_SECRET || 'fallback-secret'
/** El pase viaja en el fragmento de la URL: sólo alcanza para abrir la pestaña. */
const ENTRADA_TTL_SEGUNDOS = 120
const SESION_TTL_SEGUNDOS = 12 * 3600
// Sin `id`: el pase no sirve como token de local ni en authMiddleware ni en /ws/admin.
const SCOPE_ENTRADA = 'entrada-app-marketing'
const ENTRADA_VENCIDA = {
  error: 'El acceso venció. Volvé a abrir la app desde tu panel de Piru.',
  code: 'entrada_vencida',
}

/**
 * El dueño entra a la app de marketers sin login, desde Clientes del panel. El panel pide un
 * pase de dos minutos y lo abre en el fragmento de `MARKETING_URL/entrar`; la app lo canjea por
 * una sesión de 12 horas que `authMiddleware` limita a lo que la app usa
 * (`duenioAppMarketingPuede`), y que vive sólo en el `sessionStorage` de esa pestaña.
 */
export function createMarketingDuenioRoute(
  getDb = () => drizzle(pool),
  auth = authMiddleware,
) {
  return new Hono()
    .post('/sesion', async (c) => {
      const header = c.req.header('Authorization')
      let pase: jwt.JwtPayload = {}
      try {
        if (header?.startsWith('Bearer '))
          pase = jwt.verify(header.slice(7), secreto()) as jwt.JwtPayload
      } catch {
        // Vencido o adulterado: la misma respuesta que sin pase.
      }
      const restauranteId = Number(pase.restauranteId)
      if (
        pase.scope !== SCOPE_ENTRADA ||
        !Number.isInteger(restauranteId) ||
        restauranteId <= 0
      )
        return c.json(ENTRADA_VENCIDA, 401)
      const [local] = await getDb()
        .select({ id: restaurante.id })
        .from(restaurante)
        .where(eq(restaurante.id, restauranteId))
        .limit(1)
      if (!local) return c.json(ENTRADA_VENCIDA, 401)
      const vence = Math.min(
        Math.floor(Date.now() / 1000) + SESION_TTL_SEGUNDOS,
        Number(pase.hasta) || Infinity,
      )
      if (vence <= Math.floor(Date.now() / 1000))
        return c.json(ENTRADA_VENCIDA, 401)
      const token = jwt.sign(
        { id: local.id, scope: 'restaurante', appMarketing: true, exp: vence },
        secreto(),
      )
      return c.json({
        token,
        expira: new Date(vence * 1000).toISOString(),
        restauranteId: local.id,
      })
    })
    .use('*', auth)
    .post('/entrada', (c) => {
      // authMiddleware ya frena al marketer y a la sesión de la propia app (/entrada no está en
      // sus listas): los pases salen sólo de la sesión del panel.
      const restauranteId = (c as unknown as AuthenticatedContext).user.id
      const origen = jwt.decode(
        c.req.header('Authorization')!.slice(7),
      ) as jwt.JwtPayload
      const token = jwt.sign(
        {
          scope: SCOPE_ENTRADA,
          restauranteId,
          // Un acceso temporal de interno no se estira a 12 horas: la sesión vence con él.
          ...(origen.accesoTemporalInterno ? { hasta: origen.exp } : {}),
        },
        secreto(),
        { expiresIn: ENTRADA_TTL_SEGUNDOS },
      )
      return c.json({
        success: true,
        data: {
          url: `${urlAppMarketing()}/entrar#token=${encodeURIComponent(token)}`,
          expira: new Date(
            (jwt.decode(token) as jwt.JwtPayload).exp! * 1000,
          ).toISOString(),
        },
      })
    })
    .get('/local', async (c) => {
      const restauranteId = (c as unknown as AuthenticatedContext).user.id
      const db = getDb()
      const [local] = await db
        .select(columnasLocalCartera)
        .from(restaurante)
        .where(eq(restaurante.id, restauranteId))
        .limit(1)
      if (!local) return c.json({ error: 'Local no encontrado' }, 404)
      // La misma tarjeta que ve su marketer, sin vínculo ni comisión.
      const [tarjeta] = await tarjetasDeCartera(
        db,
        [{ ...local, desde: null, porcentaje: null }],
        0,
      )
      return c.json(tarjeta)
    })
    .get('/sucursales', async (c) => {
      // Para los filtros y los pedidos de Clientes: nombre y estado, nunca la fila completa, que
      // guarda credenciales (como /sucursales/list, que la app no puede usar).
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
export const marketingDuenioRoute = createMarketingDuenioRoute()
