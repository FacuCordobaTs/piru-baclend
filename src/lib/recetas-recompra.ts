// src/lib/recetas-recompra.ts
//
// Recetario del Motor de Recompra: UN mensaje por segmento × toque.
//
// El motor ya sabía a quién contactar y con qué beneficio (la escalera de incentivos de
// `recupero.ts`), y desde la primera iteración sabía que cada segmento tiene su voz. Lo que
// faltaba era el segundo eje: el mismo cliente recibe hasta TRES toques, y el 2º y el 3º no
// pueden repetir el relato del 1º (decir "hace 3 semanas que no te vemos" dos veces seguidas no
// es insistencia, es un mensaje pegado).
//
// Dos dimensiones que se combinan:
//   · el SEGMENTO elige la voz (`primer_pedido` no habla de ausencia: no se fue, no volvió);
//   · el TOQUE elige el trabajo (1º = relato + antojo, 2º = recordatorio corto, 3º = cierre).
//
// El cuerpo vive en DOS lugares y tiene que decir lo mismo en los dos:
//   · en automático lo fija Meta, en el cuerpo de la plantilla aprobada;
//   · en manual es el texto que el admin previsualiza y el operador copia.
// Por eso `cuerpo` es el espejo exacto de la plantilla de Meta y `componerCuerpoToque` es la
// única función que lo renderiza: el envío manual no pasa por Meta y no puede divergir.
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

/** Hasta tres toques por cliente: es el techo del goteo, no una preferencia. */
export type ToqueRecompra = 1 | 2 | 3
export const TOQUES_RECOMPRA: ToqueRecompra[] = [1, 2, 3]
export const TOQUE_MAX = 3

export function normalizarToque(valor: unknown): ToqueRecompra {
  const n = typeof valor === 'number' ? valor : Number(valor)
  if (!Number.isFinite(n)) return 1
  return Math.min(Math.max(Math.trunc(n), 1), TOQUE_MAX) as ToqueRecompra
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
  /** Hook del segmento: la voz del 1º toque. Nunca menciona el beneficio. */
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

// ─── Recetario por segmento × toque ─────────────────────────────────────────────────────────────

/**
 * Qué dato del envío ocupa cada `{{n}}`. El ORDEN de esta lista es el contrato con Meta: las
 * plantillas usan variables posicionales, así que reordenar acá rompe los envíos ya aprobados.
 */
export type VariableToque = 'cliente' | 'local' | 'tiempoSinPedir' | 'productoFavorito' | 'beneficio'

export interface RecetaToque {
  segmento: SegmentoRecompra
  toque: ToqueRecompra
  /** Nombre exacto de la plantilla en Meta (MARKETING, es_AR). */
  plantilla: string
  /** El 1º toque lleva la foto del producto favorito; el 2º y el 3º van sin encabezado. */
  conImagen: boolean
  /** Cuerpo con `{{n}}` posicionales: espejo exacto del cuerpo aprobado en Meta. */
  cuerpo: string
  /** Qué dato va en cada `{{n}}`, en orden. */
  variables: VariableToque[]
}

/** El juego de variables completo, en el orden canónico del 1º toque. */
const VARS_TOQUE1: VariableToque[] = ['cliente', 'local', 'tiempoSinPedir', 'productoFavorito', 'beneficio']
/** `primer_pedido` no habla de ausencia, así que no usa el "hace {{n}} que no te vemos". */
const VARS_TOQUE1_PRIMER_PEDIDO: VariableToque[] = ['cliente', 'local', 'productoFavorito', 'beneficio']
/** 2º y 3º van sin imagen de producto: el cuerpo no puede apoyarse en algo que no se ve. */
const VARS_SIN_IMAGEN: VariableToque[] = ['cliente', 'local', 'beneficio']
/**
 * Excepción de `recupero_toque2_perdido_v1`: su cuerpo no nombra al local (a un perdido no se le
 * recuerda dónde estaba comprando). Acá el beneficio cae en `{{2}}`.
 *
 * Meta EXIGE placeholders consecutivos desde `{{1}}`: no se puede escribir un cuerpo con `{{1}}` y
 * `{{3}}` y saltear el `{{2}}`. Por eso el índice del beneficio se corre según lo que el cuerpo
 * nombre de verdad, y no puede haber una lista de variables fija para los cuatro segmentos del 2º
 * toque. `elCuerpoUsa...` abajo fija ese invariante en los tests.
 */
const VARS_SIN_LOCAL: VariableToque[] = ['cliente', 'beneficio']

/**
 * El CTA del botón, el mismo en los 12 cuerpos. No es una elección de estilo: es estructura. Meta
 * rechaza EN AUTOMÁTICO un cuerpo que empiece o termine con una variable (`Invalid format`), así
 * que después de la línea de beneficio —que es la última variable— tiene que venir texto fijo.
 * El 1º toque ya lo traía; los toques 2 y 3 no, y por eso se los agregó.
 */
const CTA_RECOMPRA = 'Tocá el botón y pedí en segundos 👇'

/**
 * Los 12 cuerpos (4 segmentos × 3 toques). El 1º toque de `dormido` corre sobre la plantilla
 * histórica `recupero_dormido_v1`, que ya está aprobada en las WABAs de los locales: su cuerpo
 * no se toca, sólo cambia lo que viaja en `{{5}}` (la línea de beneficio, que antes repetía el
 * relato del propio cuerpo).
 */
const CUERPOS_TOQUE1: Record<SegmentoRecompra, string> = {
  dormido: `¡Hola {{1}}! 👋\n\nEn {{2}} hace {{3}} que no te vemos y se nos antojó tentarte con {{4}}. 😋\n\n{{5}}\n\n${CTA_RECOMPRA}`,
  primer_pedido: `¡Hola {{1}}! 👋\n\nYa probaste lo que más te gusta en {{2}}: {{3}}. 😋\n\nAhora hacé tu segundo pedido y te lo dejamos listo.\n\n{{4}}\n\n${CTA_RECOMPRA}`,
  en_riesgo: `¡Hola {{1}}! 👋\n\nVenís pidiendo seguido en {{2}} y hace {{3}} que no te vemos. Se nos antojó tentarte con {{4}}. 😋\n\n{{5}}\n\n${CTA_RECOMPRA}`,
  perdido: `¡Hola {{1}}! 👋\n\nPasó bastante tiempo: hace {{3}} que no te vemos en {{2}}. ¿Volvemos a vernos? Te esperamos con {{4}}. 😋\n\n{{5}}\n\n${CTA_RECOMPRA}`,
}

/**
 * Los 8 cuerpos de los toques 2 y 3. Tres reglas de formato mandan sobre este copy, y las tres son
 * rechazo automático en WhatsApp Manager:
 *
 *   · el cuerpo **no puede empezar ni terminar con una variable** (`Invalid format`): por eso todos
 *     abren con texto fijo y cierran con el CTA del botón;
 *   · entre texto fijo y variables tienen que quedar **al menos `3 × variables + 1` palabras**
 *     (error 2388293, "parameters words ratio exceeds limit"): un recordatorio de dos líneas con
 *     tres variables se lee genérico y no se aprueba;
 *   · las variables van **consecutivas desde `{{1}}`** y sin quedar pegadas entre sí.
 *
 * El `cuerpo` de acá es el espejo exacto del texto que hay que cargar en Meta, así que estas reglas
 * también son las del recetario: `recetas-recompra.test.ts` las fija para las 12.
 *
 * En lo que hace al mensaje: el 2º recuerda (sin repetir el relato del 1º, que ya se dijo) y el 3º
 * cierra. Ninguno promete un vencimiento en el texto fijo: de eso se ocupa la línea de beneficio,
 * que es la única que sabe si el descuento de este toque vence o no.
 */
const CUERPOS_TOQUE2: Record<SegmentoRecompra, string> = {
  primer_pedido: `Ya sabés lo que te gusta, {{1}}: tu segundo pedido en {{2}} te va a llevar un minuto.\n\n{{3}}\n\n${CTA_RECOMPRA}`,
  en_riesgo: `Volvé a tu ritmo, {{1}}: tu pedido de siempre en {{2}} te está esperando.\n\n{{3}}\n\n${CTA_RECOMPRA}`,
  dormido: `Te seguimos guardando el lugar, {{1}}: en {{2}} tu pedido de siempre te espera.\n\n{{3}}\n\n${CTA_RECOMPRA}`,
  perdido: `No queremos insistir de más, {{1}}: sólo dejarte algo por si te dan ganas.\n\n{{2}}\n\n${CTA_RECOMPRA}`,
}

const CUERPOS_TOQUE3: Record<SegmentoRecompra, string> = {
  primer_pedido: `Es el último mensaje que te mandamos por ahora, {{1}}. Te dejamos esto para tu segundo pedido en {{2}}:\n\n{{3}}\n\n${CTA_RECOMPRA}`,
  en_riesgo: `Cerramos acá, {{1}}: es la última vez que te escribimos por esto. Lo de siempre te espera en {{2}}.\n\n{{3}}\n\n${CTA_RECOMPRA}`,
  dormido: `Última vez que te escribimos por un buen tiempo, {{1}}: lo tuyo en {{2}} sigue donde lo dejaste.\n\n{{3}}\n\n${CTA_RECOMPRA}`,
  perdido: `Nos encantaría volver a verte, {{1}}: en {{2}} te vamos a estar esperando. Si no es ahora, te deseamos lo mejor.\n\n{{3}}\n\n${CTA_RECOMPRA}`,
}

/** El nombre de la plantilla del 1º toque. `dormido` conserva la histórica: no se crea una nueva. */
function plantillaToque1(segmento: SegmentoRecompra): string {
  return segmento === 'dormido' ? 'recupero_dormido_v1' : `recupero_toque1_${segmento}_v1`
}

function definirToque(
  segmento: SegmentoRecompra,
  toque: ToqueRecompra,
  cuerpo: string,
  variables: VariableToque[],
): RecetaToque {
  return Object.freeze({
    segmento,
    toque,
    plantilla: toque === 1 ? plantillaToque1(segmento) : `recupero_toque${toque}_${segmento}_v1`,
    conImagen: toque === 1,
    cuerpo,
    variables,
  })
}

/** Definiciones versionadas de plataforma: no son un builder configurable por local. */
export const RECETAS_TOQUE: Readonly<Record<SegmentoRecompra, Record<ToqueRecompra, RecetaToque>>> =
  Object.freeze(
    Object.fromEntries(
      SEGMENTOS_RECUPERABLES.map((segmento) => [
        segmento,
        Object.freeze({
          1: definirToque(
            segmento,
            1,
            CUERPOS_TOQUE1[segmento],
            segmento === 'primer_pedido' ? VARS_TOQUE1_PRIMER_PEDIDO : VARS_TOQUE1,
          ),
          2: definirToque(
            segmento,
            2,
            CUERPOS_TOQUE2[segmento],
            segmento === 'perdido' ? VARS_SIN_LOCAL : VARS_SIN_IMAGEN,
          ),
          3: definirToque(segmento, 3, CUERPOS_TOQUE3[segmento], VARS_SIN_IMAGEN),
        }),
      ]),
    ) as Record<SegmentoRecompra, Record<ToqueRecompra, RecetaToque>>,
  )

/** La receta de una combinación. Un toque fuera de rango se normaliza: nunca tira. */
export function resolverRecetaToque(segmento: SegmentoRecompra, toque: number): RecetaToque {
  return RECETAS_TOQUE[segmento][normalizarToque(toque)]
}

/** Plantilla de Meta para (segmento × toque). Es lo que se manda como `template.name`. */
export function resolverPlantillaRecompra(segmento: SegmentoRecompra, toque: number): string {
  return resolverRecetaToque(segmento, toque).plantilla
}

/** Las 11 plantillas nuevas que hay que crear en Meta (`dormido` 1º ya existe). */
export function listarPlantillasNuevas(): RecetaToque[] {
  return SEGMENTOS_RECUPERABLES.flatMap((segmento) =>
    TOQUES_RECOMPRA.map((toque) => RECETAS_TOQUE[segmento][toque]),
  ).filter((r) => r.plantilla !== 'recupero_dormido_v1')
}

/** Todos los tramos, en el orden segmento × toque. Espejo del menú del diálogo del operador. */
export function listarRecetasToque(): RecetaToque[] {
  return SEGMENTOS_RECUPERABLES.flatMap((segmento) => TOQUES_RECOMPRA.map((toque) => RECETAS_TOQUE[segmento][toque]))
}

/**
 * Renderiza el cuerpo de un tramo: reemplaza `{{n}}` por los valores y devuelve, además, el array
 * ORDENADO de parámetros que espera Meta. Es la única fuente del texto final, así que lo que el
 * admin previsualiza y lo que se manda por WhatsApp no pueden divergir.
 */
export function componerCuerpoToque(
  receta: RecetaToque,
  valores: Record<VariableToque, string>,
): { texto: string; parametros: { nombre: VariableToque; valor: string }[] } {
  const parametros = receta.variables.map((nombre) => ({ nombre, valor: valores[nombre] ?? '' }))
  const texto = parametros.reduce(
    (acc, p, i) => acc.split(`{{${i + 1}}}`).join(p.valor),
    receta.cuerpo,
  )
  return { texto, parametros }
}

export interface EscalonIncentivo {
  nivel: number
  descuento: number
  expiraHoras: number | null
}

export interface EscalonRecupero extends EscalonIncentivo {
  /** Rótulo corto para la UI. */
  titulo: string
  /** Descripción para la UI (qué se le va a mandar). */
  detalle: string
}

/**
 * La escalera del goteo: qué se ofrece en cada toque. Es la autoridad del `%` —el toque elige el
 * copy, la escalera el descuento— y por eso vive acá, con el recetario, y no en el módulo que abre
 * el pool: es la tabla que el motor y los tests tienen que poder leer sin una base.
 *
 * El orden es el del avance: `ESCALERA[nivel - 1]`.
 */
export const ESCALERA: EscalonRecupero[] = [
  {
    nivel: 1,
    descuento: 0,
    expiraHoras: null,
    titulo: 'Primer toque · sin descuento',
    detalle: 'Solo un antojo: la foto de lo que más pide + invitación a repetir su pedido. No se regala margen a quien vuelve gratis.',
  },
  {
    nivel: 2,
    descuento: 10,
    expiraHoras: null,
    titulo: 'Segundo toque · 10% de descuento',
    detalle: 'Si no volvió con el primer toque, un empujón chico: 10% que la tienda aplica sola al entrar desde el link.',
  },
  {
    nivel: 3,
    descuento: 20,
    expiraHoras: 48,
    titulo: 'Último toque · 20% OFF con vencimiento',
    detalle: 'Oferta fuerte y con urgencia: 20% que vence en 48 hs. Es el último intento.',
  },
]

/** Techo de la escalera: no hay un 4º escalón, pero tampoco un 4º toque que reencolar. */
export const NIVEL_MAX = ESCALERA.length

/** `lo-mismo` abre el drawer de 1 toque y NUNCA lleva descuento; `reactivacion` siempre lleva el elegido. */
export type ModalidadLink = 'lo-mismo' | 'reactivacion'

export const MODALIDADES_LINK: ModalidadLink[] = ['lo-mismo', 'reactivacion']

export function esModalidadLink(valor: unknown): valor is ModalidadLink {
  return valor === 'lo-mismo' || valor === 'reactivacion'
}

/**
 * Rango del descuento que el operador puede forzar a mano. Un 80% se va de margen sin querer.
 * El piso de la escalera es 0 (sin descuento): `DESCUENTO_MIN` es el mínimo *con* descuento.
 */
export const DESCUENTO_MIN = 5
export const DESCUENTO_MAX = 30

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
 * La línea de beneficio: lo último que va en el cuerpo, en la variable final del tramo.
 *
 * NO menciona ningún código. El descuento viaja en el link (el token lleva el `%` y el cupón
 * determinístico del cliente), así que anunciarlo con un código sería pedirle al cliente que
 * copie algo que la tienda ya sabe aplicar sola.
 */
export function lineaBeneficioRecompra(beneficio: BeneficioRecompra, toque: number): string {
  const t = normalizarToque(toque)
  if (beneficio.descuento <= 0) {
    return t === 1
      ? 'Tu pedido te está esperando: armalo en segundos desde acá.'
      : 'Cuando quieras, tu pedido de siempre está a un toque.'
  }
  if (beneficio.expiraHoras != null) {
    return `Te guardamos ${beneficio.descuento}% OFF, pero ojo: vence en ${beneficio.expiraHoras} horas ⏰.`
  }
  return `Y esta vez va con ${beneficio.descuento}% de descuento: se aplica solo al entrar desde acá.`
}
