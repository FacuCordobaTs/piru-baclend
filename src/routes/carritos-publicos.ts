import { Hono } from 'hono'
import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { carritoPublico, producto, restaurante, sitioTienda } from '../db/schema'
import {
  CARRITO_TTL_MS,
  crearLimitador,
  idCarrito,
  idCarritoValido,
  validarContexto,
  validarItems,
  validarReturnUrl,
} from '../lib/carrito-publico'

/**
 * Carrito de handoff de Páginas (docs/PAGINAS_PROPIAS.md, sección 9): el sitio lo crea con
 * `carrito.checkout()` y el checkout de `my.piru.app/<username>/checkout?carrito=<id>` lo lee. Sin
 * precios ni datos personales; vence a las 2 horas.
 */
export function createCarritosPublicosRoute(getDb: () => MySql2Database = () => drizzle(pool)) {
  const limitar = crearLimitador(30, 60_000)
  return new Hono()
    .post('/', async (c) => {
      const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? 'local'
      if (!limitar(ip)) return c.json({ error: 'Demasiados carritos; probá en un minuto' }, 429)
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
      const restauranteId = Number(body?.restauranteId)
      if (!Number.isSafeInteger(restauranteId) || restauranteId <= 0) return c.json({ error: 'Local inválido' }, 400)
      const validacion = validarItems(body?.items)
      if ('error' in validacion) return c.json({ error: validacion.error }, 400)

      const db = getDb()
      const [local] = await db
        .select({ id: restaurante.id, username: restaurante.username })
        .from(restaurante)
        .where(eq(restaurante.id, restauranteId))
        .limit(1)
      if (!local?.username) return c.json({ error: 'Local no encontrado' }, 404)

      const ids = [...new Set(validacion.items.map((i) => i.productoId))]
      const existentes = await db
        .select({ id: producto.id })
        .from(producto)
        .where(
          and(
            eq(producto.restauranteId, restauranteId),
            inArray(producto.id, ids),
            eq(producto.activo, true),
            isNull(producto.eventoSucursalId),
          ),
        )
      if (existentes.length !== ids.length) return c.json({ error: 'Un producto del carrito ya no está disponible' }, 400)

      const [sitio] = await db
        .select({ id: sitioTienda.id })
        .from(sitioTienda)
        .where(eq(sitioTienda.restauranteId, restauranteId))
        .limit(1)
        .catch(() => [] as { id: number }[])

      const id = idCarrito()
      const ahora = new Date()
      const expiraAt = new Date(ahora.getTime() + CARRITO_TTL_MS)
      await db.insert(carritoPublico).values({
        id,
        restauranteId,
        sitioId: sitio?.id ?? null,
        items: validacion.items,
        contexto: validarContexto(body?.contexto),
        returnUrl: validarReturnUrl(body?.returnUrl, local.username),
        expiraAt,
        createdAt: ahora,
      })
      return c.json(
        {
          id,
          expiraAt: expiraAt.toISOString(),
          checkoutUrl: `https://my.piru.app/${encodeURIComponent(local.username)}/checkout?carrito=${id}`,
        },
        201,
      )
    })
    .get('/:id', async (c) => {
      const id = c.req.param('id')
      if (!idCarritoValido(id)) return c.json({ error: 'Carrito no encontrado' }, 404)
      const db = getDb()
      const [fila] = await db
        .select({
          restauranteId: carritoPublico.restauranteId,
          items: carritoPublico.items,
          contexto: carritoPublico.contexto,
          returnUrl: carritoPublico.returnUrl,
          expiraAt: carritoPublico.expiraAt,
          username: restaurante.username,
        })
        .from(carritoPublico)
        .innerJoin(restaurante, eq(restaurante.id, carritoPublico.restauranteId))
        .where(eq(carritoPublico.id, id))
        .limit(1)
      if (!fila || fila.expiraAt.getTime() <= Date.now()) return c.json({ error: 'El carrito venció' }, 404)
      return c.json({ ...fila, expiraAt: fila.expiraAt.toISOString() }, 200, { 'Cache-Control': 'no-store' })
    })
    .delete('/:id', async (c) => {
      const id = c.req.param('id')
      if (idCarritoValido(id)) await getDb().delete(carritoPublico).where(eq(carritoPublico.id, id))
      return c.json({ success: true })
    })
}

export async function limpiarCarritosVencidos(db: MySql2Database) {
  await db.delete(carritoPublico).where(lt(carritoPublico.expiraAt, new Date()))
}

export const carritosPublicosRoute = createCarritosPublicosRoute()
