// src/lib/whatsapp-chats.ts
//
// Chats de WhatsApp de sólo lectura para la tab Mensajes del panel: lo que el cliente le escribe al
// número del local, la respuesta automática y los mensajes de las tandas que salieron por Meta.
// El panel no responde desde acá: el dueño ve la conversación y, si hace falta, abre el chat del
// cliente en su propio WhatsApp.

import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { cliente as ClienteTable, whatsappChatMensaje as ChatTable } from '../db/schema'

/** Los últimos 10 dígitos: junta el `549…` que manda Meta con el `54…` que cargó el local. */
export function claveTelefono(telefono: string | null | undefined): string | null {
  const digitos = (telefono ?? '').replace(/\D/g, '')
  return digitos.length >= 8 ? digitos.slice(-10) : null
}

export interface MensajeChatNuevo {
  restauranteId: number
  telefono: string
  direccion: 'entrante' | 'saliente'
  origen: 'cliente' | 'bot' | 'tanda'
  texto: string
  imagenUrl?: string | null
  waMessageId?: string | null
  createdAt?: Date
}

/** Registra un mensaje. Meta reenvía webhooks: el id del mensaje evita duplicarlo. */
export async function registrarMensajeChat(db: any, m: MensajeChatNuevo): Promise<void> {
  const clave = claveTelefono(m.telefono)
  if (!clave) return
  await db.insert(ChatTable).values({
    restauranteId: m.restauranteId,
    telefono: m.telefono.replace(/\D/g, '').slice(0, 20),
    clave,
    direccion: m.direccion,
    origen: m.origen,
    texto: m.texto.slice(0, 4000),
    imagenUrl: m.imagenUrl ?? null,
    waMessageId: m.waMessageId ?? null,
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
  }).onDuplicateKeyUpdate({ set: { id: sql`id` } })
}

/** El texto que se guarda para un mensaje entrante que no es texto (foto, audio, ubicación…). */
export function textoEntrante(message: any): string {
  if (message?.type === 'text') return String(message.text?.body ?? '')
  if (message?.type === 'button') return String(message.button?.text ?? 'Tocó un botón')
  if (message?.type === 'interactive') {
    return String(message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? 'Respondió una opción')
  }
  const tipos: Record<string, string> = {
    image: '📷 Foto', audio: '🎤 Audio', video: '🎬 Video', document: '📄 Documento',
    sticker: 'Sticker', location: '📍 Ubicación', contacts: '👤 Contacto', reaction: 'Reaccionó a un mensaje',
  }
  const caption = message?.[message?.type]?.caption
  return [tipos[message?.type] ?? 'Mensaje', caption].filter(Boolean).join(' · ')
}

export interface ResumenChat {
  clave: string
  telefono: string
  nombre: string | null
  clienteId: number | null
  ultimoTexto: string
  ultimoOrigen: 'cliente' | 'bot' | 'tanda'
  ultimoAt: string
  recibidos: number
}

async function clientesPorClave(db: any, restauranteId: number) {
  const filas = await db.select({ id: ClienteTable.id, nombre: ClienteTable.nombre, telefono: ClienteTable.telefono })
    .from(ClienteTable).where(eq(ClienteTable.restauranteId, restauranteId))
  const mapa = new Map<string, { id: number; nombre: string }>()
  for (const f of filas) {
    const clave = claveTelefono(f.telefono)
    if (clave && !mapa.has(clave)) mapa.set(clave, { id: f.id, nombre: f.nombre })
  }
  return mapa
}

/** Sólo las conversaciones donde el cliente escribió algo, la más reciente primero. */
export async function listarChats(db: any, restauranteId: number, dias = 120): Promise<ResumenChat[]> {
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000)
  const filas = await db.select().from(ChatTable)
    .where(and(eq(ChatTable.restauranteId, restauranteId), gte(ChatTable.createdAt, desde)))
    .orderBy(desc(ChatTable.createdAt)).limit(5000)
  const clientes = await clientesPorClave(db, restauranteId)
  const chats = new Map<string, ResumenChat>()
  for (const f of filas) {
    let chat = chats.get(f.clave)
    if (!chat) {
      const c = clientes.get(f.clave)
      chat = {
        clave: f.clave, telefono: f.telefono, nombre: c?.nombre ?? null, clienteId: c?.id ?? null,
        ultimoTexto: f.texto, ultimoOrigen: f.origen, ultimoAt: new Date(f.createdAt).toISOString(), recibidos: 0,
      }
      chats.set(f.clave, chat)
    }
    if (f.direccion === 'entrante') {
      chat.recibidos++
      // El número que escribió es el que sirve para abrirle el chat.
      chat.telefono = f.telefono
    }
  }
  return [...chats.values()].filter((c) => c.recibidos > 0)
}

export async function leerChat(db: any, restauranteId: number, clave: string) {
  const filas = await db.select({
    id: ChatTable.id, direccion: ChatTable.direccion, origen: ChatTable.origen, texto: ChatTable.texto,
    imagenUrl: ChatTable.imagenUrl, createdAt: ChatTable.createdAt, telefono: ChatTable.telefono,
  }).from(ChatTable)
    .where(and(eq(ChatTable.restauranteId, restauranteId), eq(ChatTable.clave, clave)))
    .orderBy(desc(ChatTable.createdAt)).limit(300)
  if (!filas.some((f: any) => f.direccion === 'entrante')) return null
  const c = (await clientesPorClave(db, restauranteId)).get(clave)
  return {
    clave,
    telefono: filas.find((f: any) => f.direccion === 'entrante')?.telefono ?? filas[0].telefono,
    nombre: c?.nombre ?? null,
    clienteId: c?.id ?? null,
    mensajes: filas.reverse().map((f: any) => ({
      id: f.id, direccion: f.direccion, origen: f.origen, texto: f.texto, imagenUrl: f.imagenUrl,
      createdAt: new Date(f.createdAt).toISOString(),
    })),
  }
}
