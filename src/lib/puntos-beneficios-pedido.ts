// src/lib/puntos-beneficios-pedido.ts
//
// Puente entre el alta del pedido y el Club de Puntos: resuelve, valida y deja escrito en el
// pedido el bonus de puntos de un link de campaña o de un link personal del Motor de Recompra.
//
// El cliente no decide cuántos puntos recibe: el monto viaja firmado dentro del token del link
// (AES-GCM) o sale de la campaña en la base. El navegador sólo puede decir "entré por este link".
// El bonus se acredita recién cuando `acreditarPuntosPedidoAprobado` ve el pedido pagado.

import { and, eq, gte, gt, ne, sql } from 'drizzle-orm'
import {
  cliente as ClienteTable,
  marketingCampana as MarketingCampanaTable,
  pedidoUnificado as PedidoUnificadoTable,
} from '../db/schema'
import { MODULE_KEYS, tieneModuloActivo } from './modulos'
import { descifrarGrowthPayload } from './marketing-crypto'
import { obtenerConfiguracionPuntos, type ConfiguracionPuntosData } from './puntos'
import {
  evaluarBonusPuntos,
  type ConfigIncentivosPuntos,
  type ResultadoBonusPuntos,
} from './puntos-incentivos'

const MS_POR_DIA = 24 * 60 * 60 * 1000
const DIA_BONUS_CLIENTE = 30

export interface PoliticaIncentivosPuntos {
  disponible: boolean
  config: ConfigIncentivosPuntos | null
  configCruda: ConfiguracionPuntosData | null
}

/** Configuración del club traducida al vocabulario de incentivos. `disponible` exige módulo y club activos. */
export async function cargarPoliticaIncentivosPuntos(
  db: any,
  restauranteId: number,
): Promise<PoliticaIncentivosPuntos> {
  // El incentivo de puntos es opcional: si el gate o la configuración no se pueden leer, la
  // recompra y el alta del pedido siguen sin él. Nunca es motivo para romper un mensaje o una venta.
  try {
    const moduloActivo = await tieneModuloActivo(db, restauranteId, MODULE_KEYS.PUNTOS_CLIENTES)
    if (!moduloActivo) return { disponible: false, config: null, configCruda: null }
    const configCruda = await obtenerConfiguracionPuntos(db, restauranteId)
    const config = aConfigIncentivos(configCruda)
    return { disponible: config.activo, config, configCruda }
  } catch {
    return { disponible: false, config: null, configCruda: null }
  }
}

export function aConfigIncentivos(config: ConfiguracionPuntosData): ConfigIncentivosPuntos {
  return {
    activo: Boolean(config.activo),
    pesosPorPunto: Math.max(1, Number(config.pesosPorPunto) || 100),
    puntosMinimosCanje: Math.max(0, Number(config.puntosMinimosCanje) || 0),
    permiteCanjeEnvioGratis: Boolean(config.permiteCanjeEnvioGratis ?? config.permitirCanjeEnvioGratis),
    puntosEnvioGratis: Math.max(0, Number(config.puntosEnvioGratis) || 0),
    permiteCanjeDescuento: Boolean(config.permiteCanjeDescuento ?? config.permitirCanjeDescuento),
    descuentoTipo: config.descuentoTipo === 'porcentaje' ? 'porcentaje' : 'fijo',
    descuentoValor: Math.max(0, Number(config.descuentoValor) || 0),
    descuentoPuntosCosto: Math.max(0, Number(config.descuentoPuntosCosto) || 0),
    puntosBonusTopePorcentaje: Math.max(1, Number(config.puntosBonusTopePorcentaje) || 12),
    puntosBonusMaximo: Math.max(1, Number(config.puntosBonusMaximo) || 500),
    puntosBonusPorCliente30Dias: Math.max(0, Number(config.puntosBonusPorCliente30Dias) || 0),
  }
}

/** Cuántos pedidos con bonus recibió el cliente en los últimos 30 días (cancelados no cuentan). */
export async function contarBonusPuntosCliente(
  db: any,
  restauranteId: number,
  clienteId: number,
  ahora: Date = new Date(),
): Promise<number> {
  const desde = new Date(ahora.getTime() - DIA_BONUS_CLIENTE * MS_POR_DIA)
  const [fila] = await db
    .select({ total: sql<number>`count(*)` })
    .from(PedidoUnificadoTable)
    .where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId),
      eq(PedidoUnificadoTable.clienteId, clienteId),
      gt(PedidoUnificadoTable.puntosBonus, 0),
      ne(PedidoUnificadoTable.estado, 'cancelled'),
      gte(PedidoUnificadoTable.createdAt, desde),
    ))
  return Math.max(0, Number(fila?.total) || 0)
}

async function contarBonusPuntosCampana(
  db: any,
  restauranteId: number,
  campanaId: number,
  clienteId?: number,
  soloPagados = false,
): Promise<number> {
  const condiciones = [
    eq(PedidoUnificadoTable.restauranteId, restauranteId),
    eq(PedidoUnificadoTable.marketingCampanaId, campanaId),
    gt(PedidoUnificadoTable.puntosBonus, 0),
    ne(PedidoUnificadoTable.estado, 'cancelled'),
  ]
  if (clienteId != null) condiciones.push(eq(PedidoUnificadoTable.clienteId, clienteId))
  if (soloPagados) condiciones.push(eq(PedidoUnificadoTable.pagado, true))
  const [fila] = await db
    .select({ total: sql<number>`count(*)` })
    .from(PedidoUnificadoTable)
    .where(and(...condiciones))
  return Math.max(0, Number(fila?.total) || 0)
}

export interface ResolucionBonusPuntos {
  puntos: number
  origen: 'campana' | 'recompra' | null
  campanaId: number | null
  minimoCompra: number
  /** Idempotencia del bonus: el nonce del link personal o NULL para la clave del pedido. */
  clave: string | null
  motivo: string | null
}

const SIN_BONUS = (motivo: string | null = null): ResolucionBonusPuntos => ({
  puntos: 0,
  origen: null,
  campanaId: null,
  minimoCompra: 0,
  clave: null,
  motivo,
})

/**
 * Resuelve el bonus del pedido. Tiene dos fuentes excluyentes:
 *   1. el token personal de recompra (firmado; manda el monto y la compra mínima);
 *   2. la campaña pública por slug (configuración en la base).
 * Nunca se suman: un pedido recibe un solo bonus.
 */
export async function resolverBonusPuntosPedido(
  db: any,
  params: {
    restauranteId: number
    clienteId: number | null
    /** Subtotal de productos, sin envío ni cupón: la base del techo de margen. */
    totalProductos: number
    marketingCampanaId: number | null
    recetaToken?: string | null
  },
): Promise<ResolucionBonusPuntos> {
  if (!params.clienteId || params.totalProductos <= 0) return SIN_BONUS()
  const politica = await cargarPoliticaIncentivosPuntos(db, params.restauranteId)
  if (!politica.disponible || !politica.config) return SIN_BONUS('El club de puntos está pausado')

  const [cliente] = await db
    .select({ id: ClienteTable.id })
    .from(ClienteTable)
    .where(and(
      eq(ClienteTable.restauranteId, params.restauranteId),
      eq(ClienteTable.id, params.clienteId),
    ))
    .limit(1)
  if (!cliente) return SIN_BONUS('Cliente no encontrado')

  const otorgadosCliente = await contarBonusPuntosCliente(db, params.restauranteId, params.clienteId)

  const token = params.recetaToken?.startsWith('v1.')
    ? descifrarGrowthPayload(params.recetaToken)
    : null
  if (token?.puntos && token.puntos > 0) {
    const tokenDelCliente = token.rId === params.restauranteId && token.cId === params.clienteId
    const vigente = token.exp == null || token.exp >= Date.now()
    if (!tokenDelCliente || !vigente) return SIN_BONUS('El link personal no corresponde a este cliente o venció')
    const claveToken = token.nonce ? `link-puntos:${token.nonce}` : null
    if (claveToken) {
      const [usado] = await db
        .select({ id: PedidoUnificadoTable.id })
        .from(PedidoUnificadoTable)
        .where(and(
          eq(PedidoUnificadoTable.restauranteId, params.restauranteId),
          eq(PedidoUnificadoTable.puntosBonusClave, claveToken),
          ne(PedidoUnificadoTable.estado, 'cancelled'),
        ))
        .limit(1)
      if (usado) return SIN_BONUS('El link ya se usó para un pedido anterior')
    }
    const evaluado = evaluarBonusPuntos({
      config: politica.config,
      puntos: token.puntos,
      montoCompra: params.totalProductos,
      minimoCompra: Math.max(0, Number(token.pmin) || 0),
      otorgadosCliente30Dias: otorgadosCliente,
    })
    return resolverDesdeEvaluacion(
      evaluado,
      'recompra',
      null,
      Math.max(0, Number(token.pmin) || 0),
      claveToken,
    )
  }

  if (!params.marketingCampanaId) return SIN_BONUS()
  const [campana] = await db
    .select({
      id: MarketingCampanaTable.id,
      estado: MarketingCampanaTable.estado,
      beneficioTipo: MarketingCampanaTable.beneficioTipo,
      puntosBeneficio: MarketingCampanaTable.puntosBeneficio,
      puntosMontoMinimo: MarketingCampanaTable.puntosMontoMinimo,
      puntosLimiteOtorgamientos: MarketingCampanaTable.puntosLimiteOtorgamientos,
      puntosLimitePorCliente: MarketingCampanaTable.puntosLimitePorCliente,
      diaSemana: MarketingCampanaTable.diaSemana,
      fechaInicio: MarketingCampanaTable.fechaInicio,
      fechaFin: MarketingCampanaTable.fechaFin,
    })
    .from(MarketingCampanaTable)
    .where(and(
      eq(MarketingCampanaTable.restauranteId, params.restauranteId),
      eq(MarketingCampanaTable.id, params.marketingCampanaId),
    ))
    .limit(1)
  if (!campana) return SIN_BONUS('Campaña no encontrada')
  if (campana.estado !== 'activa' || campana.beneficioTipo !== 'puntos') return SIN_BONUS()

  const ahora = new Date()
  const vigente = (campana.diaSemana == null || new Date(ahora.getTime() - 3 * 3600000).getUTCDay() === campana.diaSemana)
    && (!campana.fechaInicio || new Date(campana.fechaInicio) <= ahora)
    && (!campana.fechaFin || new Date(campana.fechaFin) >= ahora)
  if (!vigente) return SIN_BONUS('La campaña no está vigente hoy')

  const otorgadosCampana = await contarBonusPuntosCampana(db, params.restauranteId, campana.id, undefined, true)
  if (campana.puntosLimiteOtorgamientos != null && otorgadosCampana >= campana.puntosLimiteOtorgamientos) {
    return SIN_BONUS('La campaña agotó su presupuesto de puntos')
  }
  const otorgadosDelCliente = await contarBonusPuntosCampana(db, params.restauranteId, campana.id, params.clienteId)
  if (otorgadosDelCliente >= Math.max(1, campana.puntosLimitePorCliente ?? 1)) {
    return SIN_BONUS('El cliente ya recibió los puntos de esta campaña')
  }

  const minimo = Math.max(0, Number(campana.puntosMontoMinimo) || 0)
  const evaluado = evaluarBonusPuntos({
    config: politica.config,
    puntos: campana.puntosBeneficio,
    montoCompra: params.totalProductos,
    minimoCompra: minimo,
    otorgadosCliente30Dias: otorgadosCliente,
  })
  return resolverDesdeEvaluacion(evaluado, 'campana', campana.id, minimo, null)
}

function resolverDesdeEvaluacion(
  evaluado: ResultadoBonusPuntos,
  origen: 'campana' | 'recompra',
  campanaId: number | null,
  minimoCompra: number,
  clave: string | null,
): ResolucionBonusPuntos {
  if (!evaluado.permitido) return SIN_BONUS(evaluado.motivo)
  return {
    puntos: evaluado.puntos,
    origen,
    campanaId,
    minimoCompra,
    clave,
    motivo: evaluado.motivo,
  }
}
