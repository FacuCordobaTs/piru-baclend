/** Operación explícita. Nunca se importa desde index.ts ni corre durante deploy. */
import { createConnection } from 'mysql2/promise'
import { backfillPedidosPos, auditarClientesPos, consolidarGrupoCliente, descubrirReferenciasCliente, sentenciasMigracion } from '../src/lib/pos-mantenimiento'
import { createHash } from 'node:crypto'

const comando = process.argv[2] ?? 'audit'
const arg = (nombre: string) => { const i = process.argv.indexOf(nombre); return i < 0 ? undefined : process.argv[i + 1] }
const limit = Number(arg('--limit') ?? 100)
const muta = ['migrate-additive', 'migrate-unique', 'consolidate', 'backfill'].includes(comando)
if (!['check', 'audit', 'postcheck', 'migrate-additive', 'migrate-unique', 'consolidate', 'backfill'].includes(comando)) throw new Error('Comando POS desconocido')
if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit debe estar entre 1 y 1000')
if (muta && !process.env.POS_DATABASE_URL) throw new Error('Definir POS_DATABASE_URL explícitamente para modificar datos')
if (muta && !arg('--backup-manifest')) throw new Error('Se requiere --backup-manifest con checksum y evidencia de restauración')

let db: Awaited<ReturnType<typeof createConnection>> | undefined
try {
  db = process.env.POS_DATABASE_URL ? await createConnection(process.env.POS_DATABASE_URL) : await createConnection({
    host: 'localhost', user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, connectTimeout: 3000,
  })
  const [identity] = await db.query<any[]>('SELECT DATABASE() AS nombre, VERSION() AS version')
  if (comando === 'check') { console.log(JSON.stringify({ conectado: true, version: identity[0].version })); }
  else {
    if (muta) {
      const manifest = await Bun.file(arg('--backup-manifest')!).json()
      if (manifest.database !== identity[0].nombre || !manifest.restoredAt || !manifest.restoreReport || !manifest.file || !/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
        throw new Error('Manifest de backup incompleto o de otra base')
      }
      const hasher = createHash('sha256')
      for await (const chunk of Bun.file(manifest.file).stream()) hasher.update(chunk)
      if (hasher.digest('hex') !== manifest.sha256) throw new Error('Checksum del backup incorrecto')
      if (!(await Bun.file(manifest.restoreReport).exists())) throw new Error('Falta el reporte de restauración del backup')
    }
    const [lock] = await db.query<any[]>("SELECT GET_LOCK(SHA2(CONCAT(DATABASE(), ':pos-mantenimiento'),256), 0) AS adquirido")
    if (lock[0].adquirido !== 1) throw new Error('Otro mantenimiento POS está en curso')
    if (comando.startsWith('migrate-')) {
      const archivo = comando === 'migrate-additive' ? 'add_pos_offline_clientes.sql' : 'unique_cliente_telefono_normalizado.sql'
      // Dos comandos independientes: nunca aplicar ambas etapas juntas.
      for (const statement of sentenciasMigracion(await Bun.file(new URL('../migrations/' + archivo, import.meta.url)).text())) await db.query(statement)
      console.log(JSON.stringify({ migracion: archivo, aplicada: true }))
    } else if (comando === 'consolidate') {
      const antes = await auditarClientesPos(db)
      console.log(JSON.stringify({ fase: 'antes', ...antes }))
      const referencias = await descubrirReferenciasCliente(db)
      let total = 0
      for (const grupo of antes.grupos) {
        while (total < limit && await consolidarGrupoCliente(db, grupo.restauranteId, grupo.canonicoId, referencias)) total++
        if (total >= limit) break
      }
      console.log(JSON.stringify({ fase: 'despues', procesados: total, ...await auditarClientesPos(db) }))
    } else if (comando === 'backfill') {
      console.log(JSON.stringify(await backfillPedidosPos(db, limit)))
    } else {
      const reporte = await auditarClientesPos(db)
      console.log(JSON.stringify(reporte))
      if (comando === 'postcheck' && (Number(reporte.gruposDuplicados) || Number(reporte.pedidosVinculables) || reporte.referencias.some((r: { huerfanas: unknown }) => Number(r.huerfanas)))) process.exitCode = 2
    }
  }
} catch (error: any) {
  // No loguear SQL, URL de conexión ni datos de una fila que falló.
  console.error(JSON.stringify({ comando, error: error.code ?? error.cause?.code ?? 'PRECONDICION_O_DATOS_INVALIDOS', message: error.code || error.cause?.code ? undefined : error.message }))
  if (db && ['consolidate', 'backfill'].includes(comando)) {
    await db.query('INSERT INTO pos_mantenimiento (tarea,errores) VALUES (?,1) ON DUPLICATE KEY UPDATE errores=errores+1', [comando === 'backfill' ? 'backfill_pedidos' : 'consolidacion']).catch(() => {})
  }
  process.exitCode = 1
} finally { await db?.end() }
