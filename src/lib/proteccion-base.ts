// src/lib/proteccion-base.ts
//
// Motor de Recompra · 4.5 — PROTECCIÓN DE LA BASE (cimiento no negociable, no una feature opcional).
//
// El motor tiene que ser IMPOSIBLE DE USAR MAL: un local ansioso no debe poder quemar su propia base
// de clientes ni la reputación de su número ante Meta. Tres barreras, todas de MARKETING (nunca tocan
// los mensajes transaccionales de pedido/pago, que siempre salen):
//
//   1) OPT-OUT respetado — si el cliente pidió la baja (respondió "BAJA"/"STOP" por WhatsApp), no se lo
//      contacta más con recupero/campañas. El flag vive en `cliente.marketingOptOut`; el opt-out se
//      registra automáticamente desde el webhook de WhatsApp entrante (ver `procesarComandoOptOut`).
//   2) TOPE por cliente/mes — como mucho N toques de marketing a un mismo cliente en una ventana móvil
//      de 30 días. Se deriva del ledger `recupero_cliente` (no hace falta columna nueva). El cooldown
//      de 48 hs entre toques (en `recupero.ts`) es una barrera más fina; ésta es el techo mensual.
//   3) HORARIO DE SILENCIO — no se manda marketing de madrugada (hora de Argentina). Protege la
//      experiencia del comensal y la reputación del número.
//
// Estos valores son CONFIG (defaults seguros elegidos por la plataforma), no algo que el local pueda
// crankear hacia arriba: la protección no se negocia. Si a futuro se quisieran ajustar por local, se
// mueven a tabla sin cambiar la firma pública de este módulo.

import { type MySql2Database } from 'drizzle-orm/mysql2'
import { and, eq } from 'drizzle-orm'
import { cliente as ClienteTable } from '../db/schema'

type Db = MySql2Database<Record<string, never>>

// ── Config de protección ─────────────────────────────────────────────────────
/** Máximo de toques de marketing a un mismo cliente en la ventana móvil de abajo. */
export const TOPE_MARKETING_POR_CLIENTE = 4
/** Ventana móvil (en días) sobre la que se cuenta el tope. */
export const VENTANA_TOPE_DIAS = 30
/** Horario de silencio (hora local de Argentina, UTC-3): no se manda marketing en [DESDE, HASTA). */
export const SILENCIO_DESDE_HORA = 22 // 22:00
export const SILENCIO_HASTA_HORA = 9 //  09:00

const MS_POR_DIA = 1000 * 60 * 60 * 24

// ── Opt-out: palabras que disparan la baja / el alta ─────────────────────────
/** Un mensaje entrante que contiene alguna de estas palabras se toma como pedido de baja. */
export const OPT_OUT_KEYWORDS = ['baja', 'stop', 'cancelar', 'basta', 'no molestar', 'no molesten', 'unsubscribe']
/** Palabras que re-suscriben (el opt-out es reversible: "respetado" implica poder volver). */
export const OPT_IN_KEYWORDS = ['alta', 'suscribir', 'quiero recibir', 'reactivar']

export type MotivoBloqueoMarketing = 'opt_out' | 'tope_mensual' | 'horario_silencio'

export interface ResultadoProteccion {
  permitido: boolean
  motivo?: MotivoBloqueoMarketing
  mensaje?: string
}

/** Hora local de Argentina (0..23) para un instante dado. Argentina es UTC-3 fijo (sin DST). */
export function horaArgentina(ahora: number = Date.now()): number {
  return new Date(ahora - 3 * 60 * 60 * 1000).getUTCHours()
}

/** true si el instante cae dentro del horario de silencio (ventana que cruza medianoche). */
export function enHorarioSilencio(ahora: number = Date.now()): boolean {
  const h = horaArgentina(ahora)
  // Ventana que cruza medianoche (p. ej. 22 → 9): dentro si h >= DESDE o h < HASTA.
  if (SILENCIO_DESDE_HORA > SILENCIO_HASTA_HORA) {
    return h >= SILENCIO_DESDE_HORA || h < SILENCIO_HASTA_HORA
  }
  // Ventana normal (por si se reconfigura sin cruzar medianoche).
  return h >= SILENCIO_DESDE_HORA && h < SILENCIO_HASTA_HORA
}

/** Cuántos toques de marketing cayeron dentro de la ventana móvil (a partir de sus fechas). */
export function contarToquesEnVentana(
  toques: { createdAt: Date }[],
  ahora: number = Date.now(),
): number {
  const desde = ahora - VENTANA_TOPE_DIAS * MS_POR_DIA
  return toques.filter((t) => t.createdAt.getTime() >= desde).length
}

/**
 * Chequea las TRES barreras para un cliente concreto. `optOut` viene de `cliente.marketingOptOut`;
 * `toques` es el historial de recupero del cliente (para el tope mensual). El horario de silencio es
 * global (no depende del cliente) pero se chequea acá para tener un único punto de verdad.
 */
export function chequearProteccionMarketing(params: {
  optOut: boolean
  toques: { createdAt: Date }[]
  ahora?: number
}): ResultadoProteccion {
  const ahora = params.ahora ?? Date.now()

  if (params.optOut) {
    return {
      permitido: false,
      motivo: 'opt_out',
      mensaje: 'El cliente pidió no recibir mensajes de marketing (dado de baja).',
    }
  }

  if (enHorarioSilencio(ahora)) {
    return {
      permitido: false,
      motivo: 'horario_silencio',
      mensaje: `Fuera del horario permitido para marketing (silencio de ${SILENCIO_DESDE_HORA}:00 a ${SILENCIO_HASTA_HORA}:00). Probá más tarde.`,
    }
  }

  if (contarToquesEnVentana(params.toques, ahora) >= TOPE_MARKETING_POR_CLIENTE) {
    return {
      permitido: false,
      motivo: 'tope_mensual',
      mensaje: `Ya recibió el máximo de ${TOPE_MARKETING_POR_CLIENTE} mensajes de recupero en los últimos ${VENTANA_TOPE_DIAS} días. No se lo satura más.`,
    }
  }

  return { permitido: true }
}

// ── Opt-out desde el webhook de WhatsApp entrante ────────────────────────────

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // saca tildes
    .trim()
}

/** true si el texto entrante es un pedido de baja del marketing. */
export function esMensajeOptOut(texto: string): boolean {
  const t = normalizar(texto)
  return OPT_OUT_KEYWORDS.some((k) => t === k || t.includes(k))
}

/** true si el texto entrante es un pedido de re-suscripción. */
export function esMensajeOptIn(texto: string): boolean {
  const t = normalizar(texto)
  return OPT_IN_KEYWORDS.some((k) => t === k || t.includes(k))
}

/** Marca (o revierte) el opt-out de marketing de un cliente por teléfono, dentro de un local. */
export async function setOptOutPorTelefono(
  db: Db,
  restauranteId: number,
  telefono: string,
  optOut: boolean,
): Promise<void> {
  await db
    .update(ClienteTable)
    .set({
      marketingOptOut: optOut,
      marketingOptOutAt: optOut ? new Date() : null,
    })
    .where(and(eq(ClienteTable.restauranteId, restauranteId), eq(ClienteTable.telefono, telefono)))
}

/**
 * Procesa un mensaje entrante buscando comandos de baja/alta de marketing. Si el texto es un opt-out
 * (o un opt-in), aplica el cambio y devuelve la acción tomada; si no, devuelve null (el mensaje sigue
 * su curso normal, p. ej. la IA de atención). Es la parte "automática y respetada" del opt-out: el
 * cliente pide la baja por WhatsApp y el motor deja de contactarlo sin intervención del local.
 */
export async function procesarComandoOptOut(
  db: Db,
  restauranteId: number,
  telefono: string,
  texto: string,
): Promise<'opt_out' | 'opt_in' | null> {
  if (esMensajeOptOut(texto)) {
    await setOptOutPorTelefono(db, restauranteId, telefono, true)
    return 'opt_out'
  }
  if (esMensajeOptIn(texto)) {
    await setOptOutPorTelefono(db, restauranteId, telefono, false)
    return 'opt_in'
  }
  return null
}
