import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { marketer, restauranteMarketer } from '../db/schema'
import { authMiddleware, type AuthenticatedContext } from '../middleware/auth'
import { vincularMarketer } from '../lib/marketer-identidad'

export const miMarketerRoute = new Hono()
  .use('*', authMiddleware)
  .get('/', async (c) => {
    const [row] = await drizzle(pool)
      .select({
        nombre: marketer.nombre,
        codigo: marketer.codigo,
        desde: restauranteMarketer.activadoAt,
        origen: restauranteMarketer.origen,
      })
      .from(restauranteMarketer)
      .innerJoin(marketer, eq(marketer.id, restauranteMarketer.marketerId))
      .where(
        and(
          eq(
            restauranteMarketer.restauranteId,
            (c as unknown as AuthenticatedContext).user.id,
          ),
          eq(restauranteMarketer.estado, 'activo'),
        ),
      )
      .limit(1)
    return c.json(
      row
        ? {
            marketer: { nombre: row.nombre, codigo: row.codigo },
            desde: row.desde,
            origen: row.origen,
          }
        : null,
    )
  })
  .get(
    '/buscar',
    zValidator('query', z.object({ codigo: z.string().trim().min(1).max(32) })),
    async (c) => {
      const [row] = await drizzle(pool)
        .select({ nombre: marketer.nombre })
        .from(marketer)
        .where(
          and(
            eq(marketer.codigo, c.req.valid('query').codigo.toUpperCase()),
            eq(marketer.activo, true),
          ),
        )
        .limit(1)
      return row
        ? c.json(row)
        : c.json({ error: 'No encontramos ese código' }, 404)
    },
  )
  .post(
    '/',
    zValidator(
      'json',
      z.object({
        codigo: z.string().trim().min(1).max(32),
        reemplazar: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const input = c.req.valid('json')
      const [partner] = await drizzle(pool)
        .select({ id: marketer.id })
        .from(marketer)
        .where(
          and(
            eq(marketer.codigo, input.codigo.toUpperCase()),
            eq(marketer.activo, true),
          ),
        )
        .limit(1)
      if (!partner) return c.json({ error: 'No encontramos ese código' }, 404)
      try {
        return c.json(
          await vincularMarketer(
            (c as unknown as AuthenticatedContext).user.id,
            partner.id,
            { origen: 'duenio', reemplazar: input.reemplazar },
          ),
        )
      } catch (error: any) {
        if (error.status === 409 || error.status === 404)
          return c.json(
            { error: error.message, code: error.code },
            error.status,
          )
        throw error
      }
    },
  )
  .delete('/', async (c) => {
    await vincularMarketer(
      (c as unknown as AuthenticatedContext).user.id,
      null,
      { origen: 'duenio' },
    )
    return c.json({ ok: true })
  })
