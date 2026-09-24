// src/lib/recompra-goteo.ts
//
// El RITMO del goteo del Motor de Recompra: cada cuánto puede salir un toque y cuál es el que le
// sigue al cliente. Es la parte que decide si el motor insiste de más (spam) o se queda trabado
// (una fila que nunca drena), así que las dos fórmulas viven acá y no dentro de `motor-recompra.ts`.
//
// El motivo del módulo aparte es el mismo que el de `motor-recompra-prioridad.ts`: `motor-recompra.ts`
// y `recupero.ts` abren el pool de MySQL al importarse, así que nada que quieran fijar los tests puede
// vivir ahí. `recupero.ts` reexporta estas constantes para no romper a sus consumidores.
//
// Dominio puro: sin DB, sin Hono, sin WhatsApp.

import { NIVEL_MAX, normalizarToque, TOQUE_MAX, type ToqueRecompra } from './recetas-recompra'

/** No se permite reenviar otro toque dentro de esta ventana (protección mínima anti-spam). */
export const COOLDOWN_HORAS = 48

export const MS_POR_HORA = 1000 * 60 * 60

export const MS_POR_DIA = 24 * MS_POR_HORA

/**
 * Piso en DÍAS del espaciado entre toques, derivado del cooldown: es el mismo invariante anti-spam,
 * expresado en la unidad en la que el dueño configura ("cada cuántos días sale el 2º y el 3º").
 * Lo configurable sólo puede ESTIRAR el espaciado, nunca acortarlo por debajo de esto.
 */
export const DIAS_ENTRE_TOQUES_MIN = Math.ceil(COOLDOWN_HORAS / 24)

/** Minutos de gracia que se le suman al reintento por cooldown para garantizar que avance. */
const GRACIA_COOLDOWN_MS = 5 * 60 * 1000

/**
 * Instante (ms) en el que termina el cooldown abierto por el último toque.
 *
 * Sin fecha conocida devuelve una ventana COMPLETA por delante (no `ahora`): es el lado conservador.
 * En el camino de recontacto un `null` significa "no pudimos fechar el último toque", no "nunca se
 * envió" —`toqueSiguiente` sólo llega ahí con al menos una fila en el ledger, así que el toque
 * existió—, y ante la duda hay que esperar antes que arriesgar dos mensajes seguidos. Ojo: la
 * semántica opuesta es la correcta en `estadoRecupero` (`ultimo == null → puedeEnviar`), que sí se
 * pregunta por clientes nunca contactados.
 */
export function finDeCooldown(ultimoToqueMs: number | null, ahora: number): number {
  return (ultimoToqueMs ?? ahora) + COOLDOWN_HORAS * MS_POR_HORA
}

/** Desde cuándo puede volver a salir un toque de este cliente. */
export function arranqueDeRecontacto(ultimoToqueMs: number | null, ahora: number): number {
  return Math.max(ahora, finDeCooldown(ultimoToqueMs, ahora))
}

/**
 * Días efectivos de espera entre toques. Un valor ausente o inválido cae en el default histórico
 * (los 48 hs del cooldown); cualquier valor por debajo del piso se levanta al piso. Es la única
 * puerta por la que entra la configuración del dueño, así que el invariante anti-spam no depende
 * de que la UI mande un número sensato.
 */
export function diasEntreToques(dias: number | null | undefined): number {
  if (dias == null || !Number.isFinite(dias)) return COOLDOWN_HORAS / 24
  return Math.max(DIAS_ENTRE_TOQUES_MIN, Math.round(dias))
}

/** Instante (ms) en el que termina la espera entre el toque anterior y el siguiente. */
export function finDeEsperaEntreToques(
  ultimoToqueMs: number | null,
  dias: number | null | undefined,
  ahora: number,
): number {
  return (ultimoToqueMs ?? ahora) + diasEntreToques(dias) * MS_POR_DIA
}

/** `arranqueDeRecontacto` con el espaciado configurable de la tanda. */
export function arranqueDeRecontactoConIntervalo(
  ultimoToqueMs: number | null,
  dias: number | null | undefined,
  ahora: number,
): number {
  return Math.max(ahora, finDeEsperaEntreToques(ultimoToqueMs, dias, ahora))
}

/**
 * Cuándo se encola el toque siguiente: el primer hueco habitual del cliente que caiga después de la
 * espera configurada, o el fin de esa espera si ese hueco no existe. El piso es estructural —no una
 * ventana de tiempo— para que el drenaje no pueda levantarlo antes de tiempo.
 */
export function dueDateDeRecontactoConIntervalo(
  dueDatePatron: Date | null,
  ultimoToqueMs: number | null,
  dias: number | null | undefined,
  ahora: number,
): Date {
  const fin = finDeEsperaEntreToques(ultimoToqueMs, dias, ahora)
  return dueDatePatron && dueDatePatron.getTime() > fin ? dueDatePatron : new Date(fin)
}

/** `dueDateDeRecontactoConIntervalo` con el espaciado default (48 hs). */
export function dueDateDeRecontacto(
  dueDatePatron: Date | null,
  ultimoToqueMs: number | null,
  ahora: number,
): Date {
  return dueDateDeRecontactoConIntervalo(dueDatePatron, ultimoToqueMs, null, ahora)
}

/**
 * El toque que le sigue a un cliente YA contactado, o null si no le toca ninguno.
 *
 * El avance se mide contra el LEDGER (`recupero_cliente`), que sólo tiene filas de toques que salieron
 * de verdad: si dice 1, es porque el 1º se mandó. El toque 1 de la campaña no pasa por acá (lo encola
 * el goteo normal): un cliente con toques de una campaña anterior no puede entrar por el 2º o el 3º,
 * porque esta campaña nunca le mandó el 1º.
 */
export function toqueSiguiente(
  toquesDesdeUltimoPedido: number,
  yaEncolados: ReadonlySet<number> | Iterable<number>,
): ToqueRecompra | null {
  const t = toquesDesdeUltimoPedido
  if (!Number.isFinite(t) || t < 1 || t >= TOQUE_MAX) return null
  const siguiente = normalizarToque(t + 1)
  // Ya tiene su toque siguiente en la cola (en cualquier estado): el índice único lo rechazaría
  // igual, pero evitar el insert es más barato y deja el conteo honesto.
  const encolados = yaEncolados instanceof Set ? yaEncolados : new Set(yaEncolados)
  return encolados.has(siguiente) ? null : siguiente
}

/**
 * Reprogramación de un intento que no pudo salir por cooldown o por silencio.
 *
 * El `dueDate` nuevo SIEMPRE queda en el futuro: si no, la fila se reintentaría en cada tick con un
 * `dueDate` viejo y el motor quedaría girando en silencio hasta que el cooldown se cumpliera por
 * decantación. Para el cooldown se salta una ventana completa desde AHORA (no desde el último envío):
 * es conservador a propósito —evita tener que leer el ledger para calcular el resto exacto— y lo que
 * importa es que sea monótono.
 */
export function reprogramarPorCooldown(ahora: number): Date {
  return new Date(ahora + COOLDOWN_HORAS * MS_POR_HORA + GRACIA_COOLDOWN_MS)
}

/** Un envío que cayó en horario de silencio se reintenta en la próxima hora hábil. */
export function reprogramarPorSilencio(ahora: number): Date {
  return new Date(ahora + MS_POR_HORA)
}

// ── El estado del goteo para un cliente ──────────────────────────────────────

export interface EstadoRecupero {
  /** Toques enviados en total al cliente (histórico). */
  totalEnvios: number
  /** Timestamp ISO del último toque enviado, o null. */
  ultimoEnvioAt: string | null
  /** Nivel del último toque enviado, o null. */
  ultimoNivel: number | null
  /** Próximo escalón a enviar (1..NIVEL_MAX). */
  proximoNivel: number
  /**
   * Toques enviados DESPUÉS del último pedido, crudo y sin capar. `proximoNivel` está capado en
   * NIVEL_MAX, así que no distingue "le toca el 3º" de "ya se agotó": el motor necesita el conteo
   * crudo para no reencolar un 4º toque.
   */
  toquesDesdeUltimoPedido: number
  /** false si estamos dentro del cooldown (hay que esperar antes de insistir). */
  puedeEnviar: boolean
}

/** Una fila del ledger `recupero_cliente`: lo que efectivamente salió. */
export interface Toque {
  nivel: number
  createdAt: Date
}

/**
 * Deriva el estado de la escalera para un cliente a partir de sus toques previos y la fecha de su
 * último pedido. El próximo nivel cuenta sólo los toques posteriores al último pedido (si volvió a
 * pedir, la escalera se reinicia). Capado en NIVEL_MAX.
 */
export function estadoRecupero(
  toques: Toque[],
  ultimoPedidoMs: number | null,
  ahora: number = Date.now(),
): EstadoRecupero {
  const ordenados = [...toques].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const ultimo = ordenados[ordenados.length - 1] ?? null

  // Toques enviados DESPUÉS del último pedido (los previos ya "cumplieron": el cliente pidió).
  const desdeUltimoPedido = ultimoPedidoMs != null
    ? ordenados.filter((t) => t.createdAt.getTime() > ultimoPedidoMs)
    : ordenados

  const proximoNivel = Math.min(desdeUltimoPedido.length + 1, NIVEL_MAX)

  // Un cliente sin toques previos no tiene cooldown que respetar. Ojo con la semántica OPUESTA de
  // `finDeCooldown(null, …)`: ahí un null es "no pudimos fechar el último toque", no "nunca se envió".
  const puedeEnviar = ultimo == null
    ? true
    : (ahora - ultimo.createdAt.getTime()) >= COOLDOWN_HORAS * MS_POR_HORA

  return {
    totalEnvios: ordenados.length,
    ultimoEnvioAt: ultimo ? ultimo.createdAt.toISOString() : null,
    ultimoNivel: ultimo ? ultimo.nivel : null,
    proximoNivel,
    toquesDesdeUltimoPedido: desdeUltimoPedido.length,
    puedeEnviar,
  }
}
