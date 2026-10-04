import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { and, desc, eq, sql } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { pool } from '../db'
import {
  marketer,
  restauranteMarketer,
  comisionMarketer,
  restaurante,
} from '../db/schema'
import {
  datosMarketer,
  generarActivacionMarketer,
  vincularMarketer,
} from '../lib/marketer-identidad'
import { sincronizarComisiones } from '../lib/comisiones-marketer'
import { repositorioComisiones } from '../lib/comisiones-marketer-db'

// Se monta dentro de /interno, después de internoAuthMiddleware.
export function createInternoMarketersRoute(db = drizzle(pool)) {
  const internoMarketersRoute = new Hono()
  const porcentaje = z.number().min(0).max(100)
  const id = (valor: string) => {
    const n = Number(valor)
    if (!Number.isSafeInteger(n) || n < 1)
      throw Object.assign(new Error('ID inválido'), { status: 400 })
    return n
  }
  internoMarketersRoute.onError((error, c) => {
    const status = (error as Error & { status?: number }).status
    if (status === 400 || status === 404 || status === 409)
      return c.json({ success: false, message: error.message }, status)
    const e = error as Error & { code?: string; cause?: { code?: string } }
    if ((e.code ?? e.cause?.code) === 'ER_DUP_ENTRY')
      return c.json(
        { success: false, message: 'El email o código ya está registrado' },
        409,
      )
    console.error('[Marketers] Error en operación interna')
    return c.json(
      { success: false, message: 'No se pudo completar la operación' },
      500,
    )
  })
  internoMarketersRoute.get('/marketers', async (c) => {
    const rows = await db
      .select()
      .from(marketer)
      .orderBy(desc(marketer.createdAt))
    const vinculos = await db
      .select({
        marketerId: restauranteMarketer.marketerId,
        total: sql<number>`count(*)`,
      })
      .from(restauranteMarketer)
      .where(eq(restauranteMarketer.estado, 'activo'))
      .groupBy(restauranteMarketer.marketerId)
    const comisiones = await db
      .select({
        marketerId: comisionMarketer.marketerId,
        total: sql<string>`sum(${comisionMarketer.monto})`,
      })
      .from(comisionMarketer)
      .where(eq(comisionMarketer.estado, 'pendiente'))
      .groupBy(comisionMarketer.marketerId)
    return c.json({
      success: true,
      data: rows.map((r) => ({
        ...datosMarketer(r),
        activo: r.activo,
        activado: !!r.passwordHash,
        localesActivos: Number(
          vinculos.find((v) => v.marketerId === r.id)?.total ?? 0,
        ),
        comisionPendiente: Number(
          comisiones.find((v) => v.marketerId === r.id)?.total ?? 0,
        ),
      })),
    })
  })
  internoMarketersRoute.post(
    '/marketers',
    zValidator(
      'json',
      z.object({
        nombre: z.string().trim().min(1).max(255),
        email: z.email().trim().toLowerCase(),
        telefono: z.string().max(50).nullish(),
        codigo: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9_-]{2,32}$/),
        comisionPorcentaje: porcentaje.optional(),
      }),
    ),
    async (c) => {
      const entrada = c.req.valid('json')
      const activacion = generarActivacionMarketer()
      const [insert] = await db
        .insert(marketer)
        .values({
          ...entrada,
          comisionPorcentaje: entrada.comisionPorcentaje?.toFixed(2),
          activacionTokenHash: activacion.tokenHash,
          activacionExpiraAt: activacion.expiraAt,
        })
      const [row] = await db
        .select()
        .from(marketer)
        .where(eq(marketer.id, Number(insert.insertId)))
        .limit(1)
      return c.json(
        {
          success: true,
          data: {
            marketer: datosMarketer(row),
            linkActivacion: activacion.linkActivacion,
          },
        },
        201,
      )
    },
  )
  internoMarketersRoute.put(
    '/marketers/:id',
    zValidator(
      'json',
      z.object({
        nombre: z.string().trim().min(1).max(255).optional(),
        comisionPorcentaje: porcentaje.optional(),
        activo: z.boolean().optional(),
      }),
    ),
    async (c) => {
      const marketerId = id(c.req.param('id'))
      const entrada = c.req.valid('json')
      const [row] = await db
        .select()
        .from(marketer)
        .where(eq(marketer.id, marketerId))
        .limit(1)
      if (!row)
        return c.json(
          { success: false, message: 'Marketer no encontrado' },
          404,
        )
      await db
        .update(marketer)
        .set({
          ...entrada,
          comisionPorcentaje: entrada.comisionPorcentaje?.toFixed(2),
        })
        .where(eq(marketer.id, marketerId))
      return c.json({
        success: true,
        data: {
          ...datosMarketer({
            ...row,
            ...entrada,
            comisionPorcentaje:
              entrada.comisionPorcentaje?.toFixed(2) ?? row.comisionPorcentaje,
          }),
          activo: entrada.activo ?? row.activo,
        },
      })
    },
  )
  internoMarketersRoute.post('/marketers/:id/activacion', async (c) => {
    const marketerId = id(c.req.param('id'))
    const [row] = await db
      .select({ id: marketer.id })
      .from(marketer)
      .where(eq(marketer.id, marketerId))
      .limit(1)
    if (!row)
      return c.json({ success: false, message: 'Marketer no encontrado' }, 404)
    const activacion = generarActivacionMarketer()
    await db
      .update(marketer)
      .set({
        activacionTokenHash: activacion.tokenHash,
        activacionExpiraAt: activacion.expiraAt,
      })
      .where(eq(marketer.id, marketerId))
    return c.json({
      success: true,
      data: { linkActivacion: activacion.linkActivacion },
    })
  })
  internoMarketersRoute.put(
    '/locales/:id/marketer',
    zValidator(
      'json',
      z.object({
        marketerId: z.number().int().positive().nullable(),
        comisionPorcentaje: porcentaje.nullish(),
      }),
    ),
    async (c) => {
      const entrada = c.req.valid('json')
      const vinculo = await vincularMarketer(
        id(c.req.param('id')),
        entrada.marketerId,
        {
          origen: 'interno',
          reemplazar: true,
          comisionPorcentaje: entrada.comisionPorcentaje,
        },
        db,
      )
      return c.json({ success: true, data: vinculo })
    },
  )
  internoMarketersRoute.get('/comisiones', async (c) => {
    const estado = c.req.query('estado')
    const marketerId = c.req.query('marketerId')
    if (estado && !['pendiente', 'pagada', 'anulada'].includes(estado))
      return c.json({ success: false, message: 'Estado inválido' }, 400)
    const rows = await db
      .select({
        comision: comisionMarketer,
        local: restaurante.nombre,
        marketerNombre: marketer.nombre,
      })
      .from(comisionMarketer)
      .innerJoin(
        restaurante,
        eq(restaurante.id, comisionMarketer.restauranteId),
      )
      .innerJoin(marketer, eq(marketer.id, comisionMarketer.marketerId))
      .where(
        and(
          estado
            ? eq(
                comisionMarketer.estado,
                estado as 'pendiente' | 'pagada' | 'anulada',
              )
            : undefined,
          marketerId
            ? eq(comisionMarketer.marketerId, id(marketerId))
            : undefined,
        ),
      )
      .orderBy(desc(comisionMarketer.createdAt))
    return c.json({
      success: true,
      data: rows.map((r) => ({
        ...r.comision,
        local: r.local,
        marketerNombre: r.marketerNombre,
      })),
    })
  })
  internoMarketersRoute.post('/comisiones/sincronizar', async (c) =>
    c.json({
      success: true,
      data: await sincronizarComisiones(repositorioComisiones(db)),
    }),
  )
  internoMarketersRoute.post(
    '/comisiones/:id/pagar',
    zValidator(
      'json',
      z.object({
        referencia: z.string().trim().min(1).max(255),
        pagadaAt: z.iso.datetime({ offset: true }).optional(),
      }),
    ),
    async (c) => {
      const entrada = c.req.valid('json')
      const comisionId = id(c.req.param('id'))
      const [result] = await db
        .update(comisionMarketer)
        .set({
          estado: 'pagada',
          referenciaPago: entrada.referencia,
          pagadaAt: entrada.pagadaAt ? new Date(entrada.pagadaAt) : new Date(),
        })
        .where(
          and(
            eq(comisionMarketer.id, comisionId),
            eq(comisionMarketer.estado, 'pendiente'),
          ),
        )
      if (!result.affectedRows)
        return c.json(
          {
            success: false,
            message: 'La comisión no existe o ya no está pendiente',
          },
          409,
        )
      return c.json({
        success: true,
        data: { id: comisionId, estado: 'pagada' },
      })
    },
  )
  internoMarketersRoute.post(
    '/comisiones/:id/anular',
    zValidator('json', z.object({ nota: z.string().trim().min(1).max(255) })),
    async (c) => {
      const comisionId = id(c.req.param('id'))
      const [row] = await db
        .select({ id: comisionMarketer.id })
        .from(comisionMarketer)
        .where(eq(comisionMarketer.id, comisionId))
        .limit(1)
      if (!row)
        return c.json(
          { success: false, message: 'Comisión no encontrada' },
          404,
        )
      await db
        .update(comisionMarketer)
        .set({ estado: 'anulada', nota: c.req.valid('json').nota })
        .where(eq(comisionMarketer.id, comisionId))
      return c.json({
        success: true,
        data: { id: comisionId, estado: 'anulada' },
      })
    },
  )
  return internoMarketersRoute
}
export const internoMarketersRoute = createInternoMarketersRoute()
