import type { SegmentoCliente } from './clientes-rfm'

/**
 * Dominio puro de oportunidades de Crecimiento.
 *
 * Este módulo sólo recomienda una acción comercial. No conoce Hono, DB, cupones,
 * WhatsApp ni el wallet de mensajes; persistir y entregar la acción son capas
 * posteriores.
 */

export type CodigoRecetaCrecimiento =
  | 'segunda_compra'
  | 'mantener_ritmo'
  | 'beneficio_vip'
  | 'volver_a_tiempo'
  | 'recuperar_habito'
  | 'ultimo_intento'

export type MetricaPrincipalReceta =
  | 'segunda_compra_revenue'
  | 'pedidos_revenue_atribuido'
  | 'vip_retenidos_revenue'
  | 'recuperados_antes_dormirse'
  | 'reactivados_retorno_neto'
  | 'reactivados_margen_tasa'

export interface IncentivoReceta {
  /** Porcentaje entero entre 0 y 100. Cero significa que no se sugiere descuento. */
  descuentoPorcentaje: number
  /** Duración sugerida del beneficio. null significa sin vencimiento sugerido. */
  expiraHoras: number | null
}

export interface DefinicionRecetaCrecimiento {
  codigo: CodigoRecetaCrecimiento
  segmento: SegmentoCliente
  nombre: string
  descripcion: string
  metricaPrincipal: MetricaPrincipalReceta
  incentivoSugerido: Readonly<IncentivoReceta>
  textoBase: string
}

const SIN_DESCUENTO = Object.freeze({ descuentoPorcentaje: 0, expiraHoras: null })

/** Definiciones versionadas de plataforma. No son un builder configurable por local. */
export const RECETAS_CRECIMIENTO: Readonly<Record<SegmentoCliente, DefinicionRecetaCrecimiento>> =
  Object.freeze({
    nuevo: Object.freeze({
      codigo: 'segunda_compra',
      segmento: 'nuevo',
      nombre: 'Segunda compra',
      descripcion: 'Facilita que un cliente nuevo repita lo que ya eligió.',
      metricaPrincipal: 'segunda_compra_revenue',
      incentivoSugerido: SIN_DESCUENTO,
      textoBase: '¿Repetimos? Te dejamos todo listo para tu segunda compra.',
    }),
    activo: Object.freeze({
      codigo: 'mantener_ritmo',
      segmento: 'activo',
      nombre: 'Mantené su ritmo',
      descripcion: 'Invita al cliente a volver dentro de su cadencia habitual.',
      metricaPrincipal: 'pedidos_revenue_atribuido',
      incentivoSugerido: SIN_DESCUENTO,
      textoBase: 'Ya va siendo hora de volver a disfrutar uno de tus pedidos favoritos.',
    }),
    vip: Object.freeze({
      codigo: 'beneficio_vip',
      segmento: 'vip',
      nombre: 'Beneficio VIP',
      descripcion: 'Reconoce a un cliente de alto valor con una propuesta especial.',
      metricaPrincipal: 'vip_retenidos_revenue',
      incentivoSugerido: SIN_DESCUENTO,
      textoBase: 'Sos parte de nuestros clientes favoritos y preparamos algo especial para vos.',
    }),
    en_riesgo: Object.freeze({
      codigo: 'volver_a_tiempo',
      segmento: 'en_riesgo',
      nombre: 'Volvé a tiempo',
      descripcion: 'Recuerda su pedido habitual antes de que pierda el hábito.',
      metricaPrincipal: 'recuperados_antes_dormirse',
      incentivoSugerido: SIN_DESCUENTO,
      textoBase: 'Tu pedido de siempre está a un toque. ¿Volvemos a encontrarnos?',
    }),
    dormido: Object.freeze({
      codigo: 'recuperar_habito',
      segmento: 'dormido',
      nombre: 'Recuperá el hábito',
      descripcion: 'Propone un incentivo moderado para reactivar al cliente.',
      metricaPrincipal: 'reactivados_retorno_neto',
      incentivoSugerido: Object.freeze({ descuentoPorcentaje: 10, expiraHoras: null }),
      textoBase: 'Hace un tiempo que no nos vemos. Te dejamos tu próximo pedido casi listo.',
    }),
    perdido: Object.freeze({
      codigo: 'ultimo_intento',
      segmento: 'perdido',
      nombre: 'Último intento',
      descripcion: 'Realiza una última propuesta fuerte, limitada en el tiempo.',
      metricaPrincipal: 'reactivados_margen_tasa',
      incentivoSugerido: Object.freeze({ descuentoPorcentaje: 20, expiraHoras: 48 }),
      textoBase: 'Te extrañamos y preparamos una última propuesta para que vuelvas.',
    }),
  })

export interface ItemCarritoReceta {
  productoId: number
  cantidad: number
}

export interface ProductoFavoritoReceta {
  productoId: number
  nombre?: string | null
}

export type DestinoReceta =
  | { tipo: 'carrito'; carritoRep: string }
  | { tipo: 'producto'; productoId: number; nombreProducto: string | null }
  | { tipo: 'tienda' }

/**
 * Conserva el formato que ya interpreta el storefront: `12x2-15x1`.
 * Los ítems inválidos se ignoran y el input nunca se modifica.
 */
export function codificarCarritoReceta(items: readonly ItemCarritoReceta[]): string {
  return items
    .filter((item) => item.productoId > 0 && item.cantidad > 0)
    .map((item) => `${item.productoId}x${item.cantidad}`)
    .join('-')
}

/** Fallback canónico para todas las recetas: último carrito → favorito → tienda. */
export function resolverDestinoReceta(params: {
  ultimoCarrito?: readonly ItemCarritoReceta[] | null
  productoFavorito?: ProductoFavoritoReceta | null
}): DestinoReceta {
  const carritoRep = codificarCarritoReceta(params.ultimoCarrito ?? [])
  if (carritoRep) return { tipo: 'carrito', carritoRep }

  const favorito = params.productoFavorito
  if (favorito && favorito.productoId > 0) {
    return {
      tipo: 'producto',
      productoId: favorito.productoId,
      nombreProducto: favorito.nombre?.trim() || null,
    }
  }

  return { tipo: 'tienda' }
}

export type MotivoInelegibilidadReceta = 'opt_out' | 'cooldown' | 'presion_marketing'

export interface BloqueoReceta {
  motivo: MotivoInelegibilidadReceta
  mensaje: string
}

export interface ElegibilidadReceta {
  elegible: boolean
  bloqueos: BloqueoReceta[]
}

/**
 * Evalúa barreras comerciales ya resueltas por el caller. Es deliberadamente
 * independiente de saldo, credenciales, WhatsApp, horario y canal de entrega.
 */
export function resolverElegibilidadReceta(params: {
  marketingOptOut?: boolean
  enCooldown?: boolean
  presionMarketingAlcanzada?: boolean
}): ElegibilidadReceta {
  const bloqueos: BloqueoReceta[] = []

  if (params.marketingOptOut) {
    bloqueos.push({
      motivo: 'opt_out',
      mensaje: 'El cliente pidió no recibir acciones de marketing.',
    })
  }
  if (params.enCooldown) {
    bloqueos.push({
      motivo: 'cooldown',
      mensaje: 'Todavía está dentro del período de espera entre contactos.',
    })
  }
  if (params.presionMarketingAlcanzada) {
    bloqueos.push({
      motivo: 'presion_marketing',
      mensaje: 'Alcanzó el límite de presión de marketing permitido.',
    })
  }

  return { elegible: bloqueos.length === 0, bloqueos }
}

function validarIncentivo(incentivo: IncentivoReceta): IncentivoReceta {
  if (
    !Number.isInteger(incentivo.descuentoPorcentaje)
    || incentivo.descuentoPorcentaje < 0
    || incentivo.descuentoPorcentaje > 100
  ) {
    throw new RangeError('El descuento debe ser un porcentaje entero entre 0 y 100.')
  }
  if (
    incentivo.expiraHoras != null
    && (!Number.isInteger(incentivo.expiraHoras) || incentivo.expiraHoras <= 0)
  ) {
    throw new RangeError('El vencimiento debe ser una cantidad entera positiva de horas o null.')
  }

  return { ...incentivo }
}

function describirDestino(destino: DestinoReceta): string {
  if (destino.tipo === 'carrito') return 'Abrí el enlace y vas a encontrar tu pedido armado.'
  if (destino.tipo === 'producto') {
    return destino.nombreProducto
      ? `Tu ${destino.nombreProducto} favorito te está esperando.`
      : 'Tu favorito te está esperando.'
  }
  return 'Entrá a la tienda y elegí lo que más te guste.'
}

function describirIncentivo(incentivo: IncentivoReceta): string | null {
  if (incentivo.descuentoPorcentaje === 0) return null
  const vencimiento = incentivo.expiraHoras != null
    ? ` Vence en ${incentivo.expiraHoras} horas.`
    : ''
  return `Tenés un ${incentivo.descuentoPorcentaje}% de descuento.${vencimiento}`
}

export interface RecomendacionRecetaCrecimiento {
  receta: DefinicionRecetaCrecimiento
  segmento: SegmentoCliente
  esVip: boolean
  esVipEnfriado: boolean
  prioridad: 'normal' | 'alta'
  tituloOportunidad: string
  destino: DestinoReceta
  incentivoSugerido: IncentivoReceta
  incentivoSeleccionado: IncentivoReceta
  incentivoFueEditado: boolean
  textoSugerido: string
  elegibilidad: ElegibilidadReceta
}

export interface RecomendarRecetaParams {
  segmento: SegmentoCliente
  esVip: boolean
  ultimoCarrito?: readonly ItemCarritoReceta[] | null
  productoFavorito?: ProductoFavoritoReceta | null
  /** undefined conserva la sugerencia; un valor, incluido 0%, la reemplaza. */
  incentivo?: IncentivoReceta
  marketingOptOut?: boolean
  enCooldown?: boolean
  presionMarketingAlcanzada?: boolean
}

/** Construye una recomendación completa sin persistir ni ejecutar ninguna acción. */
export function recomendarRecetaCrecimiento(
  params: RecomendarRecetaParams,
): RecomendacionRecetaCrecimiento {
  const receta = RECETAS_CRECIMIENTO[params.segmento]
  const incentivoSugerido = { ...receta.incentivoSugerido }
  const incentivoSeleccionado = validarIncentivo(params.incentivo ?? incentivoSugerido)
  const incentivoFueEditado = params.incentivo != null && (
    incentivoSeleccionado.descuentoPorcentaje !== incentivoSugerido.descuentoPorcentaje
    || incentivoSeleccionado.expiraHoras !== incentivoSugerido.expiraHoras
  )
  const destino = resolverDestinoReceta(params)
  const esVipEnfriado = params.esVip && (
    params.segmento === 'en_riesgo'
    || params.segmento === 'dormido'
    || params.segmento === 'perdido'
  )
  const partesTexto = [receta.textoBase, describirDestino(destino)]
  const textoIncentivo = describirIncentivo(incentivoSeleccionado)
  if (textoIncentivo) partesTexto.push(textoIncentivo)
  partesTexto.push('{{enlace}}')

  return {
    receta,
    segmento: params.segmento,
    esVip: params.esVip,
    esVipEnfriado,
    prioridad: esVipEnfriado || params.segmento === 'vip' ? 'alta' : 'normal',
    tituloOportunidad: esVipEnfriado
      ? `VIP ${receta.nombre.toLocaleLowerCase('es-AR')}`
      : receta.nombre,
    destino,
    incentivoSugerido,
    incentivoSeleccionado,
    incentivoFueEditado,
    textoSugerido: partesTexto.join(' '),
    elegibilidad: resolverElegibilidadReceta(params),
  }
}
