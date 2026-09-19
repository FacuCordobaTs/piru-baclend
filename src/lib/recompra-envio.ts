// src/lib/recompra-envio.ts
//
// QUÉ SE VA A MANDAR en un toque del Motor de Recompra: el toque (el copy), el link y el descuento.
// Es la decisión que después se escribe en la cola y en el ledger y la que decide si se emite un
// cupón —o sea, plata—, así que vive aparte de `recupero.ts` para poder fijarla con tests: ese módulo
// abre el pool de MySQL al importarse y nada que quieran fijar los tests puede vivir ahí.
//
// Los DOS EJES no se mezclan, y esa es la regla central de este módulo:
//   · TOQUE   = qué copy sale (relato, recordatorio, cierre). Lo elige el operador, que puede mandar
//               el cierre antes de tiempo si le parece: es una decisión editorial, no de beneficio.
//   · ESCALÓN = cuánto se descuenta. Es SIEMPRE el del escalón de la escalera: mandar el copy del 3º
//               no adelanta el 20 %, y elegir otra receta tampoco reinicia el avance del cliente.
// Por eso el `nivel` que se registra sale del escalón y no del toque.
//
// Dominio puro: sin DB, sin Hono, sin WhatsApp.

import {
  type BeneficioRecompra,
  DESCUENTO_MAX,
  type EscalonIncentivo,
  type ModalidadLink,
  normalizarToque,
  type RecetaRecompra,
  resolverBeneficioRecompra,
  type ToqueRecompra,
} from './recetas-recompra'

/** De dónde salió el `%` que se va a mandar. Se guarda para poder auditar la decisión. */
export type OrigenDescuento = 'escalon' | 'receta' | 'manual'

export interface DecisionEnvioRecompra {
  /** El copy que sale, ya normalizado a 1..3. */
  toque: ToqueRecompra
  link: ModalidadLink
  /** El `%` EFECTIVO: 0 cuando el link es `lo-mismo`. */
  descuento: number
  descuentoOrigen: OrigenDescuento
  /** Beneficio efectivo, con el `%` y el vencimiento que se van a anunciar. */
  beneficio: BeneficioRecompra
  /** El `%` que propone la receta/escalera, antes de la decisión del operador. */
  beneficioBase: BeneficioRecompra
  /** El cupón es el MECANISMO DE COBRO: sin descuento no hay nada que cobrar ni que emitir. */
  emiteCupon: boolean
}

export interface EntradaEnvioRecompra {
  /** El escalón que le toca al cliente: es la autoridad del `%`. */
  escalon: EscalonIncentivo
  /** Nivel de la escalera (1..3), que es el que avanza — no el toque. */
  proximoNivel: number
  /** La receta del segmento elegido: la recomendada o la que eligió el operador. */
  receta: RecetaRecompra
  esRecetaRecomendada: boolean
  /** Toque elegido a mano. Si falta, el que marca la escalera. */
  toque?: number | null
  /** Link elegido a mano. Si falta, lo decide el descuento. */
  link?: ModalidadLink | null
  /** `%` elegido a mano (0..30). Si falta, el de la receta (que para la recomendada es el escalón). */
  descuento?: number | null
}

/**
 * Resuelve el envío. El descuento a mano gana sobre el propuesto, y `lo-mismo` lo apaga: ese link
 * abre el drawer de un toque, sin banner ni cupón, así que un `%` ahí sería un descuento anunciado
 * que nadie cobra. El llamador ve el `descuento` efectivo, que es el que tiene que registrar.
 */
export function resolverEnvioRecompra(e: EntradaEnvioRecompra): DecisionEnvioRecompra {
  const beneficioBase = resolverBeneficioRecompra(e.escalon, e.receta, e.esRecetaRecomendada)
  const toque = normalizarToque(e.toque ?? e.proximoNivel)

  const descuentoOrigen: OrigenDescuento = e.descuento != null
    ? 'manual'
    : e.esRecetaRecomendada ? 'escalon' : 'receta'
  const descuentoElegido = e.descuento != null
    ? Math.min(Math.max(Math.trunc(e.descuento), 0), DESCUENTO_MAX)
    : beneficioBase.descuento

  const link: ModalidadLink = e.link ?? (descuentoElegido > 0 ? 'reactivacion' : 'lo-mismo')
  const descuento = link === 'reactivacion' ? descuentoElegido : 0

  return {
    toque,
    link,
    descuento,
    descuentoOrigen,
    beneficioBase,
    beneficio: {
      nivel: beneficioBase.nivel,
      descuento,
      // Sin descuento no hay nada que venza: el vencimiento cuelga del `%`, no del toque.
      expiraHoras: descuento > 0 ? beneficioBase.expiraHoras : null,
    },
    emiteCupon: descuento > 0,
  }
}
