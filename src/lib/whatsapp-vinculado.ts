// src/lib/whatsapp-vinculado.ts
//
// El WhatsApp del local vinculado como dispositivo (servicio `wa-vinculado/`, whatsmeow). Sólo
// existe para locales SIN el módulo `avisos_automaticos_whatsapp` (con el módulo, los avisos y las
// tandas ya salen por Meta) y sirve para dos cosas:
//
//   1. Confirmar que el cliente mandó al local el mensaje del pedido ("Pedido #N") y, con eso,
//      tomar su número: la tienda ya no se lo pide en el checkout.
//   2. Mandar solas las tandas de recompra, con un tope diario para cuidar el número del local.
//
// El servicio filtra todo lo demás (otros chats, grupos, mensajes propios) antes de avisar.

import { timingSafeEqual } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { cliente as ClienteTable, whatsappVinculado as VinculadoTable } from '../db/schema'
import { MODULE_KEYS, tieneModuloActivo } from './modulos'

/**
 * Mensajes de recompra por día que salen solos desde el WhatsApp vinculado. WhatsApp no publica un
 * límite para cuentas comunes, pero mandar muchos mensajes iguales a números que no escriben seguido
 * es lo que dispara los bloqueos: 30 por día, espaciados, es un ritmo de persona.
 */
export const LIMITE_DIARIO_VINCULADO = 30
/** Pausa entre dos envíos automáticos (al azar en este rango). */
export const PAUSA_ENVIO_MS: [number, number] = [45_000, 120_000]
/** Un "Pedido #N" que llega después de esto ya no confirma ese pedido. */
export const VENTANA_CONFIRMACION_MS = 12 * 60 * 60 * 1000

const URL_SERVICIO = (process.env.WA_VINCULADO_URL || '').replace(/\/$/, '')
const SECRETO = process.env.WA_VINCULADO_SECRET || ''

export const servicioConfigurado = () => Boolean(URL_SERVICIO && SECRETO.length >= 16)

export function secretoValido(recibido: string | null | undefined): boolean {
  if (!servicioConfigurado() || !recibido) return false
  const a = Buffer.from(recibido)
  const b = Buffer.from(SECRETO)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type EstadoSesion =
  | { estado: 'desvinculado' | 'preparando' }
  | { estado: 'esperando_qr'; qr: string }
  | { estado: 'conectado' | 'desconectado'; telefono: string }

export async function llamarServicio<T = any>(
  restauranteId: number,
  accion: '' | 'vincular' | 'desvincular' | 'enviar',
  cuerpo?: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  if (!servicioConfigurado()) return { ok: false, status: 503, data: { error: 'sin_servicio' } as T }
  const ruta = `${URL_SERVICIO}/sesiones/${restauranteId}${accion ? `/${accion}` : ''}`
  try {
    const res = await fetch(ruta, {
      method: accion ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Piru-Secret': SECRETO },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(accion === 'enviar' ? 60_000 : 25_000),
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, data }
  } catch {
    return { ok: false, status: 503, data: { error: 'sin_servicio' } as T }
  }
}

/** Con el módulo de avisos activo el WhatsApp vinculado no aplica: todo sigue por Meta. */
export async function vinculadoAplica(db: any, restauranteId: number): Promise<boolean> {
  return !(await tieneModuloActivo(db, restauranteId, MODULE_KEYS.AVISOS_AUTOMATICOS_WHATSAPP))
}

/** Vinculado, conectado y aplicable. Lee la DB: no llama al servicio (se usa en la tienda pública). */
export async function vinculadoActivo(db: any, restauranteId: number): Promise<boolean> {
  if (!servicioConfigurado()) return false
  const [fila] = await db.select({ conectado: VinculadoTable.conectado }).from(VinculadoTable)
    .where(eq(VinculadoTable.restauranteId, restauranteId)).limit(1)
  if (!fila?.conectado) return false
  return vinculadoAplica(db, restauranteId)
}

export async function guardarEstado(db: any, restauranteId: number, conectado: boolean, telefono: string | null) {
  await db.insert(VinculadoTable).values({ restauranteId, conectado, telefono, updatedAt: new Date() })
    .onDuplicateKeyUpdate({ set: { conectado, telefono, updatedAt: new Date() } })
}

/** Dígitos de un número; una línea argentina se identifica por sus últimos 10. */
export const digitos = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '')
export function mismaLinea(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = digitos(a)
  const db = digitos(b)
  if (da.length < 8 || db.length < 8) return false
  return da.slice(-10) === db.slice(-10)
}

export interface PedidoConfirmable {
  tipo: string
  estado: string
  telefono: string | null
  createdAt: Date
  whatsappConfirmadoAt: Date | null
}

/**
 * Qué hacer con un "Pedido #N" que llegó desde `telefono`:
 * - `ignorar`: ya confirmado, viejo, cancelado o de mesa. Un número cualquiera que escriba
 *   "Pedido #5" en otra conversación no toca nada.
 * - `confirmar`: el pedido ya tenía número (lo cargó el cliente): sólo se marca, nunca se pisa.
 * - `completar`: el pedido no tenía número: se toma el del mensaje.
 */
export function decidirConfirmacion(pedido: PedidoConfirmable | null, telefono: string, ahora: number) {
  if (!pedido || pedido.whatsappConfirmadoAt) return 'ignorar' as const
  if (pedido.tipo !== 'delivery' && pedido.tipo !== 'takeaway') return 'ignorar' as const
  if (pedido.estado === 'cancelled' || pedido.estado === 'archived') return 'ignorar' as const
  const edad = ahora - new Date(pedido.createdAt).getTime()
  if (edad < -60_000 || edad > VENTANA_CONFIRMACION_MS) return 'ignorar' as const
  if (digitos(telefono).length < 8) return 'ignorar' as const
  return digitos(pedido.telefono).length >= 8 ? ('confirmar' as const) : ('completar' as const)
}

/**
 * El número con el que se guarda al cliente. WhatsApp entrega "5491112345678"; si el local ya
 * tiene a esa persona cargada como "1112345678" se reutiliza ese, para no duplicarla.
 */
export async function telefonoDelCliente(db: any, restauranteId: number, telefono: string): Promise<string> {
  const d = digitos(telefono)
  const [existente] = await db.select({ telefono: ClienteTable.telefono }).from(ClienteTable).where(and(
    eq(ClienteTable.restauranteId, restauranteId),
    sql`RIGHT(${ClienteTable.telefonoNormalizado}, 10) = ${d.slice(-10)}`,
  )).limit(1)
  return existente?.telefono?.trim() || d
}

/** Inicio del día de hoy en Argentina (UTC-3), para contar el tope diario. */
export function inicioDelDiaAr(ahora = Date.now()): Date {
  const offset = 3 * 60 * 60 * 1000
  const local = new Date(ahora - offset)
  local.setUTCHours(0, 0, 0, 0)
  return new Date(local.getTime() + offset)
}
