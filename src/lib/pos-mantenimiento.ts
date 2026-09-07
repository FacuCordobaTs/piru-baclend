import type { Connection } from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import { and, eq, sql } from 'drizzle-orm'
import { pedidoUnificado } from '../db/schema'
import { bloquearIdentidadesRestaurante, normalizarTelefonoCliente, resolverClienteParaPedido } from './clientes-identidad'

export type ReferenciaCliente = { tabla: string; columna: string; tenant: boolean }
const ident = (s: string) => {
  if (!/^[a-zA-Z0-9_]+$/.test(s)) throw new Error('Identificador SQL no permitido')
  return '`' + s + '`'
}
export async function descubrirReferenciasCliente(db: Connection): Promise<ReferenciaCliente[]> {
  // Incluye referencias sin FK y FKs con nombres distintos de cliente_id.
  const [rows] = await db.query<any[]>(`
    SELECT DISTINCT c.TABLE_NAME AS tabla, c.COLUMN_NAME AS columna,
      EXISTS(SELECT 1 FROM information_schema.COLUMNS t WHERE t.TABLE_SCHEMA=c.TABLE_SCHEMA
        AND t.TABLE_NAME=c.TABLE_NAME AND t.COLUMN_NAME='restaurante_id') AS tenant
    FROM information_schema.COLUMNS c
    JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME AND t.TABLE_TYPE='BASE TABLE'
    WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME <> 'cliente' AND (
      c.COLUMN_NAME='cliente_id' OR EXISTS (
        SELECT 1 FROM information_schema.KEY_COLUMN_USAGE k
        WHERE k.TABLE_SCHEMA=c.TABLE_SCHEMA AND k.TABLE_NAME=c.TABLE_NAME AND k.COLUMN_NAME=c.COLUMN_NAME
          AND k.REFERENCED_TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME='cliente' AND k.REFERENCED_COLUMN_NAME='id'
      )) ORDER BY c.TABLE_NAME, c.COLUMN_NAME`)
  return rows.map(r => ({ tabla: r.tabla, columna: r.columna, tenant: !!r.tenant }))
}

export async function auditarClientesPos(db: Connection) {
  const referencias = await descubrirReferenciasCliente(db)
  const [columnas] = await db.query<any[]>("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cliente' AND COLUMN_NAME='telefono_normalizado'")
  // Permite levantar conteos ANTES de la migración aditiva, con la misma política.
  const normalizado = columnas.length ? 'telefono_normalizado'
    : "(CASE WHEN CHAR_LENGTH(REGEXP_REPLACE(telefono,'[^0-9]','')) BETWEEN 8 AND 20 THEN REGEXP_REPLACE(telefono,'[^0-9]','') ELSE NULL END)"
  const [totales] = await db.query<any[]>(`SELECT
    (SELECT COUNT(*) FROM cliente) AS clientes,
    (SELECT COUNT(*) FROM pedido_unificado) AS pedidos,
    (SELECT COUNT(*) FROM pedido_unificado WHERE cliente_id IS NULL AND estado <> 'cancelled'
      AND TRIM(COALESCE(nombre_cliente,'')) <> ''
      AND CHAR_LENGTH(REGEXP_REPLACE(COALESCE(telefono,''),'[^0-9]','')) BETWEEN 8 AND 20) AS pedidosVinculables,
    (SELECT COUNT(*) FROM (SELECT 1 FROM cliente WHERE ${normalizado} IS NOT NULL
      GROUP BY restaurante_id, ${normalizado} HAVING COUNT(*) > 1) grupos) AS gruposDuplicados`)
  const [grupos] = await db.query<any[]>(`SELECT restaurante_id AS restauranteId, MIN(id) AS canonicoId, COUNT(*) AS cantidad
    FROM cliente WHERE ${normalizado} IS NOT NULL GROUP BY restaurante_id, ${normalizado} HAVING COUNT(*)>1
    ORDER BY restaurante_id, MIN(id)`)
  const conteos = []
  for (const ref of referencias) {
    const tabla = ident(ref.tabla), columna = ident(ref.columna)
    const [r] = await db.query<any[]>(`SELECT COUNT(*) AS filas, SUM(${columna} IS NOT NULL) AS vinculadas FROM ${tabla}`)
    const [h] = await db.query<any[]>(`SELECT COUNT(*) AS huerfanas FROM ${tabla} r LEFT JOIN cliente c ON c.id=r.${columna}
      WHERE r.${columna} IS NOT NULL AND (c.id IS NULL${ref.tenant ? ' OR c.restaurante_id <> r.restaurante_id' : ''})`)
    conteos.push({ ...ref, ...r[0], ...h[0] })
  }
  // Reportes sólo con IDs y conteos, sin nombres, teléfonos ni cuerpos de pedidos.
  return { ...totales[0], grupos, referencias: conteos }
}

/** Un duplicado por transacción; una falla revierte referencias y borrado juntos.
 * Nunca deshabilita FKs ni descarta filas para sortear una colisión de unicidad. */
export async function consolidarGrupoCliente(db: Connection, restauranteId: number, canonicoId: number, referencias: ReferenciaCliente[]) {
  await db.beginTransaction()
  try {
    await db.query('SELECT id FROM restaurante WHERE id=? FOR UPDATE', [restauranteId])
    const [canonicos] = await db.query<any[]>('SELECT * FROM cliente WHERE id=? AND restaurante_id=? FOR UPDATE', [canonicoId, restauranteId])
    const canonico = canonicos[0]
    if (!canonico?.telefono_normalizado) { await db.rollback(); return false }
    const [duplicados] = await db.query<any[]>(`SELECT * FROM cliente WHERE restaurante_id=? AND telefono_normalizado=? AND id<>? ORDER BY id LIMIT 1 FOR UPDATE`,
      [restauranteId, canonico.telefono_normalizado, canonicoId])
    const duplicado = duplicados[0]
    if (!duplicado) { await db.rollback(); return false }
    const conteos: Array<{ tabla: string; columna: string; antes: number; despues: number }> = []
    for (const ref of referencias) {
      const tabla = ident(ref.tabla), columna = ident(ref.columna)
      if (ref.tenant) {
        const [cruzadas] = await db.query<any[]>(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${columna}=? AND NOT (restaurante_id <=> ?)`, [duplicado.id, restauranteId])
        if (Number(cruzadas[0].n)) throw new Error('REFERENCIA_TENANT_CRUZADA')
      }
      const [antes] = await db.query<any[]>(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${columna}=?`, [duplicado.id])
      await db.query(`UPDATE ${tabla} SET ${columna}=? WHERE ${columna}=?`, [canonicoId, duplicado.id])
      const [despues] = await db.query<any[]>(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${columna}=?`, [duplicado.id])
      if (Number(despues[0].n)) throw new Error('REFERENCIAS_PENDIENTES')
      conteos.push({ tabla: ref.tabla, columna: ref.columna, antes: Number(antes[0].n), despues: Number(despues[0].n) })
    }
    // Preferir el valor no vacío más reciente. El opt-out es conservador: una
    // identidad dada de baja no se reactiva por fusionarla con un perfil viejo.
    const ordenados = [canonico, duplicado].sort((a, b) => Number(new Date(b.updated_at)) - Number(new Date(a.updated_at)) || b.id - a.id)
    const reciente = (campo: string) => ordenados.find(c => typeof c[campo] === 'string' && c[campo].trim())?.[campo] ?? null
    await db.query(`UPDATE cliente SET nombre=?, telefono=?, direccion=?, puntos=?, marketing_opt_out=?, marketing_opt_out_at=?, updated_at=? WHERE id=? AND restaurante_id=?`, [
      reciente('nombre'), reciente('telefono'), reciente('direccion'), Number(canonico.puntos) + Number(duplicado.puntos),
      !!(canonico.marketing_opt_out || duplicado.marketing_opt_out),
      [canonico.marketing_opt_out_at, duplicado.marketing_opt_out_at].filter(Boolean).sort((a, b) => Number(new Date(b)) - Number(new Date(a)))[0] ?? null,
      ordenados[0].updated_at, canonicoId, restauranteId,
    ])
    await db.query('INSERT INTO pos_cliente_consolidacion (duplicado_id, canonico_id, restaurante_id, referencias) VALUES (?,?,?,?)',
      [duplicado.id, canonicoId, restauranteId, JSON.stringify(conteos)])
    // MySQL vuelve a validar todas las FKs al borrar. Si aparece una referencia
    // nueva durante el rollout, la transacción falla sin perder información.
    await db.query('DELETE FROM cliente WHERE id=? AND restaurante_id=?', [duplicado.id, restauranteId])
    await db.query("INSERT INTO pos_mantenimiento (tarea,ultimo_id,total) VALUES ('consolidacion',?,1) ON DUPLICATE KEY UPDATE ultimo_id=VALUES(ultimo_id),total=total+1", [duplicado.id])
    await db.commit()
    return true
  } catch (error) { await db.rollback(); throw error }
}

/** Divide scripts SQL con procedimientos y DELIMITER, sin ejecutar shell. */
export function sentenciasMigracion(source: string) {
  let delimiter = ';', buffer = ''
  const sentencias: string[] = []
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*--/.test(line) || !line.trim()) continue
    const cambio = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(line)
    if (cambio) { if (buffer.trim()) throw new Error('SQL sin terminar antes de DELIMITER'); delimiter = cambio[1]; continue }
    buffer += line + '\n'
    if (buffer.trimEnd().endsWith(delimiter)) { sentencias.push(buffer.trimEnd().slice(0, -delimiter.length)); buffer = '' }
  }
  if (buffer.trim()) throw new Error('SQL sin terminar')
  return sentencias
}

export async function backfillPedidosPos(db: Connection, limit: number) {
  const orm = drizzle(db)
  const [checkpoint] = await db.query<any[]>("SELECT ultimo_id FROM pos_mantenimiento WHERE tarea='backfill_pedidos'")
  const ultimo = Number(checkpoint[0]?.ultimo_id ?? 0)
  const [lote] = await db.query<any[]>(`SELECT id, restaurante_id FROM pedido_unificado WHERE id>? AND cliente_id IS NULL AND estado<>'cancelled' ORDER BY id LIMIT ?`, [ultimo, limit])
  let vinculados = 0
  for (const row of lote) {
    await orm.transaction(async tx => {
      await bloquearIdentidadesRestaurante(tx, row.restaurante_id)
      const [pedido] = await tx.select().from(pedidoUnificado).where(and(eq(pedidoUnificado.id, row.id), eq(pedidoUnificado.restauranteId, row.restaurante_id))).limit(1).for('update')
      if (pedido && !pedido.clienteId && pedido.estado !== 'cancelled' && pedido.nombreCliente?.trim() && normalizarTelefonoCliente(pedido.telefono)) {
        const cliente = await resolverClienteParaPedido(tx, { restauranteId: row.restaurante_id, nombre: pedido.nombreCliente, telefono: pedido.telefono })
        if (cliente) {
          await tx.update(pedidoUnificado).set({ clienteId: cliente.id }).where(eq(pedidoUnificado.id, row.id))
          vinculados++
        }
      }
      await tx.execute(sql`INSERT INTO pos_mantenimiento (tarea,ultimo_id,total) VALUES ('backfill_pedidos',${row.id},1)
        ON DUPLICATE KEY UPDATE ultimo_id=VALUES(ultimo_id),total=total+1`)
    })
  }
  return { procesados: lote.length, vinculados, ultimoId: lote.at(-1)?.id ?? ultimo, loteAgotado: lote.length < limit }
}
