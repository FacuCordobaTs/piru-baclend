import { createHash } from 'node:crypto'
import type { Pool, RowDataPacket } from 'mysql2/promise'

export const RESTAURANTE_ALFAJOR = 6
export const RESPUESTA_ALFAJOR = 'Cualquier duda o consulta, escribinos por Instagram a @alfajorconpapas.'
export const COOLDOWN_ALFAJOR_MS = 24 * 60 * 60 * 1000
const TIPO_RESPUESTA = 'alfajor_instagram'

/** El local 1 comparte el número con Alfajor para debug; la atención es de Alfajor.
 * Cualquier otra asociación múltiple es ambigua y requiere corregir la configuración.
 */
export function restauranteDeAtencionWhatsApp<T extends { id: number }>(locales: T[]): T | undefined {
  if (locales.length === 1) return locales[0]
  if (locales.length === 2 && locales.every(local => local.id === 1 || local.id === RESTAURANTE_ALFAJOR)) {
    return locales.find(local => local.id === RESTAURANTE_ALFAJOR)
  }
  return undefined
}

interface Consulta {
  restauranteId: number
  telefono: string
  phoneNumberId: string
  token: string
  timestamp?: string
}

type Enviar = (token: string, phoneId: string, data: { phone: string; text: string }) => Promise<{ success: boolean }>

/** Una respuesta por cliente cada 24 h, durable en las conversaciones existentes. */
export function crearRespuestaAlfajor(pool: Pick<Pool, 'getConnection'>, enviar: Enviar) {
  return async (consulta: Consulta): Promise<void> => {
    if (consulta.restauranteId !== RESTAURANTE_ALFAJOR) return
    if (!consulta.token) throw new Error('Alfajor no tiene credenciales para responder por WhatsApp')

    // Meta puede reenviar webhooks viejos: no abrir otra ventana por un mensaje de ayer.
    const fechaMensaje = Number(consulta.timestamp) * 1000
    if (Number.isFinite(fechaMensaje) && fechaMensaje > 0 && Date.now() - fechaMensaje >= COOLDOWN_ALFAJOR_MS) return

    const conexion = await pool.getConnection()
    const lock = `wa-alfajor:${createHash('sha256').update(consulta.telefono).digest('hex').slice(0, 40)}`
    let bloqueado = false
    try {
      // La misma conexión conserva el lock durante el envío. Funciona entre procesos;
      // un webhook concurrente del mismo cliente se descarta sin esperar a Meta.
      const [locks] = await conexion.query<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS adquirido', [lock])
      bloqueado = Number(locks[0]?.adquirido) === 1
      if (!bloqueado) return

      const [recientes] = await conexion.query<RowDataPacket[]>(`
        SELECT id FROM whatsapp_conversacion
        WHERE restaurante_id = ? AND telefono = ?
          AND JSON_UNQUOTE(JSON_EXTRACT(mensajes, '$[0].tipo')) = ?
          AND updated_at > DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 24 HOUR)
        LIMIT 1
      `, [RESTAURANTE_ALFAJOR, consulta.telefono, TIPO_RESPUESTA])
      if (recientes.length > 0) return

      const resultado = await enviar(consulta.token, consulta.phoneNumberId, {
        phone: consulta.telefono,
        text: RESPUESTA_ALFAJOR,
      })
      if (!resultado.success) throw new Error('No se pudo enviar la respuesta automática de Alfajor')

      // No se modifica el historial ni el borrador de la IA. La marca identifica
      // sólo esta respuesta: avisos de pedido/pago no consumen su ventana.
      await conexion.query(`
        INSERT INTO whatsapp_conversacion (restaurante_id, telefono, mensajes, estado_conversacion)
        VALUES (?, ?, ?, 'finalizado')
      `, [RESTAURANTE_ALFAJOR, consulta.telefono, JSON.stringify([
        { role: 'assistant', content: RESPUESTA_ALFAJOR, tipo: TIPO_RESPUESTA },
      ])])
    } finally {
      try {
        if (bloqueado) await conexion.query('SELECT RELEASE_LOCK(?)', [lock])
      } finally {
        conexion.release()
      }
    }
  }
}
