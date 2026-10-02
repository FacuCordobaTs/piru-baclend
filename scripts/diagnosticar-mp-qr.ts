/** Diagnóstico manual en el VPS, desde la carpeta backend (Bun carga su .env).
 * Sin --reproducir sólo consulta la caja. Con el flag reproduce el último alta rechazado
 * y cancela inmediatamente cualquier orden aceptada. No modifica pedidos ni tablas.
 */
import { createConnection } from 'mysql2/promise'
import { randomUUID } from 'node:crypto'
import { crearClienteMpQr, diagnosticoErrorOrdenQr, diagnosticoSeguroQr, MpError } from '../src/lib/mp-qr'

const restauranteId = Number(Bun.argv[2])
if (!Number.isSafeInteger(restauranteId) || restauranteId <= 0) {
  console.error('Uso: bun scripts/diagnosticar-mp-qr.ts <restauranteId> [--reproducir]')
  process.exit(1)
}

let db: Awaited<ReturnType<typeof createConnection>> | undefined
try {
  db = await createConnection({ host: 'localhost', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, timezone: '-03:00' })
  const [filas] = await db.execute<any[]>(`
    SELECT c.pedido_id pedidoId, c.monto, caja.mp_pos_id mpPosId,
           caja.external_pos_id externalPosId, conexion.access_token accessToken,
           conexion.expira_at expiraAt
    FROM pos_cobro_qr c
    JOIN mp_caja_qr caja ON caja.id = c.caja_id AND caja.restaurante_id = c.restaurante_id
    JOIN mp_conexion_qr conexion ON conexion.restaurante_id = c.restaurante_id
    WHERE c.restaurante_id = ? AND c.estado = 'error' AND c.mp_order_id IS NULL
      AND conexion.conectado = 1 AND caja.activo = 1
    ORDER BY c.id DESC LIMIT 1`, [restauranteId])
  const intento = filas[0]
  if (!intento) throw new Error('No hay un intento rechazado sin orden de MP para este local.')
  if (intento.expiraAt && new Date(intento.expiraAt).getTime() <= Date.now()) {
    throw new Error('El token venció. Abrí la configuración del POS para renovarlo antes de diagnosticar.')
  }
  const mp = crearClienteMpQr({ obtenerToken: async () => intento.accessToken, refrescarToken: async () => null })
  const caja = await mp.obtenerCaja(restauranteId, intento.mpPosId)
  console.log('Caja del último rechazo:', { restauranteId, pedidoId: intento.pedidoId,
    monto: intento.monto, externalPosId: intento.externalPosId,
    existeEnMp: !!caja, activaEnMp: caja?.activa, externalIdCoincide: caja?.externalId === intento.externalPosId })
  if (!Bun.argv.includes('--reproducir')) {
    console.log('Para obtener el rechazo completo, agregá --reproducir. Durante la prueba la caja puede quedar ocupada unos segundos.')
  } else {
    const orden = await mp.crearOrdenQr(restauranteId, {
      monto: String(intento.monto), externalPosId: intento.externalPosId,
      referencia: `piru-diag-${randomUUID()}`, descripcion: `Pedido #${intento.pedidoId}`,
    })
    console.log('MP aceptó la orden de prueba. Cancelando:', orden.id)
    try {
      const cancelada = await mp.cancelarOrden(restauranteId, orden.id)
      console.log('Resultado de la cancelación:', { id: cancelada.id, status: cancelada.status })
      if (!['canceled', 'cancelled', 'expired'].includes(cancelada.status)) {
        console.error('La orden de prueba sigue activa. Revisala en la app de Mercado Pago:', orden.id)
        process.exitCode = 1
      }
    } catch (error) {
      console.error('No se pudo cancelar la orden de prueba. Cancelala en Mercado Pago:', orden.id,
        error instanceof MpError ? diagnosticoErrorOrdenQr(error) : diagnosticoSeguroQr(error))
      process.exitCode = 1
    }
  }
} catch (error) {
  console.error('Diagnóstico QR:', error instanceof MpError ? diagnosticoErrorOrdenQr(error)
    : error instanceof Error && ['No hay un intento', 'El token venció'].some((prefijo) => error.message.startsWith(prefijo))
      ? error.message : diagnosticoSeguroQr(error))
  process.exitCode = 1
} finally {
  await db?.end()
}
