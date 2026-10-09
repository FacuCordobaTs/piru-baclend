/** Diagnóstico: bun scripts/configurar-whatsapp-alfajor.ts
 * Aplicar un ID confirmado: bun scripts/configurar-whatsapp-alfajor.ts <phone_number_id> --aplicar
 * Si estaba asignado por error a otro local, agregar --desde=<id> para trasladarlo.
 * No cambia tokens ni números destinatarios.
 */
import { createConnection, type RowDataPacket } from 'mysql2/promise'

const restauranteId = 6
const phoneId = Bun.argv.slice(2).find(arg => !arg.startsWith('--'))
const aplicar = Bun.argv.includes('--aplicar')
const desdeArg = Bun.argv.find(arg => arg.startsWith('--desde='))
const desdeId = desdeArg ? Number(desdeArg.slice('--desde='.length)) : undefined
let db: Awaited<ReturnType<typeof createConnection>> | undefined

class ErrorConfiguracion extends Error {}

try {
  if (phoneId && !/^\d{5,50}$/.test(phoneId)) throw new ErrorConfiguracion('El phone_number_id debe ser el ID numérico de Meta, no el teléfono.')
  if (desdeArg && (!Number.isSafeInteger(desdeId) || desdeId! <= 0 || desdeId === restauranteId)) {
    throw new ErrorConfiguracion('--desde debe identificar otro restaurante.')
  }
  if (aplicar && !phoneId) throw new ErrorConfiguracion('Indicá el phone_number_id confirmado en el nuevo log. Ya no se asume el ID de un evento anterior.')
  db = await createConnection({
    host: 'localhost', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  })
  await db.beginTransaction()
  const [locales] = await db.execute<RowDataPacket[]>(`
    SELECT id, nombre, whatsapp_phone_id AS phoneId, whatsapp_number AS numero,
           whatsapp_access_token IS NOT NULL AND whatsapp_access_token <> '' AS tieneToken
    FROM restaurante WHERE id IN (1, ?) OR whatsapp_phone_id = ? ORDER BY id FOR UPDATE
  `, [restauranteId, phoneId ?? ''])
  console.log('Asociaciones en la DB:', locales.map(local => ({
    id: local.id, nombre: local.nombre, phoneId: local.phoneId, numero: local.numero,
    tokenPropio: !!local.tieneToken,
  })))
  console.log('Número de plataforma:', { phoneId: process.env.WHATSAPP_PHONE_ID ?? null, tokenDisponible: !!process.env.WHATSAPP_API_TOKEN })
  const alfajor = locales.find(local => local.id === restauranteId)
  if (!alfajor) throw new ErrorConfiguracion('No existe el restaurante 6.')
  const conflictos = phoneId ? locales.filter(local => local.id !== restauranteId && local.phoneId === phoneId) : []
  if (aplicar && conflictos.some(local => local.id !== desdeId)) {
    throw new ErrorConfiguracion(`El número pertenece a otro local (${conflictos.map(local => local.id).join(', ')}). Si confirmaste que es el número de Alfajor, indicá --desde=<id>. No se cambió nada.`)
  }
  if (aplicar && desdeArg && (conflictos.length !== 1 || conflictos[0].id !== desdeId)) {
    throw new ErrorConfiguracion('El número ya no pertenece al local indicado en --desde. No se cambió nada.')
  }
  if (aplicar && !alfajor.tieneToken && !process.env.WHATSAPP_API_TOKEN) {
    throw new ErrorConfiguracion('Falta el token de Alfajor y WHATSAPP_API_TOKEN. No se cambió nada.')
  }
  if (!aplicar) {
    await db.rollback()
    console.log('No se cambió nada. Compará los IDs con phone_number_id y numero_destino del nuevo log.')
    console.log('Para aplicar: bun scripts/configurar-whatsapp-alfajor.ts <phone_number_id_confirmado> --aplicar [--desde=<id>]')
  } else {
    if (conflictos.length) {
      await db.execute('UPDATE restaurante SET whatsapp_phone_id = NULL WHERE id = ? AND whatsapp_phone_id = ?', [desdeId, phoneId])
    }
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
