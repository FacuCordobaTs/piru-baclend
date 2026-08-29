import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { CodigoRecetaCrecimiento, IncentivoReceta, ItemCarritoReceta, ProductoFavoritoReceta } from './recetas-crecimiento'
import { RECETAS_CRECIMIENTO, recomendarRecetaCrecimiento, type RecomendacionRecetaCrecimiento } from './recetas-crecimiento'
import type { SegmentoCliente } from './clientes-rfm'

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
