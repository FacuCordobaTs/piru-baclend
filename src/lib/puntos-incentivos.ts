// src/lib/puntos-incentivos.ts
//
// El Club de Puntos como INCENTIVO de campañas y del Motor de Recompra.
//
// Regla central: los puntos no son un descuento disfrazado. Un descuento se paga en el acto
// (margen que se entrega seguro); un bonus de puntos se acredita recién cuando el pedido se
// cobra y sólo si el pedido alcanza la compra mínima que hace que esos puntos valgan una
// fracción acotada del ticket. Eso permite premiar la recompra sin regalar margen a quien
// igual iba a comprar.
//
// El módulo es puro: sin DB, sin Hono, sin WhatsApp. Las rutas y el motor le pasan la
// configuración del local y los contadores; acá viven los topes, la recomendación y el texto.

export interface ConfigIncentivosPuntos {
  activo: boolean
  /** Pesos que hay que gastar para ganar un punto (configuración de acumulación). */
  pesosPorPunto: number
  puntosMinimosCanje: number
  permiteCanjeEnvioGratis: boolean
  puntosEnvioGratis: number
  permiteCanjeDescuento: boolean
  descuentoTipo: 'fijo' | 'porcentaje'
  descuentoValor: number
  descuentoPuntosCosto: number
  /** Techo duro de puntos por pedido. */
  puntosBonusMaximo: number
  /** Cuánto vale el bonus, como máximo, respecto del ticket (porcentaje entero). */
  puntosBonusTopePorcentaje: number
  /** Cuántos bonuses puede recibir un mismo cliente en 30 días. */
  puntosBonusPorCliente30Dias: number
}

export const PUNTOS_BONUS_TOPE_PORCENTAJE_DEFAULT = 12
export const PUNTOS_BONUS_MAXIMO_DEFAULT = 500
export const PUNTOS_BONUS_POR_CLIENTE_30_DIAS_DEFAULT = 2
export const PUNTOS_BONUS_TOPE_PORCENTAJE_MAX = 50

/** Vigencia del link con bonus de puntos. Más larga que el 20 % de 48 hs: no hay urgencia de margen. */
export const PUNTOS_BONUS_VIGENCIA_HORAS = 24 * 7

export interface PremioPuntos {
  tipo: 'envio' | 'descuento'
  /** Puntos que hay que canjear. */
  costo: number
  descripcion: string
}

/**
 * Valor interno de un punto, en pesos. Sale del canje configurado, que es el único lugar donde
 * el local declara cuánto valen sus puntos. Si no hay canje monetario configurado se usa $1 por
 * punto: es una referencia conservadora para los topes, no una promesa al cliente.
 */
export function valorPuntoEnPesos(config: ConfigIncentivosPuntos): number {
  const costo = Math.max(0, Math.trunc(config.descuentoPuntosCosto))
  const valor = Math.max(0, Number(config.descuentoValor) || 0)
  if (config.permiteCanjeDescuento && config.descuentoTipo === 'fijo' && costo > 0 && valor > 0) {
    return valor / costo
  }
  return 1
}

export function topeValorPuntosEnPesos(config: ConfigIncentivosPuntos, montoCompra: number): number {
  const porcentaje = Math.min(
    Math.max(Number(config.puntosBonusTopePorcentaje) || 0, 0),
    PUNTOS_BONUS_TOPE_PORCENTAJE_MAX,
  )
  return Math.max(0, montoCompra) * porcentaje / 100
}

/** Máximo de puntos que un pedido de ese monto puede otorgar sin comerse el margen. */
export function maximoPuntosParaCompra(config: ConfigIncentivosPuntos, montoCompra: number): number {
  if (!config.activo || montoCompra <= 0) return 0
  const porValor = Math.floor(topeValorPuntosEnPesos(config, montoCompra) / valorPuntoEnPesos(config))
  return Math.max(0, Math.min(Math.trunc(config.puntosBonusMaximo), porValor))
}

/**
 * Compra mínima que hace que un bonus de `puntos` respete el techo de valor. El mensaje la
 * anuncia y el checkout la exige: el cliente nunca recibe menos puntos de los que se le prometió.
 */
export function compraMinimaParaPuntos(config: ConfigIncentivosPuntos, puntos: number): number {
  const cantidad = Math.max(0, Math.trunc(puntos))
  if (cantidad === 0) return 0
  const porcentaje = Math.min(
    Math.max(Number(config.puntosBonusTopePorcentaje) || 0, 1),
    PUNTOS_BONUS_TOPE_PORCENTAJE_MAX,
  )
  const valor = cantidad * valorPuntoEnPesos(config)
  return Math.ceil(valor / (porcentaje / 100) / 100) * 100
}

export function premiosDisponibles(config: ConfigIncentivosPuntos): PremioPuntos[] {
  const premios: PremioPuntos[] = []
  if (config.permiteCanjeEnvioGratis && config.puntosEnvioGratis > 0) {
    premios.push({ tipo: 'envio', costo: config.puntosEnvioGratis, descripcion: 'un envío gratis' })
  }
  if (config.permiteCanjeDescuento && config.descuentoPuntosCosto > 0) {
    const valor = Math.max(0, Number(config.descuentoValor) || 0)
    const descripcion = config.descuentoTipo === 'porcentaje'
      ? `${valor}% de descuento`
      : `${formatearPesos(valor)} de descuento`
    premios.push({ tipo: 'descuento', costo: config.descuentoPuntosCosto, descripcion })
  }
  return premios.sort((a, b) => a.costo - b.costo)
}

export interface EstadoSaldoPuntos {
  saldo: number
  premios: PremioPuntos[]
  /** El mejor premio que el saldo ya alcanza (el más caro de los alcanzables). */
  premioAlcanzado: PremioPuntos | null
  /** El premio más cercano que todavía no alcanza. */
  premioCercano: (PremioPuntos & { faltan: number }) | null
}

export function estadoSaldoPuntos(config: ConfigIncentivosPuntos, saldo: number): EstadoSaldoPuntos {
  const disponible = Math.max(0, Math.trunc(saldo))
  const minimo = Math.max(0, Math.trunc(config.puntosMinimosCanje))
  const premios = premiosDisponibles(config).map((premio) => ({
    ...premio,
    costo: Math.max(premio.costo, minimo),
  }))
  const alcanzables = premios.filter((premio) => premio.costo <= disponible)
  const cercanos = premios
    .filter((premio) => premio.costo > disponible)
    .sort((a, b) => a.costo - b.costo)
  return {
    saldo: disponible,
    premios,
    premioAlcanzado: alcanzables.at(-1) ?? null,
    premioCercano: cercanos[0] ? { ...cercanos[0], faltan: cercanos[0].costo - disponible } : null,
  }
}

export interface BienestarPuntos {
  puedeCanjear: boolean
  /** Vale la pena recordarle sus puntos antes de ofrecerle un descuento. */
  convieneRecordar: boolean
  premio: PremioPuntos | null
  faltan: number
}

/**
 * ¿El saldo del cliente alcanza para un premio, o está lo bastante cerca como para que un
 * recordatorio lo mueva? En los dos casos recordar sus puntos cuesta cero y evita un descuento.
 * "Cerca" es 25 % del costo del premio, con un piso de 50 puntos.
 */
export function evaluarSaldoParaRecordatorio(config: ConfigIncentivosPuntos, saldo: number): BienestarPuntos {
  const estado = estadoSaldoPuntos(config, saldo)
  if (estado.premioAlcanzado) {
    return { puedeCanjear: true, convieneRecordar: true, premio: estado.premioAlcanzado, faltan: 0 }
  }
  const cercano = estado.premioCercano
  if (!cercano) return { puedeCanjear: false, convieneRecordar: false, premio: null, faltan: 0 }
  const margen = Math.max(50, Math.round(cercano.costo * 0.25))
  return {
    puedeCanjear: false,
    convieneRecordar: cercano.faltan <= margen,
    premio: cercano,
    faltan: cercano.faltan,
  }
}

export interface SolicitudBonusPuntos {
  config: ConfigIncentivosPuntos
  puntos: number
  montoCompra: number
  minimoCompra?: number
  otorgadosCliente30Dias: number
}

export interface ResultadoBonusPuntos {
  permitido: boolean
  puntos: number
  valorEstimadoPesos: number
  /** Se recortó el pedido del operador o de la campaña para cuidar el margen. */
  recortado: boolean
  motivo: string | null
}

/**
 * Autoriza un bonus concreto. Es la aduana que comparten el link de campaña, el link personal
 * del motor y el checkout: no se otorga si el club está pausado, si el pedido no llega al mínimo,
 * si el cliente ya recibió su cupo de bonuses o si el valor de los puntos se pasa del techo.
 */
export function evaluarBonusPuntos(solicitud: SolicitudBonusPuntos): ResultadoBonusPuntos {
  const { config } = solicitud
  const no = (motivo: string): ResultadoBonusPuntos => ({
    permitido: false, puntos: 0, valorEstimadoPesos: 0, recortado: false, motivo,
  })
  if (!config.activo) return no('El club de puntos está pausado')
  const pedidos = Math.trunc(Number(solicitud.puntos))
  if (!Number.isFinite(pedidos) || pedidos <= 0) return no('No hay puntos para otorgar')
  const minimo = Math.max(0, Number(solicitud.minimoCompra) || 0)
  const monto = Math.max(0, Number(solicitud.montoCompra) || 0)
  if (monto < minimo) {
    return no(`El pedido no alcanza la compra mínima de ${formatearPesos(minimo)}`)
  }
  const topeCliente = Math.max(0, Math.trunc(config.puntosBonusPorCliente30Dias))
  if (solicitud.otorgadosCliente30Dias >= topeCliente) {
    return no('El cliente ya recibió su cupo de puntos extra de este mes')
  }
  const maximo = maximoPuntosParaCompra(config, monto)
  if (maximo < 1) return no('El pedido es demasiado chico para un bonus de puntos')
  const puntos = Math.min(pedidos, maximo)
  return {
    permitido: true,
    puntos,
    valorEstimadoPesos: puntos * valorPuntoEnPesos(config),
    recortado: puntos < pedidos,
    motivo: puntos < pedidos ? 'Se ajustó el bonus para no superar el techo de margen' : null,
  }
}

export interface SolicitudSugerenciaPuntos {
  config: ConfigIncentivosPuntos
  ticketPromedio: number
  /** `%` del escalón al que reemplaza. 0 en el primer toque. */
  descuentoEscalon: number
  otorgadosCliente30Dias?: number
}

export interface SugerenciaBonusPuntos {
  puntos: number
  compraMinima: number
  valorEstimadoPesos: number
}

/**
 * Cuántos puntos ofrecer cuando el operador elige "sumar puntos". Si reemplaza un descuento,
 * se ofrece el equivalente en valor, acotado por el techo de margen. En el primer toque (sin
 * descuento) el bonus es simbólico: alcanza para mover al cliente sin abrir la billetera.
 */
export function sugerirBonusPuntos(solicitud: SolicitudSugerenciaPuntos): SugerenciaBonusPuntos | null {
  const { config } = solicitud
  if (!config.activo) return null
  const ticket = Math.max(0, Number(solicitud.ticketPromedio) || 0)
  if (ticket <= 0) return null
  const topeCliente = Math.max(0, Math.trunc(config.puntosBonusPorCliente30Dias))
  if ((solicitud.otorgadosCliente30Dias ?? 0) >= topeCliente) return null
  const proporcion = solicitud.descuentoEscalon > 0 ? solicitud.descuentoEscalon / 100 : 0.03
  const valorObjetivo = ticket * proporcion
  const puntosBase = Math.floor(valorObjetivo / valorPuntoEnPesos(config))
  const tope = Math.min(Math.trunc(config.puntosBonusMaximo), maximoPuntosParaCompra(config, ticket))
  const redondeado = puntosBase >= 10 ? Math.floor(puntosBase / 10) * 10 : puntosBase
  const puntos = Math.min(Math.max(redondeado, 1), tope)
  if (puntos < 1) return null
  return {
    puntos,
    compraMinima: compraMinimaParaPuntos(config, puntos),
    valorEstimadoPesos: puntos * valorPuntoEnPesos(config),
  }
}

export type RecomendacionPuntos =
  | {
      tipo: 'usar_saldo'
      saldo: number
      premio: PremioPuntos | null
      faltan: number
      puedeCanjear: boolean
      linea: string
    }
  | {
      tipo: 'bonus'
      puntos: number
      compraMinima: number
      valorEstimadoPesos: number
      linea: string
    }

/**
 * La decisión "inteligente" para el envío automático: antes de ofrecer un descuento, recordar
 * los puntos que el cliente ya tiene (cuesta cero). Sólo si no hay saldo utilizable ni cerca,
 * deja la decisión en manos de la escalera de descuentos. El bonus en automático NO se ofrece
 * solo: se elige a mano o se configura en una campaña, para no acumular pasivos sin que el
 * dueño lo haya decidido.
 */
export function recomendarPuntosParaRecompra(solicitud: SolicitudSugerenciaPuntos & {
  saldoPuntos: number
}): RecomendacionPuntos | null {
  if (!solicitud.config.activo) return null
  const saldo = evaluarSaldoParaRecordatorio(solicitud.config, solicitud.saldoPuntos)
  if (saldo.convieneRecordar) {
    return {
      tipo: 'usar_saldo',
      saldo: Math.max(0, Math.trunc(solicitud.saldoPuntos)),
      premio: saldo.premio,
      faltan: saldo.faltan,
      puedeCanjear: saldo.puedeCanjear,
      linea: lineaUsarPuntos({
        saldo: Math.max(0, Math.trunc(solicitud.saldoPuntos)),
        premio: saldo.premio,
        faltan: saldo.faltan,
        puedeCanjear: saldo.puedeCanjear,
      }),
    }
  }
  return null
}

export function lineaBonusPuntos(puntos: number, compraMinima = 0): string {
  const cantidad = Math.max(0, Math.trunc(puntos))
  const desde = compraMinima > 0 ? ` en un pedido desde ${formatearPesos(compraMinima)}` : ''
  return `Sumás ${cantidad} puntos extra${desde}. Se acreditan al cobrarse el pedido.`
}

export function lineaUsarPuntos(params: {
  saldo: number
  premio: PremioPuntos | null
  faltan: number
  puedeCanjear: boolean
}): string {
  const saldo = Math.max(0, Math.trunc(params.saldo))
  if (params.puedeCanjear) {
    return `Tenés ${saldo} puntos: canjealos por ${params.premio?.descripcion ?? 'un premio del club'} en tu próximo pedido.`
  }
  if (params.premio && params.faltan > 0) {
    return `Estás a ${params.faltan} puntos de ${params.premio.descripcion}: tu próximo pedido te acerca.`
  }
  return `Tenés ${saldo} puntos esperándote en el club.`
}

/** Texto corto para la UI y los reportes, sin prometer un `%` que no existe. */
export function etiquetaBeneficioPuntos(puntos: number, compraMinima = 0): string {
  return compraMinima > 0
    ? `+${Math.trunc(puntos)} puntos desde ${formatearPesos(compraMinima)}`
    : `+${Math.trunc(puntos)} puntos`
}

function formatearPesos(valor: number): string {
  try {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(valor)
  } catch {
    return `$${Math.round(valor)}`
  }
}
