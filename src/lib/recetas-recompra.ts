// src/lib/recetas-recompra.ts
//
// Recetario del Motor de Recompra: UN mensaje preparado por segmento.
//
// El motor ya sabía a quién contactar y con qué beneficio (la escalera de incentivos de
// `recupero.ts`), pero el copy era el mismo para todos. Acá vive la voz de cada segmento:
// el cliente `dormido` no se escribe igual que uno que hizo un solo pedido.
//
// Reglas:
//   · Una receta por segmento de recompra (`primer_pedido`, `en_riesgo`, `dormido`, `perdido`).
//   · La receta RECOMENDADA es la del segmento del cliente (la clasificación de la campaña).
//   · El modo automático nunca elige receta: manda la recomendada con el beneficio de la ESCALERA,
//     así que sus links y su asignación quedan intactos. Una receta elegida a mano en modo manual
//     trae el beneficio de su propio techo, que puede ser mayor o menor que el del escalón.
//   · El copy no se inventa acá: se reusa el catálogo versionado de `recetas-crecimiento.ts`
//     (mismo vocabulario de recetas que la tab Adquisición).
//
// Dominio puro: sin DB, sin Hono, sin WhatsApp.

import type { SegmentoCliente } from './clientes-rfm'
import { RECETAS_CRECIMIENTO, type IncentivoReceta } from './recetas-crecimiento'

/** Vocabulario propio del motor (más específico que el RFM: `primer_pedido` reemplaza a `nuevo`). */
export type SegmentoRecompra = 'primer_pedido' | 'en_riesgo' | 'dormido' | 'perdido'

/** Segmentos donde tiene sentido el recupero (el cliente se enfrió respecto de SU propio ritmo). */
export const SEGMENTOS_RECUPERABLES: SegmentoRecompra[] = ['primer_pedido', 'en_riesgo', 'dormido', 'perdido']

export function esSegmentoRecompra(valor: unknown): valor is SegmentoRecompra {
  return typeof valor === 'string' && (SEGMENTOS_RECUPERABLES as string[]).includes(valor)
}

/**
 * Cada segmento de recompra reusa la receta versionada del mismo estado de ciclo de vida.
 * El único renombre es `nuevo` → `primer_pedido` (mismo cliente, vocabulario del motor).
 */
const RECETA_POR_SEGMENTO: Record<SegmentoRecompra, SegmentoCliente> = {
  primer_pedido: 'nuevo',
  en_riesgo: 'en_riesgo',
  dormido: 'dormido',
  perdido: 'perdido',
}

export interface RecetaRecompra {
  /** El código de la receta ES el segmento: es lo que el operador elige en la UI. */
  codigo: SegmentoRecompra
  segmento: SegmentoRecompra
  /** Nombre comercial de la receta heredado del catálogo de crecimiento ("Recuperá el hábito"). */
  nombre: string
  descripcion: string
  /** Hook del segmento: la primera línea del mensaje. Nunca menciona el beneficio. */
  textoBase: string
  /** Techo de incentivo propio de la receta: es el beneficio que aplica si el operador la elige. */
  incentivoMaximo: IncentivoReceta
}

function definir(codigo: SegmentoRecompra): RecetaRecompra {
  const receta = RECETAS_CRECIMIENTO[RECETA_POR_SEGMENTO[codigo]]
  return Object.freeze({
    codigo,
    segmento: codigo,
    nombre: receta.nombre,
    descripcion: receta.descripcion,
    textoBase: receta.textoBase,
    incentivoMaximo: receta.incentivoSugerido,
  })
}

/** Definiciones versionadas de plataforma: no son un builder configurable por local. */
export const RECETAS_RECOMPRA: Readonly<Record<SegmentoRecompra, RecetaRecompra>> = Object.freeze({
  primer_pedido: definir('primer_pedido'),
  en_riesgo: definir('en_riesgo'),
  dormido: definir('dormido'),
  perdido: definir('perdido'),
})

/** Todas las recetas, en el orden de prioridad del motor. Es el menú de "cambiar mensaje". */
export function listarRecetasRecompra(): RecetaRecompra[] {
  return SEGMENTOS_RECUPERABLES.map((segmento) => RECETAS_RECOMPRA[segmento])
}

/** La receta de un segmento. El caller valida antes con `esSegmentoRecompra` si viene de afuera. */
export function resolverRecetaRecompra(segmento: SegmentoRecompra): RecetaRecompra {
  return RECETAS_RECOMPRA[segmento]
}

/** Traduce el segmento RFM al vocabulario del motor. `activo`/`vip` no son recuperables. */
export function resolverSegmentoRecompraDesdeRFM(segmento: SegmentoCliente): SegmentoRecompra | null {
  if (segmento === 'nuevo') return 'primer_pedido'
  return esSegmentoRecompra(segmento) ? segmento : null
}

export interface EscalonIncentivo {
  nivel: number
  descuento: number
  expiraHoras: number | null
}

export interface BeneficioRecompra {
  /** Nivel de la escalera que se sigue usando para el historial y el próximo toque. */
  nivel: number
  descuento: number
  expiraHoras: number | null
}

/**
 * Resuelve el beneficio efectivo de un toque.
 *
 * La receta RECOMENDADA es la escalera tal cual: es el camino del modo automático (el motor no elige
 * receta) y el mensaje que el operador ve por defecto, así que los envíos automáticos no cambian.
 *
 * Una receta elegida a mano trae el beneficio de su propio techo (`incentivoSugerido` del catálogo de
 * crecimiento), sin recortes: puede bajarlo —mandar sin descuento a quien la escalera ya premiaría—
 * o subirlo —dar el "último intento" del 20% a un dormido—. El operador ve en pantalla qué beneficio
 * implica antes de mandarlo. El `nivel` es siempre el de la escalera: cambiar de receta no reinicia
 * el avance del cliente.
 */
export function resolverBeneficioRecompra(
  escalon: EscalonIncentivo,
  receta: RecetaRecompra,
  esRecomendada: boolean,
): BeneficioRecompra {
  if (esRecomendada) {
    return { nivel: escalon.nivel, descuento: escalon.descuento, expiraHoras: escalon.expiraHoras }
  }
  return {
    nivel: escalon.nivel,
    descuento: receta.incentivoMaximo.descuentoPorcentaje,
    expiraHoras: receta.incentivoMaximo.expiraHoras,
  }
}

/**
 * Copy del toque: la voz del segmento y, si la escalera habilitó un beneficio, la línea del cupón.
 * Es el texto que viaja como `{{5}}` en la plantilla de WhatsApp y como párrafo del modo manual.
 */
export function textoIncentivoReceta(
  receta: RecetaRecompra,
  beneficio: BeneficioRecompra,
  codigoDescuento: string | null,
): string {
  if (beneficio.descuento <= 0 || !codigoDescuento) return receta.textoBase
  const linea = beneficio.expiraHoras != null
    ? `Te guardamos un ${beneficio.descuento}% OFF con el código ${codigoDescuento}, pero ojo: vence en ${beneficio.expiraHoras} horas ⏰.`
    : `Y esta vez va con un ${beneficio.descuento}% de descuento: usá el código ${codigoDescuento} al hacer tu pedido.`
  return `${receta.textoBase}\n\n${linea}`
}
