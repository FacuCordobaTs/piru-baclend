import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import * as bcrypt from 'bcrypt'
import * as jwt from 'jsonwebtoken'
import { and, desc, eq, gte } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import {
  marketer,
  restaurante,
  restauranteMarketer,
  comisionMarketer,
} from '../db/schema'
import {
  marketerAuthMiddleware,
  type MarketerContext,
} from '../middleware/marketer'
import {
  datosMarketer,
  hashActivacionMarketer,
} from '../lib/marketer-identidad'
import {
  columnasLocalCartera,
  tarjetasDeCartera,
} from '../lib/marketer-cartera-db'

const secreto = () => process.env.JWT_SECRET || 'fallback-secret'
const sesion = (row: typeof marketer.$inferSelect) => ({
  token: jwt.sign({ marketerId: row.id, scope: 'marketer' }, secreto(), {
    expiresIn: '30d',
  }),
  marketer: datosMarketer(row),
})
// Limitación por email e IP con expiración y tamaño acotado; no se guardan contraseñas/tokens.
const intentos = new Map<string, { cantidad: number; hasta: number }>()
function limitado(clave: string, max: number) {
  const ahora = Date.now()
  if (intentos.size > 10000)
    for (const [key, value] of Array.from(intentos))
      if (value.hasta <= ahora) intentos.delete(key)
  if (intentos.size > 10000) return true
  let actual = intentos.get(clave)
  if (!actual || actual.hasta <= ahora) {
    actual = { cantidad: 0, hasta: ahora + 15 * 60000 }
    intentos.set(clave, actual)
  }
  return ++actual.cantidad > max
}

export function createMarketerRoute(
  getDb = () => drizzle(pool),
  auth = marketerAuthMiddleware,
) {
  return new Hono()
    .onError((_error, c) => {
      // Los errores Drizzle incluyen SQL y parámetros: jamás loguear hashes o tokens de activación.
      console.error('[marketer] No se pudo completar la operación')
      return c.json(
        { error: 'No se pudo completar la operación. Volvé a intentar.' },
        500,
      )
    })
    .post(
      '/login',
      zValidator(
        'json',
        z.object({
          email: z.string().trim().email().max(255),
          password: z.string().min(1).max(72),
        }),
      ),
      async (c) => {
        const { password } = c.req.valid('json')
        const email = c.req.valid('json').email.toLowerCase()
        // No confiar en X-Forwarded-For del cliente; Cloudflare sobrescribe CF-Connecting-IP.
        const ip = c.req.header('cf-connecting-ip') || 'directo'
        if (limitado(`email:${email}`, 10) || limitado(`ip:${ip}`, 100))
          return c.json(
            { error: 'Demasiados intentos. Esperá 15 minutos.' },
            429,
          )
        const db = getDb()
        const [row] = await db
          .select()
          .from(marketer)
          .where(eq(marketer.email, email))
          .limit(1)
        if (
          !row?.activo ||
          !row.passwordHash ||
          !(await bcrypt.compare(password, row.passwordHash))
        )
          return c.json({ error: 'Email o contraseña incorrectos' }, 401)
        intentos.delete(`email:${email}`)
        await db
          .update(marketer)
          .set({ ultimoAccesoAt: new Date() })
          .where(eq(marketer.id, row.id))
        return c.json(sesion(row))
      },
    )
    .post(
      '/activar',
      zValidator(
        'json',
        z.object({
          token: z.string().min(32).max(128),
          password: z.string().min(8).max(72),
        }),
      ),
      async (c) => {
        if (
          limitado(
            `activar:${c.req.header('cf-connecting-ip') || 'directo'}`,
            50,
          )
        )
          return c.json(
            { error: 'Demasiados intentos. Esperá 15 minutos.' },
            429,
          )
        const { token, password } = c.req.valid('json')
        const tokenHash = hashActivacionMarketer(token)
        const db = getDb()
        const ahora = new Date()
        const [row] = await db
          .select()
          .from(marketer)
          .where(
            and(
              eq(marketer.activacionTokenHash, tokenHash),
              eq(marketer.activo, true),
              gte(marketer.activacionExpiraAt, ahora),
            ),
          )
          .limit(1)
        if (!row)
          return c.json(
            { error: 'El link venció o ya fue usado. Pedí uno nuevo a Piru.' },
            401,
          )
        const passwordHash = await bcrypt.hash(password, 10)
        // El claim condicional consume el link una sola vez incluso ante dos requests concurrentes.
        const [result] = await db
          .update(marketer)
          .set({
            passwordHash,
            activacionTokenHash: null,
            activacionExpiraAt: null,
            ultimoAccesoAt: ahora,
          })
          .where(
            and(
              eq(marketer.id, row.id),
              eq(marketer.activacionTokenHash, tokenHash),
              eq(marketer.activo, true),
              gte(marketer.activacionExpiraAt, ahora),
            ),
          )
        if (!result.affectedRows)
          return c.json({ error: 'El link ya fue usado' }, 401)
        return c.json(sesion(row))
      },
    )
    .use('*', auth)
    .get('/me', (c) =>
      c.json(datosMarketer((c as unknown as MarketerContext).marketer)),
    )
    .put(
      '/me',
      zValidator(
        'json',
        z
          .object({
            nombre: z.string().trim().min(1).max(255).optional(),
            telefono: z.string().trim().max(50).nullish(),
            datosCobro: z.string().trim().max(255).nullish(),
          })
          .strict(),
      ),
      async (c) => {
        const row = (c as unknown as MarketerContext).marketer
        const changes = c.req.valid('json')
        if (Object.keys(changes).length)
          await getDb()
            .update(marketer)
            .set(changes)
            .where(eq(marketer.id, row.id))
        return c.json(datosMarketer({ ...row, ...changes }))
      },
    )
    .post('/locales/:restauranteId/acceso', async (c) => {
      const restauranteId = Number(c.req.param('restauranteId'))
      const marketerId = (c as unknown as MarketerContext).marketer.id
      if (!Number.isInteger(restauranteId) || restauranteId <= 0)
        return c.json({ error: 'Local inválido' }, 400)
      const [row] = await getDb()
        .select({ id: restauranteMarketer.id })
        .from(restauranteMarketer)
        .where(
          and(
            eq(restauranteMarketer.restauranteId, restauranteId),
            eq(restauranteMarketer.marketerId, marketerId),
            eq(restauranteMarketer.estado, 'activo'),
          ),
        )
        .limit(1)
      if (!row)
        return c.json(
          {
            error: 'No tenés acceso a ese local',
            code: 'acceso_marketer_revocado',
          },
          403,
        )
      const token = jwt.sign(
        { id: restauranteId, scope: 'restaurante', marketerId },
        secreto(),
        { expiresIn: '12h' },
      )
      const expira = new Date(
        (jwt.decode(token) as jwt.JwtPayload).exp! * 1000,
      ).toISOString()
      return c.json({ token, expira })
    })
    .get('/locales', async (c) => {
      const partner = (c as unknown as MarketerContext).marketer
      const db = getDb()
      const ahora = new Date()
      const locales = await db
        .select({
          ...columnasLocalCartera,
          desde: restauranteMarketer.activadoAt,
          estado: restauranteMarketer.estado,
          revocadoAt: restauranteMarketer.revocadoAt,
          porcentaje: restauranteMarketer.comisionPorcentaje,
        })
        .from(restauranteMarketer)
        .innerJoin(
          restaurante,
          eq(restaurante.id, restauranteMarketer.restauranteId),
        )
        .where(eq(restauranteMarketer.marketerId, partner.id))
      const activos = locales.filter((l) => l.estado === 'activo')
      const revocados = locales
        .filter((l) => l.estado === 'revocado')
        .map(({ restauranteId, nombre, imagenUrl, revocadoAt }) => ({
          restauranteId,
          nombre: nombre || `Local ${restauranteId}`,
          imagenUrl,
          revocadoAt,
        }))
      if (!activos.length) return c.json({ activos: [], revocados })
      const filas = await tarjetasDeCartera(
        db,
        activos,
        partner.comisionPorcentaje,
        ahora,
      )
      return c.json({ activos: filas, revocados })
    })
    .get(
      '/comisiones',
      zValidator(
        'query',
        z.object({
          estado: z.enum(['pendiente', 'pagada', 'anulada']).optional(),
        }),
      ),
      async (c) => {
        const partner = (c as unknown as MarketerContext).marketer
        const rows = await getDb()
          .select({
            id: comisionMarketer.id,
            restauranteId: comisionMarketer.restauranteId,
            local: restaurante.nombre,
            pagoSuscripcionId: comisionMarketer.pagoSuscripcionId,
            baseComisionable: comisionMarketer.baseComisionable,
            porcentaje: comisionMarketer.porcentaje,
            monto: comisionMarketer.monto,
            estado: comisionMarketer.estado,
            createdAt: comisionMarketer.createdAt,
            pagadaAt: comisionMarketer.pagadaAt,
            referenciaPago: comisionMarketer.referenciaPago,
            nota: comisionMarketer.nota,
          })
          .from(comisionMarketer)
          .innerJoin(
            restaurante,
            eq(restaurante.id, comisionMarketer.restauranteId),
          )
          .where(eq(comisionMarketer.marketerId, partner.id))
          .orderBy(desc(comisionMarketer.createdAt))
        const estado = c.req.valid('query').estado
        const totales = rows.reduce(
          (t, row) => {
            if (row.estado === 'pendiente') t.pendiente += Number(row.monto)
            if (row.estado === 'pagada') t.pagado += Number(row.monto)
            return t
          },
          { pendiente: 0, pagado: 0 },
        )
        return c.json({
          totales,
          filas: rows
            .filter((r) => !estado || r.estado === estado)
            .map((r) => ({
              ...r,
              restauranteNombre: r.local,
              baseComisionable: Number(r.baseComisionable),
              porcentaje: Number(r.porcentaje),
              monto: Number(r.monto),
            })),
        })
      },
    )
}
export const marketerRoute = createMarketerRoute()
