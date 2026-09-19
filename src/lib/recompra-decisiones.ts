// src/lib/recompra-decisiones.ts
//
// Las TRES DECISIONES del operador sobre un envío manual del Motor de Recompra: el MENSAJE
// (`segmento` × `toque`), el LINK y el DESCUENTO.
//
// Viven afuera de la ruta porque son el contrato de entrada del motor: el GET de la vista previa las
// recibe por query y el POST que registra el envío por body, y los dos tienen que significar lo
// mismo — si divergen, la pantalla previsualiza algo que después no es lo que se manda. Un `toque`
// inventado o un descuento fuera de rango mueren acá, en el borde, y no adentro del motor, donde ya
// es tarde: el cupón se emitió o el mensaje salió.
//
// Dominio puro: sin DB, sin Hono, sin WhatsApp. La ruta lo enchufa con `zValidator`.

import { z } from 'zod'
import {
  DESCUENTO_MAX,
  MODALIDADES_LINK,
  SEGMENTOS_RECUPERABLES,
  TOQUE_MAX,
  type ModalidadLink,
  type SegmentoRecompra,
} from './recetas-recompra'

/** Un campo opcional que puede llegar vacío: en query string `''` es "no lo mandé", no un valor. */
const ausenteSiVacio = (valor: unknown) => (valor === '' || valor === null ? undefined : valor)

/**
 * `segmento` y `receta` son el MISMO campo: `receta` es el nombre viejo y se sigue aceptando para no
 * romper a un admin que todavía no se actualizó. Si vienen los dos, gana `segmento`.
 *
 * El descuento permitido es 0..`DESCUENTO_MAX`: el 0 no es un descuento chico, es "sin descuento", y
 * es la única forma de mandar un mensaje sin cupón junto con el link `lo-mismo`. La combinación
 * contradictoria (`lo-mismo` con descuento) se rechaza en vez de resolverse sola: el operador pidió
 * dos cosas incompatibles y adivinar cuál quiso es peor que preguntarle.
 */
export const decisionesRecetaSchema = z
  .object({
    segmento: z.preprocess(ausenteSiVacio, z.enum(SEGMENTOS_RECUPERABLES).optional()),
    receta: z.preprocess(ausenteSiVacio, z.enum(SEGMENTOS_RECUPERABLES).optional()),
    toque: z.preprocess(ausenteSiVacio, z.coerce.number().int().min(1).max(TOQUE_MAX).optional()),
    link: z.preprocess(ausenteSiVacio, z.enum(MODALIDADES_LINK).optional()),
    descuento: z.preprocess(ausenteSiVacio, z.coerce.number().int().min(0).max(DESCUENTO_MAX).optional()),
  })
  .refine((decisiones) => !(decisiones.link === 'lo-mismo' && (decisiones.descuento ?? 0) > 0), {
    message: 'El link "lo mismo" no lleva descuento: elegí reactivación o dejá el descuento en 0',
  })

export type DecisionesReceta = z.infer<typeof decisionesRecetaSchema>

/** Lo que el motor entiende. `receta` ya colapsó en `segmento`; lo ausente queda sin definir. */
export interface OpcionesDecisionesRecompra {
  segmento?: SegmentoRecompra
  toque?: number
  link?: ModalidadLink
  descuento?: number
}

/**
 * Traduce las decisiones ya validadas al vocabulario del motor. Todo lo que no vino queda `undefined`
 * a propósito: el motor completa cada hueco con su default (segmento en vivo, toque de la escalera,
 * `%` del escalón, link derivado del descuento), y mandar un 0 donde no hubo decisión apagaría el
 * descuento que el cliente sí tenía ganado.
 */
export function opcionesDeDecisiones(decisiones: DecisionesReceta): OpcionesDecisionesRecompra {
  return {
    segmento: decisiones.segmento ?? decisiones.receta,
    toque: decisiones.toque,
    link: decisiones.link,
    descuento: decisiones.descuento,
  }
}
