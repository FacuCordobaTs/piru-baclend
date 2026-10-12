import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import * as jwt from 'jsonwebtoken'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { restaurante } from '../db/schema'
import { DEMO_SESION_TTL_SEGUNDOS, estadoPanelDemo } from '../lib/demo-panel'
import { asegurarDatosEjemplo } from '../lib/datos-ejemplo-db'
import { registrarEntradaDemo } from '../lib/demo-panel-visitas'

const secreto = () => process.env.JWT_SECRET || 'fallback-secret'

// Limitación por IP con expiración y tamaño acotado (mismo criterio que el login del marketer).
const intentos = new Map<string, { cantidad: number; hasta: number }>()
function limitado(clave: string, max: number) {
  const ahora = Date.now()
  if (intentos.size > 10000)
    for (const [key, value] of Array.from(intentos)) if (value.hasta <= ahora) intentos.delete(key)
  if (intentos.size > 10000) return true
  let actual = intentos.get(clave)
  if (!actual || actual.hasta <= ahora) {
    actual = { cantidad: 0, hasta: ahora + 15 * 60000 }
    intentos.set(clave, actual)
  }
  return ++actual.cantidad > max
}

const USERNAME = /^[a-zA-Z0-9_-]{1,100}$/

/**
 * La entrada al panel desde la demo de la tienda (`/:username?demo`). Pública: el botón "Ver tu panel
 * de administrador" abre `admin/demo/:username`, que pide acá la sesión. Sólo hay sesión mientras la
 * tienda sea un prospecto sin reclamar; después el dueño entra con su cuenta. La sesión es una
 * `{ id, scope:'restaurante', demo:true }` que `authMiddleware` limita con `demoPuede`
 * (lib/demo-panel.ts) y deja de aceptar apenas la tienda se reclama.
 */
export function createDemoPanelRoute(
  getDb = () => drizzle(pool),
  asegurarDatos: typeof asegurarDatosEjemplo = asegurarDatosEjemplo,
  registrarEntrada: typeof registrarEntradaDemo = registrarEntradaDemo,
) {
  return new Hono().post(
    '/sesion',
    zValidator('json', z.object({ username: z.string().trim().min(1).max(100) })),
    async (c) => {
      // No confiar en X-Forwarded-For del cliente; Cloudflare sobrescribe CF-Connecting-IP.
      const ip = c.req.header('cf-connecting-ip') || 'directo'
      if (limitado(`ip:${ip}`, 60))
        return c.json({ error: 'Demasiados intentos. Esperá unos minutos.', code: 'demasiados_intentos' }, 429)

      const { username } = c.req.valid('json')
      const noEncontrada = { error: 'No encontramos esa tienda.', code: 'tienda_no_encontrada' }
      if (!USERNAME.test(username)) return c.json(noEncontrada, 404)

      const db = getDb()
      const [local] = await db
        .select({
          id: restaurante.id,
          nombre: restaurante.nombre,
          origen: restaurante.origen,
          claimedAt: restaurante.claimedAt,
          telefonoVerificado: restaurante.telefonoVerificado,
          completedOnboarding: restaurante.completedOnboarding,
        })
        .from(restaurante)
        .where(eq(restaurante.username, username))
        .limit(1)
      if (!local) return c.json(noEncontrada, 404)

      const estado = estadoPanelDemo(local)
      if (estado === 'en_construccion')
        return c.json(
          { error: 'Todavía estamos terminando de armar esta tienda. Volvé a probar en un rato.', code: 'en_construccion' },
          409,
        )
      if (estado === 'cerrada')
        return c.json(
          { error: 'Esta tienda ya tiene dueño. Entrá con tu cuenta.', code: 'demo_cerrada' },
          409,
        )

      // Si el lote del alta todavía no corrió (o ya es de otro día) se hace ahora; con o sin datos se entra.
      try {
        await asegurarDatos(db as never, local.id)
      } catch (error) {
        console.error('[demo-panel] No se pudieron preparar los datos de ejemplo:', (error as Error).message)
      }

      // La señal de que abrió el panel (la lee interno). Que no se pueda anotar no impide entrar.
      try {
        await registrarEntrada(db as never, local.id)
      } catch (error) {
        console.warn('[demo-panel] No se pudo anotar la entrada al panel:', (error as Error).message)
      }

      const token = jwt.sign({ id: local.id, scope: 'restaurante', demo: true }, secreto(), {
        expiresIn: DEMO_SESION_TTL_SEGUNDOS,
      })
      return c.json({
        success: true,
        token,
        expira: new Date(Date.now() + DEMO_SESION_TTL_SEGUNDOS * 1000).toISOString(),
        restauranteId: local.id,
        nombre: local.nombre,
      })
    },
  )
}

export const demoPanelRoute = createDemoPanelRoute()
