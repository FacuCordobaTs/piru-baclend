import { and, eq, lte } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import {
  marketingEvento as MarketingEventoTable,
  marketingSesion as MarketingSesionTable,
} from '../db/schema'

export const DURACION_SESION_MARKETING_MS = 30 * 60 * 1000
export const MAX_EVENTOS_MARKETING_POR_BATCH = 20

export const TIPOS_EVENTO_MARKETING = [
  'session_start',
  'product_view',
  'add_to_cart',
  'checkout_start',
  'purchase',
] as const

export type TipoEventoMarketing = (typeof TIPOS_EVENTO_MARKETING)[number]
export type TipoTouchMarketing = 'directo' | 'campana' | 'receta'

export interface UtmsMarketingNormalizadas {
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmTerm: string | null
  utmContent: string | null
}

export interface UtmsMarketingInput {
  utmSource?: unknown
  utmMedium?: unknown
  utmCampaign?: unknown
  utmTerm?: unknown
  utmContent?: unknown
  utm_source?: unknown
  utm_medium?: unknown
  utm_campaign?: unknown
  utm_term?: unknown
  utm_content?: unknown
}

export interface TouchMarketingInput {
  tipo: TipoTouchMarketing
  campanaId?: number | null
  recetaCodigo?: string | null
}

export interface EventoMarketingInput {
  eventoUuid: string
  sesionUuid: string
  visitorId: string
  tipo: TipoEventoMarketing
  ocurridoAt: Date | string | number
  touch?: TouchMarketingInput | null
  productoId?: number | null
  pedidoUnificadoId?: number | null
  cantidad?: number | null
  valor?: number | string | null
  metadata?: Record<string, unknown> | null
}

export interface EventoMarketingValidado {
  eventoUuid: string
  sesionUuid: string
  visitorId: string
  tipo: TipoEventoMarketing
  ocurridoAt: Date
  touch: TouchMarketing
  productoId: number | null
  pedidoUnificadoId: number | null
  cantidad: number | null
  valor: string | null
  metadata: Record<string, unknown> | null
}

export interface TouchMarketing {
  tipo: TipoTouchMarketing
  campanaId: number | null
  recetaCodigo: string | null
}

export interface SesionMarketingPersistida {
  id: number
  restauranteId: number
  sesionUuid: string
  visitorId: string
  firstTouchTipo: TipoTouchMarketing
  firstTouchCampanaId: number | null
  firstTouchRecetaCodigo: string | null
  firstTouchAt: Date
  lastTouchTipo: TipoTouchMarketing
  lastTouchCampanaId: number | null
  lastTouchRecetaCodigo: string | null
  lastTouchAt: Date
  expiraAt: Date
}

export interface NuevaSesionMarketing extends Omit<SesionMarketingPersistida, 'id'> {}

export interface CambiosSesionMarketing {
  lastTouchTipo: TipoTouchMarketing
  lastTouchCampanaId: number | null
  lastTouchRecetaCodigo: string | null
  lastTouchAt: Date
  expiraAt: Date
}

export interface RepositorioMarketingTracking {
  buscarSesion(restauranteId: number, sesionUuid: string): Promise<SesionMarketingPersistida | null>
  crearOEncontrarSesion(sesion: NuevaSesionMarketing): Promise<SesionMarketingPersistida>
  buscarEvento(restauranteId: number, eventoUuid: string): Promise<{ sesionId: number } | null>
  insertarEvento(
    restauranteId: number,
    sesionId: number,
    evento: EventoMarketingValidado,
  ): Promise<boolean>
  actualizarSesionSiEsMasReciente(
    restauranteId: number,
    sesionId: number,
    cambios: CambiosSesionMarketing,
  ): Promise<void>
}

export type CodigoErrorMarketingTracking =
  | 'BATCH_INVALIDO'
  | 'EVENTO_INVALIDO'
  | 'SESION_EXPIRADA'
  | 'VISITOR_NO_COINCIDE'

export class ErrorMarketingTracking extends Error {
  constructor(
    public readonly codigo: CodigoErrorMarketingTracking,
    message: string,
    public readonly indiceEvento?: number,
  ) {
    super(message)
    this.name = 'ErrorMarketingTracking'
  }
}

export interface ResultadoEventoMarketing {
  eventoUuid: string
  estado: 'insertado' | 'duplicado'
  sesionId: number
}

const TOUCH_DIRECTO: TouchMarketing = {
  tipo: 'directo',
  campanaId: null,
  recetaCodigo: null,
}

function normalizarTextoUtm(value: unknown, minusculas: boolean): string | null {
  if (typeof value !== 'string') return null
  const normalizado = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 255)
  if (!normalizado) return null
  return minusculas ? normalizado.toLocaleLowerCase('es') : normalizado
}

/**
 * Acepta nombres camelCase o query-string. Source y medium se canonizan en
 * minúsculas; campaign/term/content preservan mayúsculas porque pueden ser
 * etiquetas legibles definidas por el restaurante.
 */
export function normalizarUtms(input: UtmsMarketingInput = {}): UtmsMarketingNormalizadas {
  return {
    utmSource: normalizarTextoUtm(input.utmSource ?? input.utm_source, true),
    utmMedium: normalizarTextoUtm(input.utmMedium ?? input.utm_medium, true),
    utmCampaign: normalizarTextoUtm(input.utmCampaign ?? input.utm_campaign, false),
    utmTerm: normalizarTextoUtm(input.utmTerm ?? input.utm_term, false),
    utmContent: normalizarTextoUtm(input.utmContent ?? input.utm_content, false),
  }
}

export function calcularExpiracionSesion(ultimaActividadAt: Date): Date {
  return new Date(ultimaActividadAt.getTime() + DURACION_SESION_MARKETING_MS)
}

export function sesionEstaExpirada(sesion: Pick<SesionMarketingPersistida, 'expiraAt'>, en: Date): boolean {
  return en.getTime() > sesion.expiraAt.getTime()
}

function idPositivoONull(value: unknown, campo: string): number | null {
  if (value == null) return null
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${campo} debe ser un entero positivo`)
  return Number(value)
}

function identificador(value: unknown, campo: string): string {
  if (typeof value !== 'string') throw new Error(`${campo} debe ser texto`)
  const limpio = value.trim()
  if (!limpio || limpio.length > 64) throw new Error(`${campo} debe tener entre 1 y 64 caracteres`)
  return limpio
}

function validarTouch(input: TouchMarketingInput | null | undefined): TouchMarketing {
  if (!input) return TOUCH_DIRECTO
  if (input.tipo === 'directo') {
    if (input.campanaId != null || input.recetaCodigo != null) {
      throw new Error('un touch directo no admite campaña ni receta')
    }
    return TOUCH_DIRECTO
  }
  if (input.tipo === 'campana') {
    const campanaId = idPositivoONull(input.campanaId, 'touch.campanaId')
    if (campanaId == null || input.recetaCodigo != null) {
      throw new Error('un touch de campaña requiere sólo campanaId')
    }
    return { tipo: 'campana', campanaId, recetaCodigo: null }
  }
  if (input.tipo === 'receta') {
    if (input.campanaId != null) throw new Error('un touch de receta no admite campanaId')
    return {
      tipo: 'receta',
      campanaId: null,
      recetaCodigo: identificador(input.recetaCodigo, 'touch.recetaCodigo'),
    }
  }
  throw new Error('touch.tipo inválido')
}

export function validarEventoMarketing(input: EventoMarketingInput): EventoMarketingValidado {
  const ocurridoAt = new Date(input.ocurridoAt)
  if (Number.isNaN(ocurridoAt.getTime())) throw new Error('ocurridoAt debe ser una fecha válida')
  if (!TIPOS_EVENTO_MARKETING.includes(input.tipo)) throw new Error('tipo de evento inválido')

  const cantidad = idPositivoONull(input.cantidad, 'cantidad')
  const productoId = idPositivoONull(input.productoId, 'productoId')
  const pedidoUnificadoId = idPositivoONull(input.pedidoUnificadoId, 'pedidoUnificadoId')
  const valorNumero = input.valor == null || input.valor === '' ? null : Number(input.valor)
  if (valorNumero != null && (!Number.isFinite(valorNumero) || valorNumero < 0 || valorNumero > 999_999_999_999.99)) {
    throw new Error('valor debe ser un número no negativo')
  }
  if (input.metadata != null && (typeof input.metadata !== 'object' || Array.isArray(input.metadata))) {
    throw new Error('metadata debe ser un objeto')
  }
  if (input.metadata != null) {
    try {
      const serializado = JSON.stringify(input.metadata)
      if (serializado.length > 16_384) throw new Error('metadata excede 16 KB')
    } catch (error) {
      throw new Error(error instanceof Error && error.message === 'metadata excede 16 KB'
        ? error.message
        : 'metadata debe ser JSON serializable')
    }
  }
  if ((input.tipo === 'product_view' || input.tipo === 'add_to_cart') && productoId == null) {
    throw new Error(`${input.tipo} requiere productoId`)
  }
  if (input.tipo === 'add_to_cart' && cantidad == null) {
    throw new Error('add_to_cart requiere cantidad')
  }

  return {
    eventoUuid: identificador(input.eventoUuid, 'eventoUuid'),
    sesionUuid: identificador(input.sesionUuid, 'sesionUuid'),
    visitorId: identificador(input.visitorId, 'visitorId'),
    tipo: input.tipo,
    ocurridoAt,
    touch: validarTouch(input.touch),
    productoId,
    pedidoUnificadoId,
    cantidad,
    valor: valorNumero == null ? null : valorNumero.toFixed(2),
    metadata: input.metadata ?? null,
  }
}

/** Valida el batch completo antes de realizar la primera escritura. */
export function validarBatchEventosMarketing(eventos: EventoMarketingInput[]): EventoMarketingValidado[] {
  if (!Array.isArray(eventos) || eventos.length < 1 || eventos.length > MAX_EVENTOS_MARKETING_POR_BATCH) {
    throw new ErrorMarketingTracking(
      'BATCH_INVALIDO',
      `el batch debe contener entre 1 y ${MAX_EVENTOS_MARKETING_POR_BATCH} eventos`,
    )
  }
  return eventos.map((evento, indice) => {
    try {
      return validarEventoMarketing(evento)
    } catch (error) {
      throw new ErrorMarketingTracking(
        'EVENTO_INVALIDO',
        error instanceof Error ? error.message : 'evento inválido',
        indice,
      )
    }
  })
}

export function resolverCambiosSesion(
  sesion: SesionMarketingPersistida,
  evento: EventoMarketingValidado,
): CambiosSesionMarketing {
  const esMasReciente = evento.ocurridoAt.getTime() >= sesion.lastTouchAt.getTime()
  // Una visita directa no borra el último origen atribuible. Sólo mueve la
  // actividad/expiración; campaña o receta sí reemplazan el last touch.
  const reemplazaAtribucion = esMasReciente && evento.touch.tipo !== 'directo'
  return {
    lastTouchTipo: reemplazaAtribucion ? evento.touch.tipo : sesion.lastTouchTipo,
    lastTouchCampanaId: reemplazaAtribucion ? evento.touch.campanaId : sesion.lastTouchCampanaId,
    lastTouchRecetaCodigo: reemplazaAtribucion
      ? evento.touch.recetaCodigo
      : sesion.lastTouchRecetaCodigo,
    lastTouchAt: esMasReciente ? evento.ocurridoAt : sesion.lastTouchAt,
    expiraAt: esMasReciente ? calcularExpiracionSesion(evento.ocurridoAt) : sesion.expiraAt,
  }
}

function nuevaSesion(restauranteId: number, evento: EventoMarketingValidado): NuevaSesionMarketing {
  return {
    restauranteId,
    sesionUuid: evento.sesionUuid,
    visitorId: evento.visitorId,
    firstTouchTipo: evento.touch.tipo,
    firstTouchCampanaId: evento.touch.campanaId,
    firstTouchRecetaCodigo: evento.touch.recetaCodigo,
    firstTouchAt: evento.ocurridoAt,
    lastTouchTipo: evento.touch.tipo,
    lastTouchCampanaId: evento.touch.campanaId,
    lastTouchRecetaCodigo: evento.touch.recetaCodigo,
    lastTouchAt: evento.ocurridoAt,
    expiraAt: calcularExpiracionSesion(evento.ocurridoAt),
  }
}

export async function procesarBatchEventosMarketing(
  repositorio: RepositorioMarketingTracking,
  restauranteId: number,
  inputs: EventoMarketingInput[],
): Promise<ResultadoEventoMarketing[]> {
  if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
    throw new ErrorMarketingTracking('BATCH_INVALIDO', 'restauranteId debe ser un entero positivo')
  }
  const eventos = validarBatchEventosMarketing(inputs)
  const resultados: ResultadoEventoMarketing[] = []

  for (const evento of eventos) {
    const eventoExistente = await repositorio.buscarEvento(restauranteId, evento.eventoUuid)
    if (eventoExistente) {
      resultados.push({
        eventoUuid: evento.eventoUuid,
        estado: 'duplicado',
        sesionId: eventoExistente.sesionId,
      })
      continue
    }

    let sesion = await repositorio.buscarSesion(restauranteId, evento.sesionUuid)
    if (!sesion) sesion = await repositorio.crearOEncontrarSesion(nuevaSesion(restauranteId, evento))

    if (sesion.restauranteId !== restauranteId) {
      throw new ErrorMarketingTracking('EVENTO_INVALIDO', 'la sesión no pertenece al restaurante')
    }
    if (sesion.visitorId !== evento.visitorId) {
      throw new ErrorMarketingTracking('VISITOR_NO_COINCIDE', 'visitorId no coincide con la sesión')
    }
    if (sesionEstaExpirada(sesion, evento.ocurridoAt)) {
      throw new ErrorMarketingTracking('SESION_EXPIRADA', 'la sesión de marketing expiró')
    }

    const insertado = await repositorio.insertarEvento(restauranteId, sesion.id, evento)
    if (insertado) {
      const cambios = resolverCambiosSesion(sesion, evento)
      await repositorio.actualizarSesionSiEsMasReciente(restauranteId, sesion.id, cambios)
      sesion = { ...sesion, ...cambios }
    }
    resultados.push({
      eventoUuid: evento.eventoUuid,
      estado: insertado ? 'insertado' : 'duplicado',
      sesionId: sesion.id,
    })
  }
  return resultados
}

type Db = MySql2Database<Record<string, never>>

function mapearSesion(row: typeof MarketingSesionTable.$inferSelect): SesionMarketingPersistida {
  return {
    id: row.id,
    restauranteId: row.restauranteId,
    sesionUuid: row.sesionUuid,
    visitorId: row.visitorId,
    firstTouchTipo: row.firstTouchTipo,
    firstTouchCampanaId: row.firstTouchCampanaId,
    firstTouchRecetaCodigo: row.firstTouchRecetaCodigo,
    firstTouchAt: row.firstTouchAt,
    lastTouchTipo: row.lastTouchTipo,
    lastTouchCampanaId: row.lastTouchCampanaId,
    lastTouchRecetaCodigo: row.lastTouchRecetaCodigo,
    lastTouchAt: row.lastTouchAt,
    expiraAt: row.expiraAt,
  }
}

/** Adaptador Drizzle; todas las lecturas/escrituras incluyen restaurante_id. */
export function crearRepositorioMarketingTracking(db: Db): RepositorioMarketingTracking {
  const buscarSesion = async (restauranteId: number, sesionUuid: string) => {
    const [row] = await db.select().from(MarketingSesionTable).where(and(
      eq(MarketingSesionTable.restauranteId, restauranteId),
      eq(MarketingSesionTable.sesionUuid, sesionUuid),
    )).limit(1)
    return row ? mapearSesion(row) : null
  }

  return {
    buscarSesion,
    async crearOEncontrarSesion(sesion) {
      await db.insert(MarketingSesionTable).values(sesion).ignore()
      const persistida = await buscarSesion(sesion.restauranteId, sesion.sesionUuid)
      if (!persistida) throw new Error('no se pudo crear la sesión de marketing')
      return persistida
    },
    async buscarEvento(restauranteId, eventoUuid) {
      const [row] = await db.select({ sesionId: MarketingEventoTable.marketingSesionId }).from(MarketingEventoTable).where(and(
        eq(MarketingEventoTable.restauranteId, restauranteId),
        eq(MarketingEventoTable.eventoUuid, eventoUuid),
      )).limit(1)
      return row ?? null
    },
    async insertarEvento(restauranteId, sesionId, evento) {
      const result = await db.insert(MarketingEventoTable).values({
        restauranteId,
        marketingSesionId: sesionId,
        eventoUuid: evento.eventoUuid,
        tipo: evento.tipo,
        productoId: evento.productoId,
        pedidoUnificadoId: evento.pedidoUnificadoId,
        cantidad: evento.cantidad,
        valor: evento.valor,
        metadata: evento.metadata,
        ocurridoAt: evento.ocurridoAt,
      }).ignore()
      const insertado = Number((result as any)[0]?.affectedRows ?? 0) === 1
      if (insertado) return true
      // INSERT IGNORE también puede omitir errores que no sean la clave de
      // idempotencia. Sólo se considera duplicado si la fila realmente existe.
      const [existente] = await db.select({ id: MarketingEventoTable.id }).from(MarketingEventoTable).where(and(
        eq(MarketingEventoTable.restauranteId, restauranteId),
        eq(MarketingEventoTable.eventoUuid, evento.eventoUuid),
      )).limit(1)
      if (!existente) throw new Error('no se pudo insertar el evento de marketing')
      return false
    },
    async actualizarSesionSiEsMasReciente(restauranteId, sesionId, cambios) {
      await db.update(MarketingSesionTable).set(cambios).where(and(
        eq(MarketingSesionTable.restauranteId, restauranteId),
        eq(MarketingSesionTable.id, sesionId),
        lte(MarketingSesionTable.lastTouchAt, cambios.lastTouchAt),
      ))
    },
  }
}

export async function guardarEventosMarketing(
  db: Db,
  restauranteId: number,
  eventos: EventoMarketingInput[],
): Promise<ResultadoEventoMarketing[]> {
  return procesarBatchEventosMarketing(crearRepositorioMarketingTracking(db), restauranteId, eventos)
}
