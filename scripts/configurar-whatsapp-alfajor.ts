/** Desde el backend de la VPS: bun scripts/configurar-whatsapp-alfajor.ts [--aplicar]
 * Vincula a Alfajor el phone_number_id observado en sus mensajes entrantes.
 * No cambia tokens, números destinatarios ni la configuración de otros locales.
 */
import { createConnection, type RowDataPacket } from 'mysql2/promise'

const restauranteId = 6
const phoneId = '1066629946527874'
const aplicar = Bun.argv.includes('--aplicar')
let db: Awaited<ReturnType<typeof createConnection>> | undefined

class ErrorConfiguracion extends Error {}

try {
  db = await createConnection({
    host: 'localhost', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  })
  await db.beginTransaction()
  const [locales] = await db.execute<RowDataPacket[]>(`
    SELECT id, nombre, whatsapp_phone_id AS phoneId,
           whatsapp_access_token IS NOT NULL AND whatsapp_access_token <> '' AS tieneToken
    FROM restaurante WHERE id = ? OR whatsapp_phone_id = ? FOR UPDATE
  `, [restauranteId, phoneId])
  const alfajor = locales.find(local => local.id === restauranteId)
  if (!alfajor) throw new ErrorConfiguracion('No existe el restaurante 6.')
  const conflicto = locales.find(local => local.id !== restauranteId)
  if (conflicto) throw new ErrorConfiguracion(`El número ya pertenece al restaurante ${conflicto.id}. No se cambió nada.`)
  if (!alfajor.tieneToken && !process.env.WHATSAPP_API_TOKEN) {
    throw new ErrorConfiguracion('Falta el token de Alfajor y WHATSAPP_API_TOKEN. No se cambió nada.')
  }

  console.log('Asociación de WhatsApp:', {
    restauranteId, nombre: alfajor.nombre, phoneIdActual: alfajor.phoneId,
    phoneIdCorrecto: phoneId, tokenDisponible: true,
  })
  if (!aplicar) {
    await db.rollback()
    console.log('Para aplicar: bun scripts/configurar-whatsapp-alfajor.ts --aplicar')
  } else {
    await db.execute('UPDATE restaurante SET whatsapp_phone_id = ? WHERE id = ?', [phoneId, restauranteId])
    const [verificacion] = await db.execute<RowDataPacket[]>(
      'SELECT id FROM restaurante WHERE whatsapp_phone_id = ?', [phoneId],
    )
    if (verificacion.length !== 1 || verificacion[0].id !== restauranteId) {
      throw new ErrorConfiguracion('La asociación no quedó exclusivamente en Alfajor. Se revierte el cambio.')
    }
    await db.commit()
    console.log('Aplicado: los mensajes de este número se enrutan al restaurante 6. No hace falta reiniciar el backend por este cambio de DB.')
    console.log('Mandá otro mensaje a Alfajor y revisá que el log diga: Enrutado a restaurante 6.')
  }
} catch (error) {
  await db?.rollback().catch(() => {})
  const driver = error as { code?: string; errno?: number }
  console.error('No se pudo configurar Alfajor:', error instanceof ErrorConfiguracion
    ? error.message : { code: driver?.code, errno: driver?.errno })
  process.exitCode = 1
} finally {
  await db?.end()
}
