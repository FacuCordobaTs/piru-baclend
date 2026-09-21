import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { CodigoRecetaCrecimiento, IncentivoReceta, ItemCarritoReceta, ProductoFavoritoReceta } from './recetas-crecimiento'
import { RECETAS_CRECIMIENTO, recomendarRecetaCrecimiento, type RecomendacionRecetaCrecimiento } from './recetas-crecimiento'
import type { SegmentoCliente } from './clientes-rfm'

/**
 * Formato durable de un carrito de campaña. `v2:` permite conservar las
 * opciones que cambian el ítem (dos grupos de variantes y extras) sin romper
 * los links `12x2-15x1` ya emitidos por recetas de recompra.
 *
 * Nunca incluye precios ni nombres: al abrir el link el storefront vuelve a
 * resolver cada id contra el menú actual del restaurante.
 */
export interface ItemCarritoPrearmado {
  productoId: number
  cantidad: number
  varianteId?: number
  varianteSecundariaId?: number
  agregadoIds: number[]
}

const CARRITO_REP_LEGACY = /^\d+x\d+(?:-\d+x\d+)*$/
const esEnteroPositivo = (valor: unknown) => typeof valor === 'number' && Number.isInteger(valor) && valor > 0

export function parseCarritoPrearmado(valor: string): ItemCarritoPrearmado[] | null {
  if (CARRITO_REP_LEGACY.test(valor)) {
    return valor.split('-').map((parte) => {
      const [productoId, cantidad] = parte.split('x').map(Number)
      return { productoId, cantidad, agregadoIds: [] }
    })
  }
  if (!valor.startsWith('v2:')) return null
  try {
    const bruto: unknown = JSON.parse(valor.slice(3))
    if (!Array.isArray(bruto) || bruto.length === 0 || bruto.length > 30) return null
    const items: ItemCarritoPrearmado[] = []
    for (const item of bruto) {
      if (!item || typeof item !== 'object') return null
      const raw = item as Record<string, unknown>
      if (!esEnteroPositivo(raw.p) || !esEnteroPositivo(raw.q) || raw.q > 99) return null
      if (raw.v !== undefined && !esEnteroPositivo(raw.v)) return null
      if (raw.s !== undefined && !esEnteroPositivo(raw.s)) return null
      if (raw.a !== undefined && (!Array.isArray(raw.a) || raw.a.length > 30 || raw.a.some((id) => !esEnteroPositivo(id)))) return null
      const agregadoIds = (raw.a ?? []) as number[]
      if (new Set(agregadoIds).size !== agregadoIds.length) return null
      items.push({
        productoId: raw.p,
        cantidad: raw.q,
        ...(raw.v === undefined ? {} : { varianteId: raw.v as number }),
        ...(raw.s === undefined ? {} : { varianteSecundariaId: raw.s as number }),
        agregadoIds,
      })
    }
    return items
  } catch {
    return null
  }
}

export const esCarritoPrearmadoValido = (valor: string) => parseCarritoPrearmado(valor) !== null

/** Nunca se persiste el token público; el hash es la única representación durable. */
export function hashTokenMarketing(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Evita que el resolver público compare hashes con `===`. Aunque el índice de
 * DB ya limita la búsqueda, la verificación final mantiene uniforme la
 * comparación del secreto opaco y rechaza hashes corruptos sin lanzar.
 */
export function coincideTokenMarketingSeguro(token: string, tokenHashPersistido: string): boolean {
  const hashCalculado = hashTokenMarketing(token)
  if (!/^[a-f0-9]{64}$/i.test(tokenHashPersistido)) return false
  return timingSafeEqual(Buffer.from(hashCalculado, 'hex'), Buffer.from(tokenHashPersistido, 'hex'))
}

export function generarTokenMarketing(): string {
  // base64url da un token opaco, seguro para una ruta sin escapes adicionales.
  return randomBytes(32).toString('base64url')
}

/** Base pública de la tienda; el resto de la URL siempre es path/query dinámico. */
export const BASE_TIENDA = 'https://my.piru.app/'

/**
 * Punto de anclaje de los links de un local: la base pública más el prefijo que
 * antecede a `/c/:slug` o `/r/:token`. Un local en el dominio compartido lleva el
 * username como primer segmento; uno con dominio propio vive en la raíz.
 */
export interface AnclajeTienda {
  base: string
  prefijo: string
}

/** Local en el dominio compartido: el username es el primer segmento del path. */
export const anclajeCompartido = (username: string): AnclajeTienda => ({
  base: BASE_TIENDA,
  prefijo: `${encodeURIComponent(username)}/`,
})

/** Local en su propio dominio: la tienda vive en la raíz. */
export const anclajePropio = (dominio: string): AnclajeTienda => ({
  base: `https://${normalizarDominio(dominio)}/`,
  prefijo: '',
})

/** Quita protocolo y barras sobrantes: el dominio se guarda pelado en la base. */
function normalizarDominio(dominio: string): string {
  return dominio.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

/** Los datos de un local que alcanzan para decidir cómo se arman sus links. */
export interface LocalEnlaces {
  username: string | null
  dominioTienda?: string | null
  dominioPlantillas?: string | null
}

/**
 * Anclaje del link que se muestra y se copia (texto del modo manual, admin, el
 * que el operador le pasa al cliente): el dominio propio manda sobre el compartido.
 * `null` sólo si el local no tiene ni dominio ni username.
 */
export function anclajePublico(local: LocalEnlaces): AnclajeTienda | null {
  const dominio = local.dominioTienda?.trim()
  if (dominio) return anclajePropio(dominio)
  return local.username ? anclajeCompartido(local.username) : null
}

/**
 * `anclajePublico` para un local que ya sabemos que tiene username: el `??` es
 * inalcanzable y sólo le da al compilador el no-null que el llamador conoce.
 */
export function anclajePublicoDe(local: LocalEnlaces & { username: string }): AnclajeTienda {
  return anclajePublico(local) ?? anclajeCompartido(local.username)
}

/**
 * Anclaje del link que abre el botón de la plantilla de Meta. La base está
 * embebida en la plantilla aprobada, así que NO puede ser la pública mientras las
 * plantillas de ese local no se hayan creado para su dominio: hasta entonces cae
 * al anclaje compartido y el path conserva el username.
 */
export function anclajePlantillas(local: LocalEnlaces): AnclajeTienda | null {
  const dominio = local.dominioPlantillas?.trim()
  if (dominio) return anclajePropio(dominio)
  return local.username ? anclajeCompartido(local.username) : null
}

/**
 * URL pública de una micro-campaña: el storefront resuelve el slug (`/c/:slug`)
 * y el token cifrado viaja como query para reconstruir cliente, carrito y
 * beneficio sin exponer ids.
 */
export function urlMicroCampana(anclaje: AnclajeTienda, slug: string, token: string): string {
  return `${anclaje.base}${anclaje.prefijo}c/${encodeURIComponent(slug)}?tk=${encodeURIComponent(token)}`
}

/**
 * Un token `v1.` es una micro-campaña cifrada (AES-256-GCM) y se abre en
 * `/c/:slug`; cualquier otro es un enlace de receta y se abre en `/r/:token`.
 */
export function urlEnlaceReceta(anclaje: AnclajeTienda, token: string, campanaSlug?: string): string {
  if (token.startsWith('v1.')) {
    return urlMicroCampana(anclaje, campanaSlug || 'lo-mismo', token)
  }
  return `${anclaje.base}${anclaje.prefijo}r/${encodeURIComponent(token)}`
}

/**
 * Path dinámico del botón de la plantilla de Meta: el mismo link, anclado a las
 * plantillas del local y sin su base — es lo que viaja como `{{1}}`, porque la
 * plantilla ya trae la base embebida. Con `dominio_plantillas` en NULL el anclaje
 * es el compartido y el path arranca con el username.
 *
 * No se deriva recortando la URL pública: eso sólo funciona mientras la base
 * compartida sea prefijo literal de la pública, y deja de serlo justo cuando el
 * local tiene dominio propio.
 */
export function pathBotonPlantilla(local: LocalEnlaces, token: string, campanaSlug?: string): string {
  const anclaje = anclajePlantillas(local)
  if (!anclaje) return ''
  return urlEnlaceReceta(anclaje, token, campanaSlug).slice(anclaje.base.length)
}

/**
 * Base ya armada con la que el admin compone links (`<base>c/<slug>`) sin
 * reimplementar la regla: `https://my.piru.app/<username>/` o el dominio propio.
 * `null` si el local todavía no tiene ni username ni dominio.
 */
export function baseTiendaDe(local: LocalEnlaces): string | null {
  const anclaje = anclajePublico(local)
  return anclaje ? `${anclaje.base}${anclaje.prefijo}` : null
}

export interface ContextoClienteEnlace {
  clienteId: number
  segmento: SegmentoCliente
  esVip: boolean
  ultimoCarrito: ItemCarritoReceta[]
  productoFavorito: ProductoFavoritoReceta | null
}

export interface CampanaEnlace {
  id: number
  recetaCodigo: string | null
}

export interface EnlaceMarketingPersistido {
  id: number
  restauranteId: number
  clienteId: number | null
  recetaCodigo: string | null
  tokenHash: string
  codigoDescuentoId: number | null
  expiraAt: Date | null
  activo: boolean
  [key: string]: unknown
}

export interface CrearCuponEnlaceInput {
  codigo: string
  descuentoPorcentaje: number
  expiraAt: Date | null
}

/**
 * Contrato deliberadamente chico para mantener testeable la preparación. La
 * implementación Drizzle vive en la ruta; el dominio no recibe una conexión.
 */
export interface RepositorioEnlacesMarketing {
  buscarPorIdempotencia(restauranteId: number, clave: string): Promise<EnlaceMarketingPersistido | null>
  cargarCliente(restauranteId: number, clienteId: number): Promise<ContextoClienteEnlace | null>
  buscarCampana(restauranteId: number, campanaId: number): Promise<CampanaEnlace | null>
  codigoPertenece(restauranteId: number, codigoDescuentoId: number): Promise<boolean>
  crearCupon(restauranteId: number, input: CrearCuponEnlaceInput): Promise<{ id: number }>
  sacarClienteDeControl(restauranteId: number, clienteId: number): Promise<void>
  crearEnlace(input: {
    restauranteId: number
    clienteId: number
    campanaId: number | null
    recetaCodigo: CodigoRecetaCrecimiento
    tokenHash: string
    idempotenciaClave: string
    destinoTipo: 'tienda' | 'producto' | 'carrito'
    productoId: number | null
    carritoRep: string | null
    codigoDescuentoId: number | null
    textoSugerido: string
    expiraAt: Date
  }): Promise<EnlaceMarketingPersistido>
}

export class ErrorPrepararEnlaceMarketing extends Error {
  constructor(public readonly codigo: 'CLIENTE_NO_ENCONTRADO' | 'CAMPANA_NO_ENCONTRADA' | 'CUPON_NO_ENCONTRADO' | 'RECETA_INVALIDA' | 'INCENTIVO_SIN_CONFIRMAR' | 'CUPON_E_INCENTIVO' | 'TOKEN_COLISION', message: string) {
    super(message)
  }
}

export interface PrepararEnlaceMarketingInput {
  clienteId: number
  recetaCodigo?: CodigoRecetaCrecimiento
  campanaId?: number | null
  codigoDescuentoId?: number | null
  incentivo?: IncentivoReceta
  incentivoConfirmado?: boolean
  /** Máximo 30 días para que una acción personalizada no quede viva indefinidamente. */
  expiraEnHoras?: number
  idempotenciaClave: string
}

export interface EnlacePreparado {
  enlace: EnlaceMarketingPersistido
  /** Sólo se devuelve al actor autenticado al prepararlo; la DB conserva el hash. */
  token: string
  idempotente: boolean
  recomendacion: RecomendacionRecetaCrecimiento
}

function codigoCupon(clienteId: number, idempotenciaClave: string): string {
  return `CRECE-${clienteId}-${hashTokenMarketing(idempotenciaClave).slice(0, 10).toUpperCase()}`
}

function recetaValida(codigo: string | null | undefined): codigo is CodigoRecetaCrecimiento {
  return Boolean(codigo) && Object.values(RECETAS_CRECIMIENTO).some((receta) => receta.codigo === codigo)
}

function recomendar(contexto: ContextoClienteEnlace, input: PrepararEnlaceMarketingInput): RecomendacionRecetaCrecimiento {
  const recetaCodigo = input.recetaCodigo
  if (recetaCodigo && !recetaValida(recetaCodigo)) {
    throw new ErrorPrepararEnlaceMarketing('RECETA_INVALIDA', 'La receta indicada no existe')
  }
  const recomendacion = recomendarRecetaCrecimiento({
    segmento: contexto.segmento,
    esVip: contexto.esVip,
    ultimoCarrito: contexto.ultimoCarrito,
    productoFavorito: contexto.productoFavorito,
    incentivo: input.incentivo,
  })
  // Una receta explícita sirve para ejecutar una oportunidad ya seleccionada,
  // pero nunca permite inventar una receta fuera del catálogo versionado.
  if (recetaCodigo && recetaCodigo !== recomendacion.receta.codigo) {
    const receta = Object.values(RECETAS_CRECIMIENTO).find((item) => item.codigo === recetaCodigo)!
    return {
      ...recomendacion,
      receta,
      tituloOportunidad: receta.nombre,
      textoSugerido: recomendacion.textoSugerido.replace(recomendacion.receta.textoBase, receta.textoBase),
    }
  }
  return recomendacion
}

/**
 * Prepara una acción comercial sin entregarla. La salida de control ocurre
 * antes de devolver el enlace para no contaminar mediciones si el dueño luego
 * lo copia o lo entrega por otro canal.
 */
export async function prepararEnlaceMarketing(
  repositorio: RepositorioEnlacesMarketing,
  restauranteId: number,
  input: PrepararEnlaceMarketingInput,
  generarToken: () => string = generarTokenMarketing,
): Promise<EnlacePreparado> {
  const existente = await repositorio.buscarPorIdempotencia(restauranteId, input.idempotenciaClave)
  if (existente) {
    // El token plano no puede reconstruirse desde el hash. Un reintento seguro
    // no inventa otro token ni crea un segundo cupón/enlace.
    const contexto = await repositorio.cargarCliente(restauranteId, input.clienteId)
    if (!contexto) throw new ErrorPrepararEnlaceMarketing('CLIENTE_NO_ENCONTRADO', 'Cliente no encontrado')
    return { enlace: existente, token: '', idempotente: true, recomendacion: recomendar(contexto, input) }
  }

  const contexto = await repositorio.cargarCliente(restauranteId, input.clienteId)
  if (!contexto) throw new ErrorPrepararEnlaceMarketing('CLIENTE_NO_ENCONTRADO', 'Cliente no encontrado')
  if (input.campanaId != null && !await repositorio.buscarCampana(restauranteId, input.campanaId)) {
    throw new ErrorPrepararEnlaceMarketing('CAMPANA_NO_ENCONTRADA', 'La campaña no pertenece al restaurante')
  }
  if (input.codigoDescuentoId != null && !await repositorio.codigoPertenece(restauranteId, input.codigoDescuentoId)) {
    throw new ErrorPrepararEnlaceMarketing('CUPON_NO_ENCONTRADO', 'El código de descuento no pertenece al restaurante')
  }

  const recomendacion = recomendar(contexto, input)
  const incentivo = recomendacion.incentivoSeleccionado
  if (input.codigoDescuentoId != null && incentivo.descuentoPorcentaje > 0) {
    throw new ErrorPrepararEnlaceMarketing('CUPON_E_INCENTIVO', 'Elegí un cupón existente o confirmá el incentivo, no ambos')
  }
  if (incentivo.descuentoPorcentaje > 0 && input.incentivoConfirmado !== true) {
    throw new ErrorPrepararEnlaceMarketing('INCENTIVO_SIN_CONFIRMAR', 'Confirmá el incentivo antes de crear el cupón')
  }

  const expiraEnHoras = input.expiraEnHoras ?? incentivo.expiraHoras ?? 24 * 30
  const expiraAt = new Date(Date.now() + expiraEnHoras * 60 * 60 * 1000)
  let codigoDescuentoId = input.codigoDescuentoId ?? null
  if (incentivo.descuentoPorcentaje > 0) {
    const cupon = await repositorio.crearCupon(restauranteId, {
      codigo: codigoCupon(input.clienteId, input.idempotenciaClave),
      descuentoPorcentaje: incentivo.descuentoPorcentaje,
      expiraAt,
    })
    codigoDescuentoId = cupon.id
  }

  // La preparación es una acción humana: si había control de una campaña
  // legacy, se reclasifica antes de que exista un enlace utilizable.
  await repositorio.sacarClienteDeControl(restauranteId, input.clienteId)
  const token = generarToken()
  const tokenHash = hashTokenMarketing(token)
  const destino = recomendacion.destino
  try {
    const enlace = await repositorio.crearEnlace({
      restauranteId,
      clienteId: input.clienteId,
      campanaId: input.campanaId ?? null,
      recetaCodigo: recomendacion.receta.codigo,
      tokenHash,
      idempotenciaClave: input.idempotenciaClave,
      destinoTipo: destino.tipo,
      productoId: destino.tipo === 'producto' ? destino.productoId : null,
      carritoRep: destino.tipo === 'carrito' ? destino.carritoRep : null,
      codigoDescuentoId,
      textoSugerido: recomendacion.textoSugerido,
      expiraAt,
    })
    return { enlace, token, idempotente: false, recomendacion }
  } catch (error: any) {
    if (error?.code === 'ER_DUP_ENTRY') throw new ErrorPrepararEnlaceMarketing('TOKEN_COLISION', 'No se pudo reservar el enlace; reintentá la preparación')
    throw error
  }
}
