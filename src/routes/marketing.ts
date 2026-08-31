import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import {
  marketingCampana as MarketingCampanaTable,
  marketingEnlace as MarketingEnlaceTable,
  marketingContacto as MarketingContactoTable,
  cliente as ClienteTable,
  codigoDescuento as CodigoDescuentoTable,
  colaRecompra as ColaRecompraTable,
  campanaRecompra as CampanaRecompraTable,
  recuperoCliente as RecuperoClienteTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  pedidoMarketingAtribucion as PedidoMarketingAtribucionTable,
  pedidoUnificado as PedidoUnificadoTable,
  marketingSesion as MarketingSesionTable,
  marketingEvento as MarketingEventoTable,
  producto as ProductoTable,
  restaurante as RestauranteTable,
} from '../db/schema'
import {
  ErrorMarketingTracking,
  guardarEventosMarketing,
  type EventoMarketingInput,
  type ResultadoEventoMarketing,
} from '../lib/marketing-tracking'
import { and, desc, eq, gt, gte, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth'
import { requireModulo } from '../middleware/modulo'
import { MODULE_KEYS } from '../lib/modulos'
import { RECETAS_CRECIMIENTO } from '../lib/recetas-crecimiento'
import {
  filtrarOportunidadesMarketing,
  resolverOportunidadesMarketing,
  type DatosOportunidadesMarketing,
  type EnlaceOportunidadInput,
} from '../lib/marketing-oportunidades'
import {
  coincideTokenMarketingSeguro,
  ErrorPrepararEnlaceMarketing,
  hashTokenMarketing,
  prepararEnlaceMarketing,
  type RepositorioEnlacesMarketing,
} from '../lib/marketing-enlaces'
import { computarPerfilesRFM } from '../lib/clientes-rfm'
import { chequearProteccionMarketing, VENTANA_TOPE_DIAS } from '../lib/proteccion-base'
import { COOLDOWN_HORAS } from '../lib/recupero'
import { registrarContactoManual } from '../lib/motor-recompra'
import {
  compensarReservaCreditoMarketing,
  confirmarReservaCreditoMarketing,
  reservarCreditoMarketing,
} from '../lib/mensajes-wallet'
import { resolverCredsRestaurante, sendClientGrowthRecipeWhatsApp, type WaCredentials } from '../services/whatsapp'
import { resumirResultadosMarketing, type DatosResultadosMarketing, type FiltrosResultadosMarketing } from '../lib/marketing-resultados'

const identificadorSchema = z.string().trim().min(1).max(64)

const touchSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('directo') }),
  z.object({ tipo: z.literal('campana'), campanaId: z.number().int().positive() }),
  z.object({ tipo: z.literal('receta'), recetaCodigo: identificadorSchema }),
])

const eventoSchema = z.object({
  eventoUuid: identificadorSchema,
  sesionUuid: identificadorSchema,
  visitorId: identificadorSchema,
  tipo: z.enum(['session_start', 'product_view', 'add_to_cart', 'checkout_start', 'purchase']),
  ocurridoAt: z.union([z.string(), z.number()]),
  touch: touchSchema.optional(),
  productoId: z.number().int().positive().nullable().optional(),
  pedidoUnificadoId: z.number().int().positive().nullable().optional(),
  cantidad: z.number().int().positive().nullable().optional(),
  valor: z.union([z.string(), z.number()]).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict()

export const eventosMarketingRequestSchema = z.object({
  restauranteId: z.number().int().positive(),
  eventos: z.array(eventoSchema).min(1).max(20),
}).strict()

export interface ReferenciasEventosMarketing {
  restauranteExiste(restauranteId: number): Promise<boolean>
  campaniasPertenecen(restauranteId: number, campaniaIds: number[]): Promise<boolean>
  productosPertenecen(restauranteId: number, productoIds: number[]): Promise<boolean>
  pedidosPertenecen(restauranteId: number, pedidoIds: number[]): Promise<boolean>
}

export interface DependenciasMarketingRoute {
  referencias: ReferenciasEventosMarketing
  resolverCampaniasPorSlug?: (restauranteId: number, slugs: string[]) => Promise<Map<string, number>>
  guardarEventos: (restauranteId: number, eventos: EventoMarketingInput[]) => Promise<ResultadoEventoMarketing[]>
}

function idsUnicos(eventos: EventoMarketingInput[], selector: (evento: EventoMarketingInput) => number | null | undefined): number[] {
  return [...new Set(eventos.map(selector).filter((id): id is number => id != null))]
}

async function restaurarTouchesDesdeSlug(
  dependencias: DependenciasMarketingRoute,
  restauranteId: number,
  eventos: EventoMarketingInput[],
): Promise<EventoMarketingInput[]> {
  const slugs = [...new Set(eventos.flatMap((evento) => {
    const slug = evento.metadata?.campaniaSlug
    return !evento.touch && typeof slug === 'string' && slug.trim() ? [slug.trim().slice(0, 191)] : []
  }))]
  if (!slugs.length || !dependencias.resolverCampaniasPorSlug) return eventos
  const ids = await dependencias.resolverCampaniasPorSlug(restauranteId, slugs)
  return eventos.map((evento) => {
    if (evento.touch) return evento
    const slug = typeof evento.metadata?.campaniaSlug === 'string' ? evento.metadata.campaniaSlug.trim() : ''
    const campanaId = ids.get(slug)
    return campanaId ? { ...evento, touch: { tipo: 'campana', campanaId } } : evento
  })
}

/**
 * Las FK simples de las tablas analíticas no prueban el tenant de la entidad
 * referenciada. Esta capa rechaza batches enteros antes de la primera escritura.
 */
export async function validarReferenciasEventosMarketing(
  referencias: ReferenciasEventosMarketing,
  restauranteId: number,
  eventos: EventoMarketingInput[],
): Promise<string | null> {
  if (!await referencias.restauranteExiste(restauranteId)) return 'Restaurante no encontrado'

  const campaniaIds = idsUnicos(eventos, (evento) => evento.touch?.campanaId)
  if (campaniaIds.length && !await referencias.campaniasPertenecen(restauranteId, campaniaIds)) {
    return 'Una campaña de marketing no pertenece al restaurante'
  }

  const productoIds = idsUnicos(eventos, (evento) => evento.productoId)
  if (productoIds.length && !await referencias.productosPertenecen(restauranteId, productoIds)) {
    return 'Un producto no pertenece al restaurante'
  }

  const pedidoIds = idsUnicos(eventos, (evento) => evento.pedidoUnificadoId)
  if (pedidoIds.length && !await referencias.pedidosPertenecen(restauranteId, pedidoIds)) {
    return 'Un pedido no pertenece al restaurante'
  }

  return null
}

function crearReferenciasDrizzle(): ReferenciasEventosMarketing {
  const db = drizzle(pool)
  const existenTodos = async (tabla: any, restauranteId: number, ids: number[]) => {
    if (!ids.length) return true
    const rows = await db.select({ id: tabla.id }).from(tabla).where(and(
      eq(tabla.restauranteId, restauranteId),
      inArray(tabla.id, ids),
    ))
    return rows.length === ids.length
  }

  return {
    async restauranteExiste(restauranteId) {
      const [row] = await db.select({ id: RestauranteTable.id }).from(RestauranteTable)
        .where(eq(RestauranteTable.id, restauranteId)).limit(1)
      return Boolean(row)
    },
    campaniasPertenecen: (restauranteId, ids) => existenTodos(MarketingCampanaTable, restauranteId, ids),
    productosPertenecen: (restauranteId, ids) => existenTodos(ProductoTable, restauranteId, ids),
    pedidosPertenecen: (restauranteId, ids) => existenTodos(PedidoUnificadoTable, restauranteId, ids),
  }
}

function errorTrackingComoHttp(error: ErrorMarketingTracking): { status: 400 | 409; message: string; indiceEvento?: number } {
  if (error.codigo === 'VISITOR_NO_COINCIDE' || error.codigo === 'SESION_EXPIRADA') {
    return { status: 409, message: error.message, indiceEvento: error.indiceEvento }
  }
  return { status: 400, message: error.message, indiceEvento: error.indiceEvento }
}

export function crearMarketingRoute(dependencias: DependenciasMarketingRoute): Hono {
  const route = new Hono()

  route.post('/marketing/events', async (c) => {
    const body = await c.req.json().catch(() => null)
    const validacion = eventosMarketingRequestSchema.safeParse(body)
    if (!validacion.success) {
      return c.json({ success: false, message: 'Payload de eventos de marketing inválido', errors: validacion.error.issues }, 400)
    }

    try {
      const { restauranteId } = validacion.data
      const eventos = await restaurarTouchesDesdeSlug(dependencias, restauranteId, validacion.data.eventos)
      const errorReferencia = await validarReferenciasEventosMarketing(dependencias.referencias, restauranteId, eventos)
      if (errorReferencia) {
        const status = errorReferencia === 'Restaurante no encontrado' ? 404 : 400
        return c.json({ success: false, message: errorReferencia }, status)
      }
      const resultados = await dependencias.guardarEventos(restauranteId, eventos)
      const insertados = resultados.filter((resultado) => resultado.estado === 'insertado').length
      return c.json({
        success: true,
        data: {
          eventos: resultados,
          procesados: resultados.length,
          insertados,
          duplicados: resultados.length - insertados,
        },
      }, 200)
    } catch (error) {
      if (error instanceof ErrorMarketingTracking) {
        const http = errorTrackingComoHttp(error)
        return c.json({ success: false, message: http.message, indiceEvento: http.indiceEvento }, http.status)
      }
      console.error('Error guardando eventos de marketing:', error)
      // El storefront puede reintentar un 503 sin interpretar un error interno
      // como una falla del flujo de compra.
      return c.json({ success: false, message: 'Tracking temporalmente no disponible', retryable: true }, 503)
    }
  })

  return route
}

export const marketingRoute = crearMarketingRoute({
  referencias: crearReferenciasDrizzle(),
  async resolverCampaniasPorSlug(restauranteId, slugs) {
    if (!slugs.length) return new Map()
    const rows = await drizzle(pool).select({ id: MarketingCampanaTable.id, slug: MarketingCampanaTable.slug })
      .from(MarketingCampanaTable).where(and(
        eq(MarketingCampanaTable.restauranteId, restauranteId),
        inArray(MarketingCampanaTable.slug, slugs),
      ))
    return new Map(rows.map((row) => [row.slug, row.id]))
  },
  guardarEventos: (restauranteId, eventos) => guardarEventosMarketing(drizzle(pool), restauranteId, eventos),
})

/**
 * Sólo contiene los datos que el storefront necesita para navegar y trackear.
 * El id de campaña se entrega exclusivamente dentro del contexto analítico;
 * cada evento vuelve a validarlo contra restaurante_id antes de persistir.
 */
export interface CampanaSmartLinkPublica {
  restauranteId: number
  id: number
  nombre: string
  slug: string
  destinoTipo: 'tienda' | 'producto' | 'carrito'
  productoId: number | null
  carritoRep: string | null
  codigoDescuentoId?: number | null
  codigoDescuento?: string | null
  descuentoProductoPorcentaje: number
  limiteUsos: number | null
  usosActuales: number
  fechaInicio: Date | null
  fechaFin: Date | null
  visitas: number
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmTerm: string | null
  utmContent: string | null
}

function beneficioSmartLink(enlace: Pick<CampanaSmartLinkPublica, 'codigoDescuentoId' | 'codigoDescuento'>) {
  return enlace.codigoDescuentoId != null && enlace.codigoDescuento
    ? { codigoDescuentoId: enlace.codigoDescuentoId, codigo: enlace.codigoDescuento }
    : undefined
}

export interface RepositorioSmartLinksMarketing {
  buscarCampanaActiva(username: string, slug: string): Promise<CampanaSmartLinkPublica | null>
}

export interface ContextoSmartLinkMarketing {
  restauranteId: number
  campanaId: number
  visitorId: string
  sesionUuid: string
  eventoUuid: string
}

export interface DependenciasSmartLinksMarketing {
  repositorio: RepositorioSmartLinksMarketing
  enriquecerContexto: (contexto: ContextoSmartLinkMarketing) => Promise<void>
  ahora?: () => Date
}

const smartLinkParamsSchema = z.object({
  username: z.string().trim().min(1).max(255),
  slug: z.string().trim().min(3).max(191).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
})
const smartLinkContextoSchema = z.object({
  visitorId: identificadorSchema.optional(),
  sesionUuid: identificadorSchema.optional(),
  eventoUuid: identificadorSchema.optional(),
})

function destinoSmartLink(campana: CampanaSmartLinkPublica) {
  if (campana.destinoTipo === 'producto' && campana.productoId != null) {
    return { tipo: 'producto' as const, productoId: campana.productoId }
  }
  if (campana.destinoTipo === 'carrito' && campana.carritoRep && /^\d+x\d+(?:-\d+x\d+)*$/.test(campana.carritoRep)) {
    return { tipo: 'carrito' as const, carritoRep: campana.carritoRep }
  }
  return { tipo: 'tienda' as const }
}

function contextoSmartLink(query: unknown, campana: CampanaSmartLinkPublica): ContextoSmartLinkMarketing | null {
  const parsed = smartLinkContextoSchema.safeParse(query)
  if (!parsed.success) return null
  const { visitorId, sesionUuid, eventoUuid } = parsed.data
  // Los tres valores los genera el storefront. No inventamos IDs en el
  // backend: eso conservaría una sesión imposible de continuar desde web.
  if (!visitorId || !sesionUuid || !eventoUuid) return null
  return { restauranteId: campana.restauranteId, campanaId: campana.id, visitorId, sesionUuid, eventoUuid }
}

export function crearMarketingSmartLinksRoute(dependencias: DependenciasSmartLinksMarketing): Hono {
  const route = new Hono()

  route.get('/marketing/campanas/:username/:slug', zValidator('param', smartLinkParamsSchema), async (c) => {
    const { username, slug } = c.req.valid('param')
    const campana = await dependencias.repositorio.buscarCampanaActiva(username, slug)
    const ahora = dependencias.ahora?.() ?? new Date()
    const vigente = Boolean(campana
      && (campana.destinoTipo !== 'producto' || campana.productoId != null)
      && (!campana.fechaInicio || campana.fechaInicio <= ahora)
      && (!campana.fechaFin || campana.fechaFin >= ahora)
      && (campana.limiteUsos == null || campana.usosActuales < campana.limiteUsos))

    // Un link retirado, inexistente o de otro tenant se comporta igual: abre
    // la tienda sin revelar si la campaña existió ni sus identificadores.
    if (!campana || !vigente) return c.json({ success: true, data: { encontrada: false, destino: { tipo: 'tienda' } } })

    const contexto = contextoSmartLink(c.req.query(), campana)
    if (contexto) {
      try {
        await dependencias.enriquecerContexto(contexto)
      } catch (error) {
        // Resolver un Smart Link debe seguir siendo útil aunque tracking esté
        // caído; el navegador podrá reintentar eventos por su cuenta.
        console.error('[marketing] No se pudo enriquecer contexto de Smart Link:', error)
      }
    }

    return c.json({
      success: true,
      data: {
        encontrada: true,
        destino: destinoSmartLink(campana),
        beneficio: beneficioSmartLink(campana),
        campana: campana.productoId == null ? undefined : {
          campanaId: campana.id,
          nombre: campana.nombre,
          slug: campana.slug,
          productoId: campana.productoId,
          descuentoPorcentaje: campana.descuentoProductoPorcentaje,
          limiteUsos: campana.limiteUsos,
          usosActuales: campana.usosActuales,
          usosRestantes: campana.limiteUsos == null ? null : Math.max(0, campana.limiteUsos - campana.usosActuales),
          fechaInicio: campana.fechaInicio?.toISOString() ?? null,
          fechaFin: campana.fechaFin?.toISOString() ?? null,
          visitas: campana.visitas,
        },
        // El ID no concede acceso: el endpoint de eventos vuelve a validar que
        // pertenezca al restaurante. Permite que cada evento conserve el touch
        // aun si la inicialización best-effort de la sesión falló.
        contexto: { campaniaSlug: campana.slug, campanaId: campana.id },
        utms: {
          utmSource: campana.utmSource,
          utmMedium: campana.utmMedium,
          utmCampaign: campana.utmCampaign,
          utmTerm: campana.utmTerm,
          utmContent: campana.utmContent,
        },
      },
    })
  })
  return route
}

function crearRepositorioSmartLinksDrizzle(): RepositorioSmartLinksMarketing {
  const db = drizzle(pool)
  return {
    async buscarCampanaActiva(username, slug) {
      const [campana] = await db.select({
        restauranteId: MarketingCampanaTable.restauranteId,
        id: MarketingCampanaTable.id,
        nombre: MarketingCampanaTable.nombre,
        slug: MarketingCampanaTable.slug,
        destinoTipo: MarketingCampanaTable.destinoTipo,
        productoId: MarketingCampanaTable.productoId,
        carritoRep: MarketingCampanaTable.carritoRep,
        codigoDescuentoId: MarketingCampanaTable.codigoDescuentoId,
        codigoDescuento: CodigoDescuentoTable.codigo,
        descuentoProductoPorcentaje: MarketingCampanaTable.descuentoProductoPorcentaje,
        limiteUsos: MarketingCampanaTable.limiteUsos,
        usosActuales: MarketingCampanaTable.usosActuales,
        fechaInicio: MarketingCampanaTable.fechaInicio,
        fechaFin: MarketingCampanaTable.fechaFin,
        visitas: MarketingCampanaTable.visitas,
        utmSource: MarketingCampanaTable.utmSource,
        utmMedium: MarketingCampanaTable.utmMedium,
        utmCampaign: MarketingCampanaTable.utmCampaign,
        utmTerm: MarketingCampanaTable.utmTerm,
        utmContent: MarketingCampanaTable.utmContent,
      }).from(MarketingCampanaTable)
        .innerJoin(RestauranteTable, eq(MarketingCampanaTable.restauranteId, RestauranteTable.id))
        .leftJoin(CodigoDescuentoTable, and(
          eq(MarketingCampanaTable.codigoDescuentoId, CodigoDescuentoTable.id),
          eq(MarketingCampanaTable.restauranteId, CodigoDescuentoTable.restauranteId),
          eq(CodigoDescuentoTable.activo, true),
        ))
        .where(and(
          eq(RestauranteTable.username, username),
          eq(MarketingCampanaTable.slug, slug),
          eq(MarketingCampanaTable.estado, 'activa'),
        )).limit(1)
      return campana ?? null
    },
  }
}

const marketingSmartLinksRoute = crearMarketingSmartLinksRoute({
  repositorio: crearRepositorioSmartLinksDrizzle(),
  async enriquecerContexto(contexto) {
    const db = drizzle(pool)
    const ahora = new Date()
    const expiraAt = new Date(ahora.getTime() + 30 * 60 * 1000)
    let visitaContada = false
    try {
      let [sesion] = await db.select().from(MarketingSesionTable).where(and(
        eq(MarketingSesionTable.restauranteId, contexto.restauranteId),
        eq(MarketingSesionTable.sesionUuid, contexto.sesionUuid),
      )).limit(1)
      let contarVisita = false
      if (!sesion) {
        const insercion = await db.insert(MarketingSesionTable).values({
          restauranteId: contexto.restauranteId,
          sesionUuid: contexto.sesionUuid,
          visitorId: contexto.visitorId,
          firstTouchTipo: 'campana', firstTouchCampanaId: contexto.campanaId,
          firstTouchRecetaCodigo: null, firstTouchAt: ahora,
          lastTouchTipo: 'campana', lastTouchCampanaId: contexto.campanaId,
          lastTouchRecetaCodigo: null, lastTouchAt: ahora, expiraAt,
        }).ignore()
        contarVisita = Number(insercion[0]?.affectedRows ?? 0) === 1
        ;[sesion] = await db.select().from(MarketingSesionTable).where(and(
          eq(MarketingSesionTable.restauranteId, contexto.restauranteId),
          eq(MarketingSesionTable.sesionUuid, contexto.sesionUuid),
        )).limit(1)
      }
      if (!sesion || sesion.visitorId !== contexto.visitorId) throw new Error('Sesión de campaña inválida')
      if (!contarVisita) {
        contarVisita = sesion.lastTouchCampanaId !== contexto.campanaId || sesion.expiraAt < ahora
        await db.update(MarketingSesionTable).set({
          lastTouchTipo: 'campana', lastTouchCampanaId: contexto.campanaId,
          lastTouchRecetaCodigo: null, lastTouchAt: ahora, expiraAt,
        }).where(and(eq(MarketingSesionTable.restauranteId, contexto.restauranteId), eq(MarketingSesionTable.id, sesion.id)))
      }
      if (contarVisita) {
        await db.update(MarketingCampanaTable)
          .set({ visitas: sql`${MarketingCampanaTable.visitas} + 1` })
          .where(and(eq(MarketingCampanaTable.restauranteId, contexto.restauranteId), eq(MarketingCampanaTable.id, contexto.campanaId)))
        visitaContada = true
      }
    } catch (error) {
      // La analítica de sesión es best-effort; aun si esa tabla falla, la
      // apertura real del Smart Link no debe perderse del contador compacto.
      if (!visitaContada) {
        await db.update(MarketingCampanaTable)
          .set({ visitas: sql`${MarketingCampanaTable.visitas} + 1` })
          .where(and(eq(MarketingCampanaTable.restauranteId, contexto.restauranteId), eq(MarketingCampanaTable.id, contexto.campanaId)))
      }
      throw error
    }
  },
})

/** El resolver público no devuelve cliente, teléfono, cupón ni texto interno. */
export interface EnlaceRecetaPublico {
  restauranteId: number
  tokenHash: string
  recetaCodigo: string | null
  destinoTipo: 'tienda' | 'producto' | 'carrito'
  productoId: number | null
  carritoRep: string | null
  codigoDescuentoId?: number | null
  codigoDescuento?: string | null
}

export interface RepositorioRecetasPublicasMarketing {
  buscarEnlaceActivo(username: string, tokenHash: string, ahora: Date): Promise<EnlaceRecetaPublico | null>
}

export interface ContextoRecetaPublicaMarketing {
  restauranteId: number
  recetaCodigo: string
  visitorId: string
  sesionUuid: string
  eventoUuid: string
}

export interface DependenciasRecetasPublicasMarketing {
  repositorio: RepositorioRecetasPublicasMarketing
  enriquecerContexto: (contexto: ContextoRecetaPublicaMarketing) => Promise<void>
  ahora?: () => Date
}

const tokenRecetaPublicoRegex = /^[A-Za-z0-9_-]{20,200}$/

function fallbackRecetaPublica() {
  // Misma respuesta para token inválido, vencido, inactivo o de otro tenant.
  return { success: true, data: { encontrada: false, destino: { tipo: 'tienda' as const } } }
}

function contextoRecetaPublica(query: unknown, enlace: EnlaceRecetaPublico): ContextoRecetaPublicaMarketing | null {
  const parsed = smartLinkContextoSchema.safeParse(query)
  if (!parsed.success || !enlace.recetaCodigo) return null
  const { visitorId, sesionUuid, eventoUuid } = parsed.data
  if (!visitorId || !sesionUuid || !eventoUuid) return null
  return { restauranteId: enlace.restauranteId, recetaCodigo: enlace.recetaCodigo, visitorId, sesionUuid, eventoUuid }
}

export function crearMarketingRecetasPublicasRoute(dependencias: DependenciasRecetasPublicasMarketing): Hono {
  const route = new Hono()
  route.get('/marketing/recetas/:username/:token', async (c) => {
    const { username, token } = c.req.param()
    if (!username?.trim() || !tokenRecetaPublicoRegex.test(token ?? '')) return c.json(fallbackRecetaPublica())

    const tokenHash = hashTokenMarketing(token)
    const enlace = await dependencias.repositorio.buscarEnlaceActivo(username, tokenHash, dependencias.ahora?.() ?? new Date())
    // La comprobación segura es necesaria incluso luego del lookup indexado;
    // tampoco se confía en un repositorio alternativo durante pruebas/futuros usos.
    if (!enlace || !coincideTokenMarketingSeguro(token, enlace.tokenHash)) return c.json(fallbackRecetaPublica())

    const contexto = contextoRecetaPublica(c.req.query(), enlace)
    if (contexto) {
      try {
        await dependencias.enriquecerContexto(contexto)
      } catch (error) {
        console.error('[marketing] No se pudo enriquecer contexto de receta:', error)
      }
    }
    return c.json({
      success: true,
      data: {
        encontrada: true,
        destino: destinoSmartLink(enlace),
        beneficio: beneficioSmartLink(enlace),
        // La receta es contexto comercial, no identidad. El cliente asociado
        // al enlace nunca cruza el borde público.
        contexto: enlace.recetaCodigo ? { recetaCodigo: enlace.recetaCodigo } : undefined,
      },
    })
  })
  return route
}

function crearRepositorioRecetasPublicasDrizzle(): RepositorioRecetasPublicasMarketing {
  const db = drizzle(pool)
  return {
    async buscarEnlaceActivo(username, tokenHash, ahora) {
      const [enlace] = await db.select({
        restauranteId: MarketingEnlaceTable.restauranteId,
        tokenHash: MarketingEnlaceTable.tokenHash,
        recetaCodigo: MarketingEnlaceTable.recetaCodigo,
        destinoTipo: MarketingEnlaceTable.destinoTipo,
        productoId: MarketingEnlaceTable.productoId,
        carritoRep: MarketingEnlaceTable.carritoRep,
        codigoDescuentoId: MarketingEnlaceTable.codigoDescuentoId,
        codigoDescuento: CodigoDescuentoTable.codigo,
      }).from(MarketingEnlaceTable)
        .innerJoin(RestauranteTable, eq(MarketingEnlaceTable.restauranteId, RestauranteTable.id))
        .leftJoin(CodigoDescuentoTable, and(
          eq(MarketingEnlaceTable.codigoDescuentoId, CodigoDescuentoTable.id),
          eq(MarketingEnlaceTable.restauranteId, CodigoDescuentoTable.restauranteId),
          eq(CodigoDescuentoTable.activo, true),
        ))
        .where(and(
          eq(RestauranteTable.username, username),
          eq(MarketingEnlaceTable.tokenHash, tokenHash),
          eq(MarketingEnlaceTable.activo, true),
          or(isNull(MarketingEnlaceTable.expiraAt), gt(MarketingEnlaceTable.expiraAt, ahora)),
        )).limit(1)
      return enlace ?? null
    },
  }
}

const marketingRecetasPublicRoute = crearMarketingRecetasPublicasRoute({
  repositorio: crearRepositorioRecetasPublicasDrizzle(),
  async enriquecerContexto(contexto) {
    await guardarEventosMarketing(drizzle(pool), contexto.restauranteId, [{
      eventoUuid: contexto.eventoUuid,
      sesionUuid: contexto.sesionUuid,
      visitorId: contexto.visitorId,
      tipo: 'session_start',
      ocurridoAt: new Date(),
      touch: { tipo: 'receta', recetaCodigo: contexto.recetaCodigo },
    }])
  },
})

// Se conserva el export histórico y se montan los resolvedores públicos junto
// al endpoint de eventos, bajo el mismo prefijo /public del servidor.
export const marketingPublicRoute = new Hono()
  .route('/', marketingRoute)
  .route('/', marketingSmartLinksRoute)
  .route('/', marketingRecetasPublicRoute)

const recetaCodigos = Object.values(RECETAS_CRECIMIENTO).map((receta) => receta.codigo) as [string, ...string[]]
const slugSchema = z.string().trim().min(3).max(191)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'El slug sólo admite minúsculas, números y guiones')
const textoOpcionalSchema = z.string().trim().min(1).max(255).nullable().optional().transform((valor) => valor ?? null)
const inversionSchema = z.union([z.number(), z.string().regex(/^\d+(?:\.\d{1,2})?$/)])
  .transform((valor) => Number(valor)).refine((valor) => Number.isFinite(valor) && valor >= 0 && valor <= 999999999999.99)
const fechaOpcionalSchema = z.coerce.date().nullable().optional().transform((valor) => valor ?? null)

const camposCampanaSchema = z.object({
  nombre: z.string().trim().min(1).max(255),
  tipo: z.enum(['adquisicion', 'recompra']),
  recetaCodigo: z.enum(recetaCodigos).nullable().optional().transform((valor) => valor ?? null),
  estado: z.enum(['borrador', 'activa', 'inactiva']).optional(),
  destinoTipo: z.enum(['tienda', 'producto', 'carrito']),
  productoId: z.number().int().positive().nullable().optional(),
  carritoRep: z.string().trim().max(2048).nullable().optional(),
  codigoDescuentoId: z.number().int().positive().nullable().optional(),
  descuentoProductoPorcentaje: z.number().int().min(0).max(100).optional(),
  limiteUsos: z.number().int().positive().nullable().optional(),
  fechaInicio: fechaOpcionalSchema,
  fechaFin: fechaOpcionalSchema,
  utmSource: textoOpcionalSchema,
  utmMedium: textoOpcionalSchema,
  utmCampaign: textoOpcionalSchema,
  utmTerm: textoOpcionalSchema,
  utmContent: textoOpcionalSchema,
  inversionManual: inversionSchema.optional(),
  usaGrupoControl: z.boolean().optional(),
}).superRefine((valor, ctx) => {
  if (valor.destinoTipo === 'producto' && !valor.productoId) {
    ctx.addIssue({ code: 'custom', path: ['productoId'], message: 'El destino producto requiere productoId' })
  }
  if (valor.destinoTipo === 'carrito' && !valor.carritoRep) {
    ctx.addIssue({ code: 'custom', path: ['carritoRep'], message: 'El destino carrito requiere carritoRep' })
  }
  if (valor.carritoRep && !/^\d+x\d+(?:-\d+x\d+)*$/.test(valor.carritoRep)) {
    ctx.addIssue({ code: 'custom', path: ['carritoRep'], message: 'El carrito no tiene el formato canónico' })
  }
  if (valor.fechaInicio && valor.fechaFin && valor.fechaFin <= valor.fechaInicio) {
    ctx.addIssue({ code: 'custom', path: ['fechaFin'], message: 'La fecha de fin debe ser posterior al inicio' })
  }
})

const crearCampanaSchema = camposCampanaSchema.extend({ slug: slugSchema })
const editarCampanaSchema = camposCampanaSchema.partial().extend({
  // El slug es estable: no se acepta ni siquiera como campo ignorado.
  slug: z.never().optional(),
}).refine((valor) => Object.keys(valor).some((clave) => clave !== 'slug'), 'No hay datos para actualizar')

type CampanaInput = z.infer<typeof camposCampanaSchema>
type CampanaCreadaInput = CampanaInput & { slug: string }

export interface RepositorioCampanasMarketing {
  listar(restauranteId: number): Promise<unknown[]>
  buscar(restauranteId: number, id: number): Promise<any | null>
  slugExiste(restauranteId: number, slug: string): Promise<boolean>
  productoPertenece(restauranteId: number, productoId: number): Promise<boolean>
  codigoPertenece(restauranteId: number, codigoId: number): Promise<boolean>
  crear(restauranteId: number, input: CampanaCreadaInput): Promise<unknown>
  actualizar(restauranteId: number, id: number, input: Partial<CampanaInput>): Promise<unknown>
  desactivar(restauranteId: number, id: number): Promise<unknown>
  tieneAtribucion(restauranteId: number, id: number): Promise<boolean>
  borrar(restauranteId: number, id: number): Promise<void>
}

function valoresCampana(input: Partial<CampanaInput>) {
  const valores: Record<string, unknown> = {}
  const campos = ['nombre', 'tipo', 'recetaCodigo', 'estado', 'destinoTipo', 'productoId', 'carritoRep', 'codigoDescuentoId', 'descuentoProductoPorcentaje', 'limiteUsos', 'fechaInicio', 'fechaFin', 'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent', 'usaGrupoControl'] as const
  for (const campo of campos) if (input[campo] !== undefined) valores[campo] = input[campo]
  if (input.inversionManual !== undefined) valores.inversionManual = input.inversionManual.toFixed(2)
  return valores
}

function crearRepositorioCampanasDrizzle(): RepositorioCampanasMarketing {
  const db = drizzle(pool)
  const buscar = async (restauranteId: number, id: number) => {
    const [campana] = await db.select().from(MarketingCampanaTable).where(and(
      eq(MarketingCampanaTable.restauranteId, restauranteId), eq(MarketingCampanaTable.id, id),
    )).limit(1)
    return campana ?? null
  }
  return {
    listar: (restauranteId) => db.select().from(MarketingCampanaTable)
      .where(eq(MarketingCampanaTable.restauranteId, restauranteId)).orderBy(MarketingCampanaTable.createdAt),
    buscar,
    async slugExiste(restauranteId, slug) {
      const [campana] = await db.select({ id: MarketingCampanaTable.id }).from(MarketingCampanaTable).where(and(
        eq(MarketingCampanaTable.restauranteId, restauranteId), eq(MarketingCampanaTable.slug, slug),
      )).limit(1)
      return Boolean(campana)
    },
    async productoPertenece(restauranteId, productoId) {
      const [producto] = await db.select({ id: ProductoTable.id }).from(ProductoTable).where(and(
        eq(ProductoTable.restauranteId, restauranteId), eq(ProductoTable.id, productoId),
      )).limit(1)
      return Boolean(producto)
    },
    async codigoPertenece(restauranteId, codigoId) {
      const [codigo] = await db.select({ id: CodigoDescuentoTable.id }).from(CodigoDescuentoTable).where(and(
        eq(CodigoDescuentoTable.restauranteId, restauranteId), eq(CodigoDescuentoTable.id, codigoId),
      )).limit(1)
      return Boolean(codigo)
    },
    async crear(restauranteId, input) {
      const ahora = new Date()
      const estado = input.estado ?? 'borrador'
      const resultado = await db.insert(MarketingCampanaTable).values({
        restauranteId, slug: input.slug, nombre: input.nombre, tipo: input.tipo,
        ...valoresCampana(input), estado,
        activadaAt: estado === 'activa' ? ahora : null,
        desactivadaAt: estado === 'inactiva' ? ahora : null,
      } as any)
      return (await buscar(restauranteId, Number(resultado[0].insertId)))!
    },
    async actualizar(restauranteId, id, input) {
      const previo = await buscar(restauranteId, id)
      if (!previo) throw new Error('NOT_FOUND')
      const valores = valoresCampana(input)
      const ahora = new Date()
      if (input.estado === 'activa' && previo.estado !== 'activa') {
        valores.activadaAt = ahora; valores.desactivadaAt = null
      }
      if (input.estado === 'inactiva' && previo.estado !== 'inactiva') valores.desactivadaAt = ahora
      valores.updatedAt = ahora
      await db.update(MarketingCampanaTable).set(valores as any).where(and(eq(MarketingCampanaTable.id, id), eq(MarketingCampanaTable.restauranteId, restauranteId)))
      return (await buscar(restauranteId, id))!
    },
    async desactivar(restauranteId, id) {
      return this.actualizar(restauranteId, id, { estado: 'inactiva' })
    },
    async tieneAtribucion(restauranteId, id) {
      const [atribucion, pedido] = await Promise.all([
        db.select({ id: PedidoMarketingAtribucionTable.id }).from(PedidoMarketingAtribucionTable)
          .where(and(
            eq(PedidoMarketingAtribucionTable.restauranteId, restauranteId),
            eq(PedidoMarketingAtribucionTable.campanaId, id),
          )).limit(1),
        db.select({ id: PedidoUnificadoTable.id }).from(PedidoUnificadoTable)
          .where(and(
            eq(PedidoUnificadoTable.restauranteId, restauranteId),
            eq(PedidoUnificadoTable.marketingCampanaId, id),
          )).limit(1),
      ])
      return Boolean(atribucion[0] || pedido[0])
    },
    async borrar(restauranteId, id) {
      await db.delete(MarketingCampanaTable).where(and(eq(MarketingCampanaTable.id, id), eq(MarketingCampanaTable.restauranteId, restauranteId)))
    },
  }
}

async function validarReferenciasCampana(repositorio: RepositorioCampanasMarketing, restauranteId: number, input: Partial<CampanaInput>) {
  if (input.productoId != null && !await repositorio.productoPertenece(restauranteId, input.productoId)) return 'El producto no pertenece al restaurante'
  if (input.codigoDescuentoId != null && !await repositorio.codigoPertenece(restauranteId, input.codigoDescuentoId)) return 'El código de descuento no pertenece al restaurante'
  return null
}

const idParamSchema = z.object({ id: z.coerce.number().int().positive() })

export function crearMarketingCampanasRoute(
  repositorio: RepositorioCampanasMarketing,
  middlewares: MiddlewareHandler[] = [],
) {
  const route = new Hono()
  for (const middleware of middlewares) route.use('*', middleware)

  route.get('/campanas', async (c) => c.json({ success: true, data: await repositorio.listar((c as any).user.id) }))
  route.post('/campanas', zValidator('json', crearCampanaSchema), async (c) => {
    const restauranteId = (c as any).user.id as number; const input = c.req.valid('json')
    if (await repositorio.slugExiste(restauranteId, input.slug)) return c.json({ success: false, message: 'Ya existe una campaña con ese slug' }, 409)
    const error = await validarReferenciasCampana(repositorio, restauranteId, input)
    if (error) return c.json({ success: false, message: error }, 400)
    return c.json({ success: true, data: await repositorio.crear(restauranteId, input) }, 201)
  })
  route.get('/campanas/:id', zValidator('param', idParamSchema), async (c) => {
    const campana = await repositorio.buscar((c as any).user.id, c.req.valid('param').id)
    return campana ? c.json({ success: true, data: campana }) : c.json({ success: false, message: 'Campaña no encontrada' }, 404)
  })
  route.put('/campanas/:id', zValidator('param', idParamSchema), zValidator('json', editarCampanaSchema), async (c) => {
    const restauranteId = (c as any).user.id as number; const id = c.req.valid('param').id; const input = c.req.valid('json')
    if (!await repositorio.buscar(restauranteId, id)) return c.json({ success: false, message: 'Campaña no encontrada' }, 404)
    const error = await validarReferenciasCampana(repositorio, restauranteId, input)
    if (error) return c.json({ success: false, message: error }, 400)
    return c.json({ success: true, data: await repositorio.actualizar(restauranteId, id, input) })
  })
  route.post('/campanas/:id/desactivar', zValidator('param', idParamSchema), async (c) => {
    const campana = await repositorio.buscar((c as any).user.id, c.req.valid('param').id)
    if (!campana) return c.json({ success: false, message: 'Campaña no encontrada' }, 404)
    return c.json({ success: true, data: await repositorio.desactivar((c as any).user.id, c.req.valid('param').id) })
  })
  route.delete('/campanas/:id', zValidator('param', idParamSchema), async (c) => {
    const restauranteId = (c as any).user.id as number; const id = c.req.valid('param').id
    if (!await repositorio.buscar(restauranteId, id)) return c.json({ success: false, message: 'Campaña no encontrada' }, 404)
    if (await repositorio.tieneAtribucion(restauranteId, id)) {
      const campana = await repositorio.desactivar(restauranteId, id)
      return c.json({ success: true, desactivada: true, data: campana, message: 'La campaña tiene atribución y fue desactivada' })
    }
    await repositorio.borrar(restauranteId, id)
    return c.json({ success: true, eliminada: true })
  })
  return route
}

const idempotenciaSchema = z.string().trim().min(8).max(128)
const prepararEnlaceSchema = z.object({
  clienteId: z.number().int().positive(),
  campanaId: z.number().int().positive().nullable().optional(),
  recetaCodigo: z.enum(recetaCodigos).optional(),
  codigoDescuentoId: z.number().int().positive().nullable().optional(),
  incentivo: z.object({
    descuentoPorcentaje: z.number().int().min(0).max(100),
    expiraHoras: z.number().int().positive().max(24 * 30).nullable(),
  }).optional(),
  incentivoConfirmado: z.boolean().optional(),
  expiraEnHoras: z.number().int().positive().max(24 * 30).optional(),
  idempotenciaClave: idempotenciaSchema,
}).strict()

function crearRepositorioEnlacesDrizzle(): RepositorioEnlacesMarketing {
  const db = drizzle(pool)
  return {
    async buscarPorIdempotencia(restauranteId, clave) {
      const [enlace] = await db.select().from(MarketingEnlaceTable).where(and(
        eq(MarketingEnlaceTable.restauranteId, restauranteId),
        eq(MarketingEnlaceTable.idempotenciaClave, clave),
      )).limit(1)
      return enlace ?? null
    },
    async cargarCliente(restauranteId, clienteId) {
      const [cliente] = await db.select().from(ClienteTable).where(and(
        eq(ClienteTable.restauranteId, restauranteId), eq(ClienteTable.id, clienteId),
      )).limit(1)
      if (!cliente) return null

      // RFM depende de la distribución del local: se calcula para todos los
      // clientes en un único batch, igual que la pantalla existente de Clientes.
      const clientes = await db.select({ id: ClienteTable.id }).from(ClienteTable)
        .where(eq(ClienteTable.restauranteId, restauranteId))
      const pedidos = await db.select({
        id: PedidoUnificadoTable.id, clienteId: PedidoUnificadoTable.clienteId,
        total: PedidoUnificadoTable.total, createdAt: PedidoUnificadoTable.createdAt,
      }).from(PedidoUnificadoTable).where(and(
        eq(PedidoUnificadoTable.restauranteId, restauranteId),
        ne(PedidoUnificadoTable.estado, 'cancelled'),
      ))
      const porCliente = new Map<number, { cantidadPedidos: number; totalGastado: number; fechasPedidos: number[] }>()
      for (const fila of pedidos) {
        if (fila.clienteId == null) continue
        const actual = porCliente.get(fila.clienteId) ?? { cantidadPedidos: 0, totalGastado: 0, fechasPedidos: [] }
        actual.cantidadPedidos += 1
        actual.totalGastado += Number(fila.total)
        actual.fechasPedidos.push(new Date(fila.createdAt).getTime())
        porCliente.set(fila.clienteId, actual)
      }
      const perfiles = computarPerfilesRFM(clientes.map((fila) => porCliente.get(fila.id) ?? {
        cantidadPedidos: 0, totalGastado: 0, fechasPedidos: [],
      }))
      const perfil = perfiles[clientes.findIndex((fila) => fila.id === clienteId)]
      if (!perfil) return null

      const pedidosCliente = pedidos.filter((fila) => fila.clienteId === clienteId)
      const ultimoPedido = pedidosCliente.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
      const idsPedidos = pedidosCliente.map((fila) => fila.id)
      const items = idsPedidos.length
        ? await db.select({ pedidoId: ItemPedidoUnificadoTable.pedidoId, productoId: ItemPedidoUnificadoTable.productoId, cantidad: ItemPedidoUnificadoTable.cantidad })
          .from(ItemPedidoUnificadoTable).where(inArray(ItemPedidoUnificadoTable.pedidoId, idsPedidos))
        : []
      const productoIds = [...new Set(items.map((item) => item.productoId))]
      const productos = productoIds.length
        ? await db.select({ id: ProductoTable.id, nombre: ProductoTable.nombre }).from(ProductoTable).where(and(
          eq(ProductoTable.restauranteId, restauranteId), inArray(ProductoTable.id, productoIds),
        ))
        : []
      const productosDisponibles = new Map(productos.map((producto) => [producto.id, producto]))
      const conteo = new Map<number, number>()
      for (const item of items) conteo.set(item.productoId, (conteo.get(item.productoId) ?? 0) + (item.cantidad ?? 1))
      const favoritoId = [...conteo.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      const favorito = favoritoId != null ? productosDisponibles.get(favoritoId) : null
      const ultimoCarrito = ultimoPedido
        ? items.filter((item) => item.pedidoId === ultimoPedido.id && productosDisponibles.has(item.productoId))
          .map((item) => ({ productoId: item.productoId, cantidad: item.cantidad ?? 1 }))
        : []
      return {
        clienteId,
        segmento: perfil.segmento,
        esVip: perfil.esVip,
        ultimoCarrito,
        productoFavorito: favorito ? { productoId: favorito.id, nombre: favorito.nombre } : null,
      }
    },
    async buscarCampana(restauranteId, campanaId) {
      const [campana] = await db.select({ id: MarketingCampanaTable.id, recetaCodigo: MarketingCampanaTable.recetaCodigo })
        .from(MarketingCampanaTable).where(and(
          eq(MarketingCampanaTable.restauranteId, restauranteId), eq(MarketingCampanaTable.id, campanaId),
        )).limit(1)
      return campana ?? null
    },
    async codigoPertenece(restauranteId, codigoDescuentoId) {
      const [codigo] = await db.select({ id: CodigoDescuentoTable.id }).from(CodigoDescuentoTable).where(and(
        eq(CodigoDescuentoTable.restauranteId, restauranteId), eq(CodigoDescuentoTable.id, codigoDescuentoId),
      )).limit(1)
      return Boolean(codigo)
    },
    async crearCupon(restauranteId, input) {
      const [existente] = await db.select({ id: CodigoDescuentoTable.id }).from(CodigoDescuentoTable).where(and(
        eq(CodigoDescuentoTable.restauranteId, restauranteId), eq(CodigoDescuentoTable.codigo, input.codigo),
      )).limit(1)
      if (existente) {
        const error: any = new Error('Código de cupón ya reservado')
        error.code = 'ER_DUP_ENTRY'
        throw error
      }
      const resultado = await db.insert(CodigoDescuentoTable).values({
        restauranteId, codigo: input.codigo, tipo: 'porcentaje', valor: String(input.descuentoPorcentaje),
        limiteUsos: 1, usosActuales: 0, montoMinimo: '0.00', fechaInicio: new Date(), fechaFin: input.expiraAt, activo: true,
      })
      return { id: Number(resultado[0].insertId) }
    },
    async sacarClienteDeControl(restauranteId, clienteId) {
      const [campana] = await db.select({ id: CampanaRecompraTable.id }).from(CampanaRecompraTable).where(and(
        eq(CampanaRecompraTable.restauranteId, restauranteId),
        inArray(CampanaRecompraTable.estado, ['activa', 'pausada_manual', 'pausada_sin_saldo', 'completada']),
      )).orderBy(desc(CampanaRecompraTable.createdAt)).limit(1)
      if (!campana) return
      await db.update(ColaRecompraTable).set({ rol: 'contactado', estado: 'enviado', enviadoAt: new Date() }).where(and(
        eq(ColaRecompraTable.campanaId, campana.id), eq(ColaRecompraTable.clienteId, clienteId),
        inArray(ColaRecompraTable.rol, ['control']),
      ))
    },
    async crearEnlace(input) {
      const resultado = await db.insert(MarketingEnlaceTable).values(input)
      const [enlace] = await db.select().from(MarketingEnlaceTable).where(and(
        eq(MarketingEnlaceTable.restauranteId, input.restauranteId), eq(MarketingEnlaceTable.id, Number(resultado[0].insertId)),
      )).limit(1)
      return enlace!
    },
  }
}

export function crearMarketingEnlacesRoute(
  repositorio: RepositorioEnlacesMarketing,
  middlewares: MiddlewareHandler[] = [],
) {
  const route = new Hono()
  for (const middleware of middlewares) route.use('*', middleware)
  route.post('/enlaces', zValidator('json', prepararEnlaceSchema), async (c) => {
    try {
      const resultado = await prepararEnlaceMarketing(repositorio, (c as any).user.id, c.req.valid('json'))
      return c.json({ success: true, data: {
        enlace: resultado.enlace,
        token: resultado.token || undefined,
        idempotente: resultado.idempotente,
        receta: resultado.recomendacion.receta,
        destino: resultado.recomendacion.destino,
        textoSugerido: resultado.recomendacion.textoSugerido,
      } }, resultado.idempotente ? 200 : 201)
    } catch (error) {
      if (error instanceof ErrorPrepararEnlaceMarketing) {
        const status = error.codigo === 'CLIENTE_NO_ENCONTRADO' || error.codigo === 'CAMPANA_NO_ENCONTRADA' || error.codigo === 'CUPON_NO_ENCONTRADO' ? 404 : 400
        return c.json({ success: false, code: error.codigo, message: error.message }, status)
      }
      console.error('Error preparando enlace de marketing:', error)
      return c.json({ success: false, message: 'No se pudo preparar el enlace' }, 500)
    }
  })
  return route
}

type CanalContactoMarketing = 'copiado' | 'wa_me'
type EstadoContactoMarketing = 'preparado' | 'abierto'

export interface EnlaceParaContactoMarketing {
  id: number
  restauranteId: number
  clienteId: number | null
  tokenHash: string
  textoSugerido: string | null
  telefono: string | null
  marketingOptOut: boolean
  username: string
  activo: boolean
  expiraAt: Date | null
}

export interface ContactoMarketingPersistido {
  id: number
  enlaceId: number
  canal: CanalContactoMarketing
  estado: EstadoContactoMarketing
  idempotenciaClave: string
}

export interface RepositorioContactosMarketing {
  buscarEnlace(restauranteId: number, enlaceId: number): Promise<EnlaceParaContactoMarketing | null>
  buscarContactoPorIdempotencia(restauranteId: number, clave: string): Promise<ContactoMarketingPersistido | null>
  cargarToques(restauranteId: number, clienteId: number, desde: Date): Promise<{ createdAt: Date }[]>
  sacarClienteDeControl(restauranteId: number, clienteId: number): Promise<void>
  crearContacto(input: {
    restauranteId: number
    enlaceId: number
    clienteId: number
    canal: CanalContactoMarketing
    estado: EstadoContactoMarketing
    idempotenciaClave: string
  }): Promise<ContactoMarketingPersistido>
}

const contactoSchema = z.object({
  token: z.string().trim().min(20).max(200).regex(tokenRecetaPublicoRegex),
  idempotenciaClave: idempotenciaSchema,
}).strict()

function telefonoWaMe(telefono: string | null): string | null {
  const normalizado = (telefono ?? '').replace(/\D/g, '')
  // wa.me requiere formato internacional E.164 sin el signo +. Nunca se
  // devuelve el teléfono al admin: sólo se incorpora en la URL de apertura.
  return /^\d{8,15}$/.test(normalizado) ? normalizado : null
}

function urlEnlaceReceta(username: string, token: string): string {
  return `https://my.piru.app/${encodeURIComponent(username)}/r/${encodeURIComponent(token)}`
}

function urlWaMe(telefono: string, texto: string): string {
  return `https://wa.me/${telefono}?text=${encodeURIComponent(texto)}`
}

/**
 * Copiar y abrir WhatsApp son facilitaciones humanas, nunca entregas: no
 * llaman al wallet ni reportan un mensaje enviado. La clave de idempotencia
 * hace que reintentos no inflen los contactos ni la presión comercial.
 */
export function crearMarketingContactosRoute(
  repositorio: RepositorioContactosMarketing,
  middlewares: MiddlewareHandler[] = [],
  ahora: () => Date = () => new Date(),
) {
  const route = new Hono()
  for (const middleware of middlewares) route.use('*', middleware)

  const registrar = (canal: CanalContactoMarketing, estado: EstadoContactoMarketing) => async (c: any) => {
    const restauranteId = c.user.id as number
    const enlaceId = Number(c.req.param('id'))
    const input = c.req.valid('json') as z.infer<typeof contactoSchema>
    const enlace = await repositorio.buscarEnlace(restauranteId, enlaceId)
    if (!enlace || !enlace.activo || (enlace.expiraAt != null && enlace.expiraAt <= ahora()) || enlace.clienteId == null) {
      return c.json({ success: false, message: 'Enlace no disponible para contacto' }, 404)
    }
    if (!coincideTokenMarketingSeguro(input.token, enlace.tokenHash)) {
      return c.json({ success: false, message: 'Enlace no disponible para contacto' }, 404)
    }

    const existente = await repositorio.buscarContactoPorIdempotencia(restauranteId, input.idempotenciaClave)
    if (existente) {
      if (existente.enlaceId !== enlace.id || existente.canal !== canal) {
        return c.json({ success: false, message: 'La clave de idempotencia ya pertenece a otra acción' }, 409)
      }
      const url = urlEnlaceReceta(enlace.username, input.token)
      const telefono = canal === 'wa_me' ? telefonoWaMe(enlace.telefono) : null
      if (canal === 'wa_me' && !telefono) return c.json({ success: false, code: 'telefono_invalido', message: 'El cliente no tiene un teléfono válido para WhatsApp' }, 422)
      return c.json({ success: true, data: {
        contacto: existente,
        url,
        waMeUrl: telefono ? urlWaMe(telefono, `${enlace.textoSugerido ?? ''}\n\n${url}`.trim()) : undefined,
        entregado: false,
        idempotente: true,
      } })
    }

    const instante = ahora()
    const desde = new Date(instante.getTime() - VENTANA_TOPE_DIAS * 24 * 60 * 60 * 1000)
    const proteccion = chequearProteccionMarketing({
      optOut: enlace.marketingOptOut,
      toques: await repositorio.cargarToques(restauranteId, enlace.clienteId, desde),
      ahora: instante.getTime(),
    })
    if (!proteccion.permitido) return c.json({ success: false, code: proteccion.motivo, message: proteccion.mensaje }, 409)

    const toques = await repositorio.cargarToques(restauranteId, enlace.clienteId, new Date(0))
    const ultimoToque = toques.reduce<Date | null>((ultimo, toque) => !ultimo || toque.createdAt > ultimo ? toque.createdAt : ultimo, null)
    if (ultimoToque && instante.getTime() - ultimoToque.getTime() < COOLDOWN_HORAS * 60 * 60 * 1000) {
      return c.json({ success: false, code: 'cooldown', message: `Esperá ${COOLDOWN_HORAS} hs antes de volver a contactar a este cliente` }, 409)
    }

    const telefono = canal === 'wa_me' ? telefonoWaMe(enlace.telefono) : null
    if (canal === 'wa_me' && !telefono) return c.json({ success: false, code: 'telefono_invalido', message: 'El cliente no tiene un teléfono válido para WhatsApp' }, 422)

    // La preparación ya hace esta reclasificación, pero repetirla aquí protege
    // enlaces legacy y mantiene la invariancia antes de toda facilitación.
    await repositorio.sacarClienteDeControl(restauranteId, enlace.clienteId)
    let contacto: ContactoMarketingPersistido
    try {
      contacto = await repositorio.crearContacto({ restauranteId, enlaceId: enlace.id, clienteId: enlace.clienteId, canal, estado, idempotenciaClave: input.idempotenciaClave })
    } catch (error: any) {
      // La unicidad DB es la última barrera ante doble click concurrente. Si
      // otra request ganó la carrera, devolvemos su mismo resultado y no
      // transformamos un reintento seguro en un error 500.
      if (error?.code !== 'ER_DUP_ENTRY') throw error
      const creadoEnParalelo = await repositorio.buscarContactoPorIdempotencia(restauranteId, input.idempotenciaClave)
      if (!creadoEnParalelo || creadoEnParalelo.enlaceId !== enlace.id || creadoEnParalelo.canal !== canal) throw error
      const url = urlEnlaceReceta(enlace.username, input.token)
      const texto = `${enlace.textoSugerido ?? ''}\n\n${url}`.trim()
      return c.json({ success: true, data: { contacto: creadoEnParalelo, url, waMeUrl: telefono ? urlWaMe(telefono, texto) : undefined, entregado: false, idempotente: true } })
    }
    const url = urlEnlaceReceta(enlace.username, input.token)
    const texto = `${enlace.textoSugerido ?? ''}\n\n${url}`.trim()
    return c.json({ success: true, data: {
      contacto,
      url,
      waMeUrl: telefono ? urlWaMe(telefono, texto) : undefined,
      // `abierto` es intención de abrir el composer; nunca se comunica como entrega.
      entregado: false,
      idempotente: false,
    } }, 201)
  }

  route.post('/enlaces/:id/copiar', zValidator('param', idParamSchema), zValidator('json', contactoSchema), registrar('copiado', 'preparado'))
  route.post('/enlaces/:id/wa-me', zValidator('param', idParamSchema), zValidator('json', contactoSchema), registrar('wa_me', 'abierto'))
  return route
}

function crearRepositorioContactosDrizzle(): RepositorioContactosMarketing {
  const db = drizzle(pool)
  return {
    async buscarEnlace(restauranteId, enlaceId) {
      const [enlace] = await db.select({
        id: MarketingEnlaceTable.id, restauranteId: MarketingEnlaceTable.restauranteId,
        clienteId: MarketingEnlaceTable.clienteId, tokenHash: MarketingEnlaceTable.tokenHash,
        textoSugerido: MarketingEnlaceTable.textoSugerido, activo: MarketingEnlaceTable.activo,
        expiraAt: MarketingEnlaceTable.expiraAt, telefono: ClienteTable.telefono,
        marketingOptOut: ClienteTable.marketingOptOut, username: RestauranteTable.username,
      }).from(MarketingEnlaceTable)
        .innerJoin(RestauranteTable, eq(RestauranteTable.id, MarketingEnlaceTable.restauranteId))
        .leftJoin(ClienteTable, and(eq(ClienteTable.id, MarketingEnlaceTable.clienteId), eq(ClienteTable.restauranteId, MarketingEnlaceTable.restauranteId)))
        .where(and(eq(MarketingEnlaceTable.restauranteId, restauranteId), eq(MarketingEnlaceTable.id, enlaceId))).limit(1)
      return enlace ?? null
    },
    async buscarContactoPorIdempotencia(restauranteId, clave) {
      const [contacto] = await db.select({ id: MarketingContactoTable.id, enlaceId: MarketingContactoTable.enlaceId, canal: MarketingContactoTable.canal, estado: MarketingContactoTable.estado, idempotenciaClave: MarketingContactoTable.idempotenciaClave })
        .from(MarketingContactoTable).where(and(eq(MarketingContactoTable.restauranteId, restauranteId), eq(MarketingContactoTable.idempotenciaClave, clave))).limit(1)
      return contacto as ContactoMarketingPersistido | null
    },
    async cargarToques(restauranteId, clienteId, desde) {
      const [recuperos, contactos] = await Promise.all([
        db.select({ createdAt: RecuperoClienteTable.createdAt }).from(RecuperoClienteTable).where(and(eq(RecuperoClienteTable.restauranteId, restauranteId), eq(RecuperoClienteTable.clienteId, clienteId), gte(RecuperoClienteTable.createdAt, desde))),
        db.select({ createdAt: MarketingContactoTable.createdAt }).from(MarketingContactoTable).where(and(eq(MarketingContactoTable.restauranteId, restauranteId), eq(MarketingContactoTable.clienteId, clienteId), gte(MarketingContactoTable.createdAt, desde), inArray(MarketingContactoTable.estado, ['preparado', 'abierto', 'reservado', 'enviado']))),
      ])
      return [...recuperos, ...contactos].map((toque) => ({ createdAt: new Date(toque.createdAt) }))
    },
    sacarClienteDeControl: (restauranteId, clienteId) => registrarContactoManual(db, restauranteId, clienteId),
    async crearContacto(input) {
      const resultado = await db.insert(MarketingContactoTable).values(input)
      return { id: Number(resultado[0].insertId), enlaceId: input.enlaceId, canal: input.canal, estado: input.estado, idempotenciaClave: input.idempotenciaClave }
    },
  }
}

const enviarWhatsappSchema = contactoSchema

type EstadoEnvioWhatsapp = 'reservado' | 'enviado' | 'revertido' | 'fallido'

export interface EnlaceParaEnvioWhatsapp extends EnlaceParaContactoMarketing {
  clienteNombre: string
  restauranteNombre: string
  creds: WaCredentials | undefined
  usaCredencialesPlataforma: boolean
}

export interface ContactoEnvioWhatsapp {
  id: number
  enlaceId: number
  canal: 'piru_whatsapp'
  estado: EstadoEnvioWhatsapp
  idempotenciaClave: string
  proveedorMessageId?: string | null
}

export interface RepositorioEnvioWhatsappMarketing {
  buscarEnlace(restauranteId: number, enlaceId: number): Promise<EnlaceParaEnvioWhatsapp | null>
  buscarContactoPorIdempotencia(restauranteId: number, clave: string): Promise<ContactoEnvioWhatsapp | null>
  cargarToques(restauranteId: number, clienteId: number, desde: Date): Promise<{ createdAt: Date }[]>
  sacarClienteDeControl(restauranteId: number, clienteId: number): Promise<void>
  crearContacto(input: { restauranteId: number; enlaceId: number; clienteId: number; canal: 'piru_whatsapp'; estado: 'reservado'; idempotenciaClave: string }): Promise<ContactoEnvioWhatsapp>
  actualizarContacto(restauranteId: number, contactoId: number, input: { estado: EstadoEnvioWhatsapp; proveedor?: string | null; proveedorMessageId?: string | null; costoMensajes?: string; enviadoAt?: Date | null }): Promise<void>
}

export interface DependenciasEnvioWhatsappMarketing {
  repositorio: RepositorioEnvioWhatsappMarketing
  walletDb: unknown
  reservar: typeof reservarCreditoMarketing
  confirmar: typeof confirmarReservaCreditoMarketing
  compensar: typeof compensarReservaCreditoMarketing
  enviar: (input: { phone: string; customerName: string; restaurantName: string; texto: string; recipeUrl: string; creds: WaCredentials | undefined }) => Promise<{ success: boolean; id?: string; error?: unknown }>
  ahora: () => Date
}

function operacionContactoMarketing(contactoId: number): string {
  return `marketing-contacto:${contactoId}`
}

/**
 * Envía una única receta mediante Piru. El contacto durable se crea antes de
 * reservar: eso serializa doble-clicks por la clave de idempotencia. Un timeout
 * se revierte y no se reintenta contra el proveedor con la misma clave, porque
 * el resultado remoto es ambiguo y duplicar un marketing sería peor.
 */
export function crearMarketingEnvioWhatsappRoute(
  dependencias: DependenciasEnvioWhatsappMarketing,
  middlewares: MiddlewareHandler[] = [],
) {
  const route = new Hono()
  for (const middleware of middlewares) route.use('*', middleware)
  route.post('/enlaces/:id/enviar-whatsapp', zValidator('param', idParamSchema), zValidator('json', enviarWhatsappSchema), async (c: any) => {
    const restauranteId = c.user.id as number
    const enlaceId = Number(c.req.param('id'))
    const input = c.req.valid('json') as z.infer<typeof enviarWhatsappSchema>
    const enlace = await dependencias.repositorio.buscarEnlace(restauranteId, enlaceId)
    const noDisponible = !enlace || !enlace.activo || enlace.clienteId == null || (enlace.expiraAt != null && enlace.expiraAt <= dependencias.ahora())
    if (noDisponible || !coincideTokenMarketingSeguro(input.token, enlace!.tokenHash)) {
      return c.json({ success: false, message: 'Enlace no disponible para contacto' }, 404)
    }

    const existente = await dependencias.repositorio.buscarContactoPorIdempotencia(restauranteId, input.idempotenciaClave)
    if (existente) {
      if (existente.enlaceId !== enlace.id || existente.canal !== 'piru_whatsapp') return c.json({ success: false, message: 'La clave de idempotencia ya pertenece a otra acción' }, 409)
      if (existente.estado === 'enviado') {
        // Si el proceso cayó después de la aceptación del proveedor pero antes
        // de confirmar el ledger, este reintento sólo termina la confirmación;
        // jamás vuelve a llamar a WhatsApp.
        await dependencias.confirmar(dependencias.walletDb as any, restauranteId, operacionContactoMarketing(existente.id))
        return c.json({ success: true, data: { contacto: existente, entregado: true, idempotente: true } })
      }
      // Nunca reintentamos un proveedor después de un timeout/reversión ni en
      // paralelo a un envío reservado: evita duplicar un mensaje de marketing.
      return c.json({ success: false, code: existente.estado === 'reservado' ? 'envio_en_proceso' : 'envio_no_reintentable', message: 'Esta acción ya fue procesada; prepará un enlace nuevo para volver a enviar.' }, 409)
    }

    const instante = dependencias.ahora()
    const desdeVentana = new Date(instante.getTime() - VENTANA_TOPE_DIAS * 24 * 60 * 60 * 1000)
    const toquesVentana = await dependencias.repositorio.cargarToques(restauranteId, enlace.clienteId!, desdeVentana)
    const proteccion = chequearProteccionMarketing({ optOut: enlace.marketingOptOut, toques: toquesVentana, ahora: instante.getTime() })
    if (!proteccion.permitido) return c.json({ success: false, code: proteccion.motivo, message: proteccion.mensaje }, 409)
    const toques = await dependencias.repositorio.cargarToques(restauranteId, enlace.clienteId!, new Date(0))
    const ultimo = toques.reduce<Date | null>((actual, toque) => !actual || toque.createdAt > actual ? toque.createdAt : actual, null)
    if (ultimo && instante.getTime() - ultimo.getTime() < COOLDOWN_HORAS * 60 * 60 * 1000) {
      return c.json({ success: false, code: 'cooldown', message: `Esperá ${COOLDOWN_HORAS} hs antes de volver a contactar a este cliente` }, 409)
    }
    const telefono = telefonoWaMe(enlace.telefono)
    if (!telefono) return c.json({ success: false, code: 'telefono_invalido', message: 'El cliente no tiene un teléfono válido para WhatsApp' }, 422)
    if (!enlace.creds && !enlace.usaCredencialesPlataforma) return c.json({ success: false, code: 'credenciales_whatsapp_incompletas', message: 'Conectá las credenciales de WhatsApp antes de enviar con Piru.' }, 422)

    await dependencias.repositorio.sacarClienteDeControl(restauranteId, enlace.clienteId!)
    let contacto: ContactoEnvioWhatsapp
    try {
      contacto = await dependencias.repositorio.crearContacto({ restauranteId, enlaceId: enlace.id, clienteId: enlace.clienteId!, canal: 'piru_whatsapp', estado: 'reservado', idempotenciaClave: input.idempotenciaClave })
    } catch (error: any) {
      if (error?.code !== 'ER_DUP_ENTRY') throw error
      const paralelo = await dependencias.repositorio.buscarContactoPorIdempotencia(restauranteId, input.idempotenciaClave)
      if (!paralelo || paralelo.enlaceId !== enlace.id || paralelo.canal !== 'piru_whatsapp') throw error
      return c.json({ success: false, code: 'envio_en_proceso', message: 'El envío ya está siendo procesado.' }, 409)
    }

    const operacionId = operacionContactoMarketing(contacto.id)
    const reserva = await dependencias.reservar(dependencias.walletDb as any, restauranteId, operacionId)
    if (reserva.estado === 'sin_saldo') {
      await dependencias.repositorio.actualizarContacto(restauranteId, contacto.id, { estado: 'fallido' })
      return c.json({ success: false, code: 'saldo_insuficiente', message: 'No tenés saldo de mensajes marketing para enviar esta receta.' }, 409)
    }
    if (reserva.estado === 'compensada') {
      await dependencias.repositorio.actualizarContacto(restauranteId, contacto.id, { estado: 'revertido' })
      return c.json({ success: false, code: 'envio_no_reintentable', message: 'La acción ya fue revertida.' }, 409)
    }

    const recipeUrl = urlEnlaceReceta(enlace.username, input.token)
    const envio = await dependencias.enviar({ phone: telefono, customerName: enlace.clienteNombre, restaurantName: enlace.restauranteNombre, texto: enlace.textoSugerido ?? '', recipeUrl, creds: enlace.creds })
    if (!envio.success || !envio.id) {
      await dependencias.compensar(dependencias.walletDb as any, restauranteId, operacionId)
      await dependencias.repositorio.actualizarContacto(restauranteId, contacto.id, { estado: 'revertido' })
      return c.json({ success: false, code: 'envio_fallido', message: 'No se pudo enviar el mensaje por WhatsApp.' }, 502)
    }

    // Primero se deja evidencia de que el proveedor aceptó el mensaje. Si el
    // proceso cae antes de confirmar el ledger, el retry no reenvía el mensaje.
    await dependencias.repositorio.actualizarContacto(restauranteId, contacto.id, { estado: 'enviado', proveedor: 'whatsapp_cloud_api', proveedorMessageId: envio.id, costoMensajes: '1.00', enviadoAt: instante })
    await dependencias.confirmar(dependencias.walletDb as any, restauranteId, operacionId)
    return c.json({ success: true, data: { contacto: { ...contacto, estado: 'enviado', proveedorMessageId: envio.id }, entregado: true, idempotente: false } }, 201)
  })
  return route
}

function crearRepositorioEnvioWhatsappDrizzle(): RepositorioEnvioWhatsappMarketing {
  const db = drizzle(pool)
  return {
    async buscarEnlace(restauranteId, enlaceId) {
      const [enlace] = await db.select({
        id: MarketingEnlaceTable.id, restauranteId: MarketingEnlaceTable.restauranteId, clienteId: MarketingEnlaceTable.clienteId,
        tokenHash: MarketingEnlaceTable.tokenHash, textoSugerido: MarketingEnlaceTable.textoSugerido, activo: MarketingEnlaceTable.activo,
        expiraAt: MarketingEnlaceTable.expiraAt, telefono: ClienteTable.telefono, marketingOptOut: ClienteTable.marketingOptOut,
        clienteNombre: ClienteTable.nombre, username: RestauranteTable.username, restauranteNombre: RestauranteTable.nombre,
        whatsappPhoneId: RestauranteTable.whatsappPhoneId, whatsappAccessToken: RestauranteTable.whatsappAccessToken,
      }).from(MarketingEnlaceTable).innerJoin(RestauranteTable, eq(RestauranteTable.id, MarketingEnlaceTable.restauranteId))
        .leftJoin(ClienteTable, and(eq(ClienteTable.id, MarketingEnlaceTable.clienteId), eq(ClienteTable.restauranteId, MarketingEnlaceTable.restauranteId)))
        .where(and(eq(MarketingEnlaceTable.restauranteId, restauranteId), eq(MarketingEnlaceTable.id, enlaceId))).limit(1)
      if (!enlace || !enlace.clienteNombre) return null
      return { ...enlace, creds: resolverCredsRestaurante(enlace), usaCredencialesPlataforma: Boolean(process.env.WHATSAPP_PHONE_ID && process.env.WHATSAPP_API_TOKEN) }
    },
    async buscarContactoPorIdempotencia(restauranteId, clave) {
      const [contacto] = await db.select({ id: MarketingContactoTable.id, enlaceId: MarketingContactoTable.enlaceId, canal: MarketingContactoTable.canal, estado: MarketingContactoTable.estado, idempotenciaClave: MarketingContactoTable.idempotenciaClave, proveedorMessageId: MarketingContactoTable.proveedorMessageId })
        .from(MarketingContactoTable).where(and(eq(MarketingContactoTable.restauranteId, restauranteId), eq(MarketingContactoTable.idempotenciaClave, clave))).limit(1)
      return contacto as ContactoEnvioWhatsapp | null
    },
    cargarToques: crearRepositorioContactosDrizzle().cargarToques,
    sacarClienteDeControl: (restauranteId, clienteId) => registrarContactoManual(db, restauranteId, clienteId),
    async crearContacto(input) {
      const resultado = await db.insert(MarketingContactoTable).values(input)
      return { id: Number(resultado[0].insertId), enlaceId: input.enlaceId, canal: input.canal, estado: input.estado, idempotenciaClave: input.idempotenciaClave }
    },
    async actualizarContacto(restauranteId, contactoId, input) {
      await db.update(MarketingContactoTable).set(input).where(and(eq(MarketingContactoTable.restauranteId, restauranteId), eq(MarketingContactoTable.id, contactoId)))
    },
  }
}

export interface RepositorioOportunidadesMarketing {
  cargarDatos(restauranteId: number): Promise<DatosOportunidadesMarketing>
  cargarEnlaces(restauranteId: number): Promise<EnlaceOportunidadInput[]>
}

function crearRepositorioOportunidadesDrizzle(): RepositorioOportunidadesMarketing {
  const db = drizzle(pool)
  return {
    async cargarDatos(restauranteId) {
      // Cada carga es por restaurante, no por cliente: RFM depende de toda la
      // distribución del local y esta forma evita el patrón N+1.
      const [clientes, pedidos, items, productos, recuperos, contactos] = await Promise.all([
        db.select({ id: ClienteTable.id, nombre: ClienteTable.nombre, marketingOptOut: ClienteTable.marketingOptOut })
          .from(ClienteTable).where(eq(ClienteTable.restauranteId, restauranteId)),
        db.select({ id: PedidoUnificadoTable.id, clienteId: PedidoUnificadoTable.clienteId, total: PedidoUnificadoTable.total, createdAt: PedidoUnificadoTable.createdAt })
          .from(PedidoUnificadoTable).where(and(eq(PedidoUnificadoTable.restauranteId, restauranteId), ne(PedidoUnificadoTable.estado, 'cancelled'))),
        db.select({ pedidoId: ItemPedidoUnificadoTable.pedidoId, productoId: ItemPedidoUnificadoTable.productoId, cantidad: ItemPedidoUnificadoTable.cantidad })
          .from(ItemPedidoUnificadoTable).innerJoin(PedidoUnificadoTable, eq(ItemPedidoUnificadoTable.pedidoId, PedidoUnificadoTable.id))
          .where(and(eq(PedidoUnificadoTable.restauranteId, restauranteId), ne(PedidoUnificadoTable.estado, 'cancelled'))),
        db.select({ id: ProductoTable.id, nombre: ProductoTable.nombre }).from(ProductoTable).where(eq(ProductoTable.restauranteId, restauranteId)),
        db.select({ clienteId: RecuperoClienteTable.clienteId, createdAt: RecuperoClienteTable.createdAt }).from(RecuperoClienteTable)
          .where(eq(RecuperoClienteTable.restauranteId, restauranteId)),
        db.select({ clienteId: MarketingContactoTable.clienteId, createdAt: MarketingContactoTable.createdAt }).from(MarketingContactoTable)
          .where(and(eq(MarketingContactoTable.restauranteId, restauranteId), inArray(MarketingContactoTable.estado, ['preparado', 'abierto', 'reservado', 'enviado']))),
      ])
      return { clientes, pedidos, items, productos, recuperos, contactos }
    },
    async cargarEnlaces(restauranteId) {
      return db.select({
        id: MarketingEnlaceTable.id, clienteId: MarketingEnlaceTable.clienteId, recetaCodigo: MarketingEnlaceTable.recetaCodigo,
        destinoTipo: MarketingEnlaceTable.destinoTipo, productoId: MarketingEnlaceTable.productoId,
        carritoRep: MarketingEnlaceTable.carritoRep, codigoDescuentoId: MarketingEnlaceTable.codigoDescuentoId,
        activo: MarketingEnlaceTable.activo, expiraAt: MarketingEnlaceTable.expiraAt, createdAt: MarketingEnlaceTable.createdAt,
      }).from(MarketingEnlaceTable).where(eq(MarketingEnlaceTable.restauranteId, restauranteId)) as Promise<EnlaceOportunidadInput[]>
    },
  }
}

const oportunidadesQuerySchema = z.object({
  segmento: z.enum(['nuevo', 'activo', 'vip', 'en_riesgo', 'dormido', 'perdido']).optional(),
  receta: z.enum(recetaCodigos).optional(),
})

export function crearMarketingOportunidadesRoute(
  repositorio: RepositorioOportunidadesMarketing,
  middlewares: MiddlewareHandler[] = [],
  ahora: () => Date = () => new Date(),
) {
  const route = new Hono()
  for (const middleware of middlewares) route.use('*', middleware)

  const resolver = async (restauranteId: number) => {
    const [datos, enlaces] = await Promise.all([repositorio.cargarDatos(restauranteId), repositorio.cargarEnlaces(restauranteId)])
    return resolverOportunidadesMarketing(datos, enlaces, ahora())
  }
  route.get('/oportunidades', zValidator('query', oportunidadesQuerySchema), async (c: any) => {
    const oportunidades = filtrarOportunidadesMarketing(await resolver(c.user.id), c.req.valid('query'))
    return c.json({ success: true, data: { oportunidades, total: oportunidades.length } })
  })
  route.get('/clientes/:clienteId/recomendacion', zValidator('param', z.object({ clienteId: z.coerce.number().int().positive() })), async (c: any) => {
    const clienteId = c.req.valid('param').clienteId
    const recomendacion = (await resolver(c.user.id)).find((oportunidad) => oportunidad.cliente.id === clienteId)
    return recomendacion
      ? c.json({ success: true, data: recomendacion })
      : c.json({ success: false, message: 'Cliente no encontrado' }, 404)
  })
  return route
}

const resultadosQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  campaniaId: z.coerce.number().int().positive().optional(),
  sucursalId: z.coerce.number().int().positive().optional(),
  fuente: z.enum(['organico']).optional(),
}).refine((filtros) => !filtros.from || !filtros.to || filtros.from <= filtros.to, { message: 'from debe ser anterior a to' })

export interface RepositorioResultadosMarketing {
  cargar(restauranteId: number): Promise<Omit<DatosResultadosMarketing, 'oportunidades'>>
  cargarOportunidades(restauranteId: number): Promise<OportunidadResultadoMarketing[]>
}
type OportunidadResultadoMarketing = { segmento: string; recetaCodigo: string }

function crearRepositorioResultadosDrizzle(): RepositorioResultadosMarketing {
  const db = drizzle(pool)
  const oportunidades = crearRepositorioOportunidadesDrizzle()
  return {
    async cargar(restauranteId) {
      const [pedidos, campanas, atribuciones, sesiones, eventos, contactos, enlaces] = await Promise.all([
        db.select({ id: PedidoUnificadoTable.id, clienteId: PedidoUnificadoTable.clienteId, sucursalId: PedidoUnificadoTable.sucursalId, total: PedidoUnificadoTable.total, montoDescuento: PedidoUnificadoTable.montoDescuento, marketingCampanaId: PedidoUnificadoTable.marketingCampanaId, createdAt: PedidoUnificadoTable.createdAt, pagado: PedidoUnificadoTable.pagado }).from(PedidoUnificadoTable).where(eq(PedidoUnificadoTable.restauranteId, restauranteId)),
        db.select({ id: MarketingCampanaTable.id, nombre: MarketingCampanaTable.nombre, slug: MarketingCampanaTable.slug, tipo: MarketingCampanaTable.tipo, productoId: MarketingCampanaTable.productoId, inversionManual: MarketingCampanaTable.inversionManual, usaGrupoControl: MarketingCampanaTable.usaGrupoControl }).from(MarketingCampanaTable).where(eq(MarketingCampanaTable.restauranteId, restauranteId)),
        db.select({ pedidoUnificadoId: PedidoMarketingAtribucionTable.pedidoUnificadoId, campanaId: PedidoMarketingAtribucionTable.campanaId, recetaCodigo: PedidoMarketingAtribucionTable.recetaCodigo, revenueAtribuido: PedidoMarketingAtribucionTable.revenueAtribuido, descuentoAtribuido: PedidoMarketingAtribucionTable.descuentoAtribuido, createdAt: PedidoMarketingAtribucionTable.createdAt }).from(PedidoMarketingAtribucionTable).where(eq(PedidoMarketingAtribucionTable.restauranteId, restauranteId)),
        db.select({ id: MarketingSesionTable.id, firstTouchTipo: MarketingSesionTable.firstTouchTipo, lastTouchTipo: MarketingSesionTable.lastTouchTipo, firstTouchCampanaId: MarketingSesionTable.firstTouchCampanaId, lastTouchCampanaId: MarketingSesionTable.lastTouchCampanaId, createdAt: MarketingSesionTable.createdAt }).from(MarketingSesionTable).where(eq(MarketingSesionTable.restauranteId, restauranteId)),
        db.select({ id: MarketingEventoTable.id, marketingSesionId: MarketingEventoTable.marketingSesionId, sesionUuid: MarketingEventoTable.sesionUuid, campanaId: MarketingEventoTable.campanaId, tipo: MarketingEventoTable.tipo, productoId: MarketingEventoTable.productoId, pedidoUnificadoId: MarketingEventoTable.pedidoUnificadoId, ocurridoAt: MarketingEventoTable.ocurridoAt }).from(MarketingEventoTable).where(eq(MarketingEventoTable.restauranteId, restauranteId)),
        db.select({ id: MarketingContactoTable.id, enlaceId: MarketingContactoTable.enlaceId, canal: MarketingContactoTable.canal, estado: MarketingContactoTable.estado, costoMensajes: MarketingContactoTable.costoMensajes, createdAt: MarketingContactoTable.createdAt }).from(MarketingContactoTable).where(eq(MarketingContactoTable.restauranteId, restauranteId)),
        db.select({ id: MarketingEnlaceTable.id, campanaId: MarketingEnlaceTable.campanaId, recetaCodigo: MarketingEnlaceTable.recetaCodigo, createdAt: MarketingEnlaceTable.createdAt }).from(MarketingEnlaceTable).where(eq(MarketingEnlaceTable.restauranteId, restauranteId)),
      ])
      return { pedidos, campanas, atribuciones, sesiones, eventos, contactos, enlaces } as Omit<DatosResultadosMarketing, 'oportunidades'>
    },
    async cargarOportunidades(restauranteId) {
      const [datos, enlaces] = await Promise.all([oportunidades.cargarDatos(restauranteId), oportunidades.cargarEnlaces(restauranteId)])
      return resolverOportunidadesMarketing(datos, enlaces).map((fila) => ({ segmento: fila.diagnostico.segmento, recetaCodigo: fila.receta.codigo }))
    },
  }
}

export function crearMarketingResultadosRoute(repositorio: RepositorioResultadosMarketing, middlewares: MiddlewareHandler[] = []) {
  const route = new Hono()
  for (const middleware of middlewares) route.use('*', middleware)
  const responder = async (c: any, filtros = c.req.valid('query') as FiltrosResultadosMarketing) => {
    const restauranteId = c.user.id as number
    const [datos, oportunidades] = await Promise.all([repositorio.cargar(restauranteId), repositorio.cargarOportunidades(restauranteId)])
    return c.json({ success: true, data: resumirResultadosMarketing({ ...datos, oportunidades }, filtros) })
  }
  route.get('/resumen', zValidator('query', resultadosQuerySchema), async (c: any) => responder(c, c.req.valid('query')))
  route.get('/organico/resultados', zValidator('query', resultadosQuerySchema), async (c: any) =>
    responder(c, { ...c.req.valid('query'), campaniaId: undefined, fuente: 'organico' }))
  route.get('/campanas/:id/resultados', zValidator('param', idParamSchema), zValidator('query', resultadosQuerySchema), async (c: any) =>
    responder(c, { ...c.req.valid('query'), campaniaId: c.req.valid('param').id }))
  return route
}

const marketingMiddlewares = [authMiddleware, requireModulo(MODULE_KEYS.CRECIMIENTO)]
const dependenciasEnvioWhatsappDrizzle: DependenciasEnvioWhatsappMarketing = {
  repositorio: crearRepositorioEnvioWhatsappDrizzle(), walletDb: drizzle(pool), reservar: reservarCreditoMarketing, confirmar: confirmarReservaCreditoMarketing, compensar: compensarReservaCreditoMarketing,
  enviar: ({ creds, ...input }) => sendClientGrowthRecipeWhatsApp({ env: process.env } as any, input, creds), ahora: () => new Date(),
}
export const marketingCampanasRoute = new Hono()
  .route('/', crearMarketingCampanasRoute(crearRepositorioCampanasDrizzle(), marketingMiddlewares))
  .route('/', crearMarketingEnlacesRoute(crearRepositorioEnlacesDrizzle(), marketingMiddlewares))
  .route('/', crearMarketingContactosRoute(crearRepositorioContactosDrizzle(), marketingMiddlewares))
  .route('/', crearMarketingEnvioWhatsappRoute(dependenciasEnvioWhatsappDrizzle, marketingMiddlewares))
  .route('/', crearMarketingOportunidadesRoute(crearRepositorioOportunidadesDrizzle(), marketingMiddlewares))
  .route('/', crearMarketingResultadosRoute(crearRepositorioResultadosDrizzle(), marketingMiddlewares))
