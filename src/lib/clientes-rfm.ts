// src/lib/clientes-rfm.ts
//
// Cerebro del Motor de Recompra (Parte 4 · tarea 4.1 del ROADMAP).
//
// Toma el historial de pedidos por cliente y devuelve un perfil RFM
// (Recency / Frequency / Monetary) traducido a un estado de ciclo de vida
// que un gastronómico entiende sin explicación:
//   nuevo · activo · vip · en_riesgo · dormido · perdido
//
// El salto de calidad frente a un umbral fijo: la RECENCIA es relativa a la
// CADENCIA INDIVIDUAL de cada cliente. Juan pide cada 9 días y Marta cada 25:
// "20 días sin pedir" es alarma para Juan y ruido para Marta. Aprendemos el
// intervalo típico de cada persona (mediana de sus gaps) y disparamos
// "en riesgo / dormido / perdido" cuando se desvía de SU propio patrón.
//
// Se calcula on-the-fly a partir de los pedidos ya cargados (volumen actual por
// local lo permite y así el dato nunca queda stale). Si a futuro el volumen lo
// pide, este mismo cálculo se puede materializar en una tabla agregada + job
// nocturno sin cambiar la firma pública.

export type SegmentoCliente =
  | 'nuevo'
  | 'activo'
  | 'vip'
  | 'en_riesgo'
  | 'dormido'
  | 'perdido'

// Umbrales del ciclo de vida, expresados como múltiplos de la cadencia del
// cliente (no como días fijos). Un cliente "en riesgo" ya pasó 1,5x su intervalo
// típico; "dormido" 3x; "perdido" 6x. Configuración, no verdad revelada.
export const RIESGO_RATIO = 1.5
export const DORMIDO_RATIO = 3
export const PERDIDO_RATIO = 6

// Cadencia por defecto cuando no hay suficiente historial del local para inferir
// una (ni del cliente ni global). ~3 semanas es un reorder razonable en gastro.
export const CADENCIA_GLOBAL_DEFAULT = 21

// Un cliente es VIP si concentra facturación o pide muy seguido. El umbral de
// monto es relativo al propio local (percentil 85 del gasto), nunca un número
// mágico global.
export const VIP_MIN_PEDIDOS = 6
export const VIP_MONTO_PISO = 50000 // piso para que en locales chicos "VIP" siga significando algo

export interface ClienteRFMInput {
  cantidadPedidos: number
  totalGastado: number
  /** timestamps (ms) de cada pedido no cancelado, en cualquier orden */
  fechasPedidos: number[]
}

export interface PerfilRFM {
  ticketPromedio: number
  /** Intervalo típico entre pedidos del cliente (mediana de gaps), en días. null si tiene < 2 pedidos. */
  cadenciaDias: number | null
  /** Días transcurridos desde el último pedido. null si no tiene pedidos. */
  diasDesdeUltimo: number | null
  segmento: SegmentoCliente
  /** Alto valor para el local, independiente de su recencia (un VIP dormido sigue siendo VIP). */
  esVip: boolean
  /** Frase lista para mostrar, ej: "Pide cada ~9 días" (null si no hay cadencia). */
  resumenCadencia: string | null
}

function mediana(nums: number[]): number | null {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function percentil(nums: number[], p: number): number | null {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[idx]
}

const MS_POR_DIA = 1000 * 60 * 60 * 24

/** Cadencia individual = mediana de los intervalos (en días) entre pedidos consecutivos. */
function calcularCadencia(fechasMs: number[]): number | null {
  if (fechasMs.length < 2) return null
  const sorted = [...fechasMs].sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    const dias = (sorted[i] - sorted[i - 1]) / MS_POR_DIA
    if (dias >= 0) gaps.push(dias)
  }
  const m = mediana(gaps)
  if (m == null) return null
  // La cadencia nunca es menor a 1 día (evita ratios explosivos en clientes que
  // pidieron dos veces el mismo día).
  return Math.max(1, Math.round(m))
}

/**
 * Calcula los perfiles RFM + estado de ciclo de vida de todos los clientes de un
 * local en un solo pase. Se hace en batch porque la cadencia global y el umbral
 * VIP dependen de la distribución del local completo.
 */
export function computarPerfilesRFM(
  clientes: ClienteRFMInput[],
  ahora: number = Date.now(),
): PerfilRFM[] {
  // Pre-cálculo por cliente
  const parciales = clientes.map((c) => {
    const cadenciaDias = calcularCadencia(c.fechasPedidos)
    const ultimoMs = c.fechasPedidos.length > 0 ? Math.max(...c.fechasPedidos) : null
    const diasDesdeUltimo =
      ultimoMs != null ? Math.max(0, Math.floor((ahora - ultimoMs) / MS_POR_DIA)) : null
    const ticketPromedio =
      c.cantidadPedidos > 0 ? c.totalGastado / c.cantidadPedidos : 0
    return { c, cadenciaDias, diasDesdeUltimo, ticketPromedio }
  })

  // Cadencia global del local = mediana de las cadencias individuales conocidas.
  const cadencias = parciales
    .map((p) => p.cadenciaDias)
    .filter((v): v is number => v != null)
  const cadenciaGlobal = mediana(cadencias) ?? CADENCIA_GLOBAL_DEFAULT

  // Umbral de monto VIP = percentil 85 del gasto entre clientes con >= 1 pedido,
  // con un piso para que en locales chicos no sea trivial ser VIP.
  const gastos = parciales
    .filter((p) => p.c.cantidadPedidos > 0)
    .map((p) => p.c.totalGastado)
  const vipMonto = Math.max(VIP_MONTO_PISO, percentil(gastos, 85) ?? VIP_MONTO_PISO)

  return parciales.map(({ c, cadenciaDias, diasDesdeUltimo, ticketPromedio }) => {
    const esVip = c.cantidadPedidos >= VIP_MIN_PEDIDOS || c.totalGastado >= vipMonto

    const cadenciaEfectiva = cadenciaDias ?? cadenciaGlobal
    const ratio = diasDesdeUltimo != null ? diasDesdeUltimo / cadenciaEfectiva : Infinity

    let segmento: SegmentoCliente
    if (c.cantidadPedidos <= 1) {
      // Sin un segundo pedido todavía no existe una cadencia individual ni
      // un hábito que pueda estar "en riesgo". Conservamos `nuevo` sin importar
      // cuánto tiempo haya pasado para recomendar siempre la segunda compra.
      segmento = 'nuevo'
    } else if (ratio >= PERDIDO_RATIO) {
      segmento = 'perdido'
    } else if (ratio >= DORMIDO_RATIO) {
      segmento = 'dormido'
    } else if (ratio >= RIESGO_RATIO) {
      segmento = 'en_riesgo'
    } else if (esVip) {
      segmento = 'vip'
    } else {
      segmento = 'activo'
    }

    return {
      ticketPromedio: Math.round(ticketPromedio),
      cadenciaDias,
      diasDesdeUltimo,
      segmento,
      esVip,
      resumenCadencia: cadenciaDias != null ? `Pide cada ~${cadenciaDias} días` : null,
    }
  })
}
