import { createHash } from 'node:crypto'
import { and, eq, gt, isNull, or } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import {
  cliente as ClienteTable,
  marketingCampana as MarketingCampanaTable,
  marketingEnlace as MarketingEnlaceTable,
  marketingSesion as MarketingSesionTable,
  pedidoMarketingAtribucion as PedidoMarketingAtribucionTable,
  pedidoUnificado as PedidoUnificadoTable,
} from '../db/schema'

export interface ContextoAtribucionPedidoMarketing {
  restauranteId: number
  pedidoUnificadoId: number
  clienteId: number | null
  visitorId?: string | null
  sesionUuid?: string | null
  campaniaSlug?: string | null
  campanaId?: number | null
  recetaToken?: string | null
}

export interface SesionAtribuible {
  id: number
  restauranteId: number
  visitorId: string
  lastTouchTipo: 'directo' | 'campana' | 'receta'
  lastTouchCampanaId: number | null
  lastTouchRecetaCodigo: string | null
  expiraAt: Date
}

export interface CampaniaAtribuible { id: number }
export interface EnlaceAtribuible {
  campanaId: number | null
  clienteId: number | null
  recetaCodigo: string | null
}

export interface RepositorioAtribucionMarketing {
  buscarPedido(restauranteId: number, pedidoUnificadoId: number): Promise<{ total: string; montoDescuento: string | null } | null>
  buscarCliente(restauranteId: number, clienteId: number): Promise<boolean>
  buscarSesion(restauranteId: number, sesionUuid: string): Promise<SesionAtribuible | null>
  buscarCampaniaPorSlug(restauranteId: number, slug: string): Promise<CampaniaAtribuible | null>
  buscarEnlacePorTokenHash(restauranteId: number, tokenHash: string, ahora: Date): Promise<EnlaceAtribuible | null>
  insertarAtribucion(input: {
    restauranteId: number
    pedidoUnificadoId: number
    marketingSesionId: number | null
    campanaId: number | null
    origen: 'campana' | 'receta'
    recetaCodigo: string | null
    revenueAtribuido: string
    descuentoAtribuido: string
  }): Promise<void>
}

export type ResultadoAtribucionPedidoMarketing =
  | { estado: 'atribuido' }
  | { estado: 'sin_tracking' | 'sesion_invalida' | 'sin_origen' }

function textoOpcional(value: string | null | undefined, maximo: number): string | null {
  if (typeof value !== 'string') return null
  const limpio = value.trim()
  return limpio && limpio.length <= maximo ? limpio : null
}

export function hashTokenMarketing(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Vincula un pedido ya creado con su contexto de Growth. No crea sesiones ni
 * clientes: el checkout operativo debe seguir siendo exitoso aunque el
 * storefront no haya podido enviar tracking antes.
 */
export async function atribuirPedidoMarketing(
  repositorio: RepositorioAtribucionMarketing,
  contexto: ContextoAtribucionPedidoMarketing,
  ahora = new Date(),
): Promise<ResultadoAtribucionPedidoMarketing> {
  const visitorId = textoOpcional(contexto.visitorId, 64)
  const sesionUuid = textoOpcional(contexto.sesionUuid, 64)
  if (!visitorId || !sesionUuid) return { estado: 'sin_tracking' }

  const pedido = await repositorio.buscarPedido(contexto.restauranteId, contexto.pedidoUnificadoId)
  if (!pedido) throw new Error('el pedido no pertenece al restaurante')
  if (contexto.clienteId != null && !await repositorio.buscarCliente(contexto.restauranteId, contexto.clienteId)) {
    throw new Error('el cliente no pertenece al restaurante')
  }

  const sesion = await repositorio.buscarSesion(contexto.restauranteId, sesionUuid)
  if (!sesion || sesion.visitorId !== visitorId || ahora.getTime() > sesion.expiraAt.getTime()) {
    return { estado: 'sesion_invalida' }
  }

  const campaniaSlug = textoOpcional(contexto.campaniaSlug, 191)
  const recetaToken = textoOpcional(contexto.recetaToken, 512)
  const campaniaExplicita = campaniaSlug
    ? await repositorio.buscarCampaniaPorSlug(contexto.restauranteId, campaniaSlug)
    : null
  if (campaniaSlug && !campaniaExplicita) throw new Error('la campaña no pertenece al restaurante')

  const enlace = recetaToken
    ? await repositorio.buscarEnlacePorTokenHash(contexto.restauranteId, hashTokenMarketing(recetaToken), ahora)
    : null
  if (recetaToken && !enlace) throw new Error('el enlace de receta no pertenece al restaurante o venció')

  const recetaCodigo = enlace?.recetaCodigo ?? sesion.lastTouchRecetaCodigo
  const campanaId = campaniaExplicita?.id ?? enlace?.campanaId ?? sesion.lastTouchCampanaId
  const origen: 'campana' | 'receta' | null = recetaCodigo
    ? 'receta'
    : campanaId != null || sesion.lastTouchTipo === 'campana'
      ? 'campana'
      : null
  if (!origen) return { estado: 'sin_origen' }

  await repositorio.insertarAtribucion({
    restauranteId: contexto.restauranteId,
    pedidoUnificadoId: contexto.pedidoUnificadoId,
    marketingSesionId: sesion.id,
    campanaId: campanaId ?? null,
    origen,
    recetaCodigo: recetaCodigo ?? null,
    revenueAtribuido: pedido.total,
    descuentoAtribuido: pedido.montoDescuento ?? '0.00',
  })
  return { estado: 'atribuido' }
}

type Db = MySql2Database<Record<string, never>>

export function crearRepositorioAtribucionMarketing(db: Db): RepositorioAtribucionMarketing {
  return {
    async buscarPedido(restauranteId, pedidoUnificadoId) {
      const [row] = await db.select({ total: PedidoUnificadoTable.total, montoDescuento: PedidoUnificadoTable.montoDescuento })
        .from(PedidoUnificadoTable).where(and(eq(PedidoUnificadoTable.restauranteId, restauranteId), eq(PedidoUnificadoTable.id, pedidoUnificadoId))).limit(1)
      return row ?? null
    },
    async buscarCliente(restauranteId, clienteId) {
      const [row] = await db.select({ id: ClienteTable.id }).from(ClienteTable)
        .where(and(eq(ClienteTable.restauranteId, restauranteId), eq(ClienteTable.id, clienteId))).limit(1)
      return Boolean(row)
    },
    async buscarSesion(restauranteId, sesionUuid) {
      const [row] = await db.select({
        id: MarketingSesionTable.id, restauranteId: MarketingSesionTable.restauranteId, visitorId: MarketingSesionTable.visitorId,
        lastTouchTipo: MarketingSesionTable.lastTouchTipo, lastTouchCampanaId: MarketingSesionTable.lastTouchCampanaId,
        lastTouchRecetaCodigo: MarketingSesionTable.lastTouchRecetaCodigo, expiraAt: MarketingSesionTable.expiraAt,
      }).from(MarketingSesionTable).where(and(eq(MarketingSesionTable.restauranteId, restauranteId), eq(MarketingSesionTable.sesionUuid, sesionUuid))).limit(1)
      return row ?? null
    },
    async buscarCampaniaPorSlug(restauranteId, slug) {
      const [row] = await db.select({ id: MarketingCampanaTable.id }).from(MarketingCampanaTable)
        .where(and(eq(MarketingCampanaTable.restauranteId, restauranteId), eq(MarketingCampanaTable.slug, slug))).limit(1)
      return row ?? null
    },
    async buscarEnlacePorTokenHash(restauranteId, tokenHash, ahora) {
      const [row] = await db.select({ campanaId: MarketingEnlaceTable.campanaId, clienteId: MarketingEnlaceTable.clienteId, recetaCodigo: MarketingEnlaceTable.recetaCodigo })
        .from(MarketingEnlaceTable).where(and(
          eq(MarketingEnlaceTable.restauranteId, restauranteId), eq(MarketingEnlaceTable.tokenHash, tokenHash),
          eq(MarketingEnlaceTable.activo, true), or(isNull(MarketingEnlaceTable.expiraAt), gt(MarketingEnlaceTable.expiraAt, ahora)),
        )).limit(1)
      return row ?? null
    },
    async insertarAtribucion(input) {
      await db.insert(PedidoMarketingAtribucionTable).values(input).ignore()
    },
  }
}

/** Nunca propaga errores al checkout. Exportado para probar ese contrato. */
export async function atribuirPedidoMarketingSinPropagar(
  repositorio: RepositorioAtribucionMarketing,
  contexto: ContextoAtribucionPedidoMarketing,
  reportarError: (error: unknown) => void = (error) => console.error('[marketing] No se pudo atribuir pedido:', error),
): Promise<ResultadoAtribucionPedidoMarketing | null> {
  try {
    return await atribuirPedidoMarketing(repositorio, contexto)
  } catch (error) {
    reportarError(error)
    return null
  }
}

async function asegurarSesionCampanaBestEffort(
  db: Db,
  contexto: ContextoAtribucionPedidoMarketing,
  campanaId: number,
): Promise<number | null> {
  try {
    const ahora = new Date()
    const expiraAt = new Date(ahora.getTime() + 30 * 60 * 1000)
    const visitorOriginal = textoOpcional(contexto.visitorId, 64)
    const sesionOriginal = textoOpcional(contexto.sesionUuid, 64)
    if (visitorOriginal && sesionOriginal) {
      const [existente] = await db.select({ id: MarketingSesionTable.id, visitorId: MarketingSesionTable.visitorId })
        .from(MarketingSesionTable).where(and(
          eq(MarketingSesionTable.restauranteId, contexto.restauranteId),
          eq(MarketingSesionTable.sesionUuid, sesionOriginal),
        )).limit(1)
      if (existente?.visitorId === visitorOriginal) {
        await db.update(MarketingSesionTable).set({
          lastTouchTipo: 'campana', lastTouchCampanaId: campanaId,
          lastTouchRecetaCodigo: null, lastTouchAt: ahora, expiraAt,
        }).where(and(
          eq(MarketingSesionTable.restauranteId, contexto.restauranteId),
          eq(MarketingSesionTable.id, existente.id),
        ))
        return existente.id
      }
    }

    const sintetico = `pedido-${contexto.pedidoUnificadoId}`
    await db.insert(MarketingSesionTable).values({
      restauranteId: contexto.restauranteId,
      sesionUuid: sintetico,
      visitorId: sintetico,
      firstTouchTipo: 'campana', firstTouchCampanaId: campanaId,
      firstTouchRecetaCodigo: null, firstTouchAt: ahora,
      lastTouchTipo: 'campana', lastTouchCampanaId: campanaId,
      lastTouchRecetaCodigo: null, lastTouchAt: ahora, expiraAt,
    }).ignore()
    const [tecnica] = await db.select({ id: MarketingSesionTable.id }).from(MarketingSesionTable).where(and(
      eq(MarketingSesionTable.restauranteId, contexto.restauranteId),
      eq(MarketingSesionTable.sesionUuid, sintetico),
    )).limit(1)
    return tecnica?.id ?? null
  } catch (error) {
    // La relación pedido↔campaña se persiste igualmente con sesión NULL.
    console.error('[marketing] No se pudo conservar la sesión del pedido atribuido:', error)
    return null
  }
}

async function atribuirPedidoACampanaExplicita(
  db: Db,
  contexto: ContextoAtribucionPedidoMarketing,
  referencia: { id: number | null; slug: string | null },
): Promise<ResultadoAtribucionPedidoMarketing> {
  const [campana] = await db.select({ id: MarketingCampanaTable.id }).from(MarketingCampanaTable).where(and(
    eq(MarketingCampanaTable.restauranteId, contexto.restauranteId),
    ...(referencia.id != null ? [eq(MarketingCampanaTable.id, referencia.id)] : []),
    ...(referencia.slug ? [eq(MarketingCampanaTable.slug, referencia.slug)] : []),
  )).limit(1)
  if (!campana) throw new Error('la campaña no pertenece al restaurante')

  const [pedido] = await db.select({ total: PedidoUnificadoTable.total, montoDescuento: PedidoUnificadoTable.montoDescuento })
    .from(PedidoUnificadoTable).where(and(
      eq(PedidoUnificadoTable.restauranteId, contexto.restauranteId),
      eq(PedidoUnificadoTable.id, contexto.pedidoUnificadoId),
    )).limit(1)
  if (!pedido) throw new Error('el pedido no pertenece al restaurante')
  if (contexto.clienteId != null) {
    const [cliente] = await db.select({ id: ClienteTable.id }).from(ClienteTable).where(and(
      eq(ClienteTable.restauranteId, contexto.restauranteId),
      eq(ClienteTable.id, contexto.clienteId),
    )).limit(1)
    if (!cliente) throw new Error('el cliente no pertenece al restaurante')
  }

  const marketingSesionId = await asegurarSesionCampanaBestEffort(db, contexto, campana.id)
  await db.insert(PedidoMarketingAtribucionTable).values({
    restauranteId: contexto.restauranteId,
    pedidoUnificadoId: contexto.pedidoUnificadoId,
    marketingSesionId,
    campanaId: campana.id,
    origen: 'campana',
    recetaCodigo: null,
    revenueAtribuido: pedido.total,
    descuentoAtribuido: pedido.montoDescuento ?? '0.00',
  }).ignore()

  // INSERT IGNORE puede silenciar más que una colisión idempotente. Verificar
  // la fila evita declarar éxito cuando MySQL descartó realmente la escritura.
  const [persistida] = await db.select({ campanaId: PedidoMarketingAtribucionTable.campanaId })
    .from(PedidoMarketingAtribucionTable).where(and(
      eq(PedidoMarketingAtribucionTable.restauranteId, contexto.restauranteId),
      eq(PedidoMarketingAtribucionTable.pedidoUnificadoId, contexto.pedidoUnificadoId),
    )).limit(1)
  if (!persistida || persistida.campanaId !== campana.id) {
    throw new Error('no se pudo persistir la atribución explícita del pedido')
  }
  return { estado: 'atribuido' }
}

export async function atribuirPedidoMarketingBestEffort(db: Db, contexto: ContextoAtribucionPedidoMarketing): Promise<ResultadoAtribucionPedidoMarketing | null> {
  try {
    const slug = textoOpcional(contexto.campaniaSlug, 191)
    const campanaId = Number.isInteger(contexto.campanaId) && Number(contexto.campanaId) > 0
      ? Number(contexto.campanaId)
      : null
    if (slug || campanaId) return await atribuirPedidoACampanaExplicita(db, contexto, { id: campanaId, slug })
    return await atribuirPedidoMarketingSinPropagar(crearRepositorioAtribucionMarketing(db), contexto)
  } catch (error) {
    console.error('[marketing] No se pudo preparar la atribución del pedido:', error)
    return null
  }
}
