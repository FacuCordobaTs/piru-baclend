import { expect, mock, test } from 'bun:test'
import { createConnection, createPool, type Connection } from 'mysql2/promise'
import { drizzle } from 'drizzle-orm/mysql2'
import { getTableConfig, MySqlDialect, MySqlTable } from 'drizzle-orm/mysql-core'
import { is, SQL } from 'drizzle-orm'
import * as schema from '../src/db/schema'
import { resolverClienteParaPedido } from '../src/lib/clientes-identidad'
import { backfillPedidosPos, auditarClientesPos, consolidarGrupoCliente, descubrirReferenciasCliente, sentenciasMigracion } from '../src/lib/pos-mantenimiento'

const url = process.env.POS_TEST_MYSQL_URL
// Sólo fixtures sintéticos en una base NUEVA; jamás usar una base existente.
test.skipIf(!url)('MySQL: migraciones, POST POS, carrera, clientes, edición, índice y consolidación', async () => {
  const admin = await createConnection(url!)
  const nombre = `piru_pos_test_${crypto.randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE \`${nombre}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  const uri = new URL(url!); uri.pathname = '/' + nombre
  const pool = createPool({ uri: uri.toString(), connectionLimit: 6 })
  const db = await createConnection(uri.toString())
  const orm = drizzle(pool)
  try {
    // Crear un esquema anterior a esta tarea usando los tipos reales. Las FKs
    // sintéticas abajo comprueban discovery, incluidas compuestas y sin FK.
    const dialect = new MySqlDialect()
    for (const table of Object.values(schema)) {
      if (!is(table, MySqlTable)) continue
      const config = getTableConfig(table)
      const columns = config.columns.filter(c => !(config.name === 'cliente' && ['telefono_normalizado', 'updated_at'].includes(c.name))
        && !(config.name === 'pedido_unificado' && c.name === 'client_request_id'))
      const defs = columns.map((c: any) => {
        let def = `\`${c.name}\` ${c.getSQLType()}${c.notNull ? ' NOT NULL' : ''}${c.autoIncrement ? ' AUTO_INCREMENT' : ''}${c.primary ? ' PRIMARY KEY' : ''}`
        if (c.default !== undefined) {
          if (is(c.default, SQL)) { const q = dialect.sqlToQuery(c.default); def += ' DEFAULT ' + db.format(q.sql, q.params) }
          else def += ' DEFAULT ' + db.escape(c.default)
        }
        return def
      })
      // Los certificados legacy de restaurante son VARCHAR(8192) en Drizzle:
      // esa tabla auxiliar necesita latin1 para caber; cliente/POS usan utf8mb4.
      await db.query(`CREATE TABLE \`${config.name}\` (${defs.join(',')}) ENGINE=InnoDB DEFAULT CHARSET=${config.name === 'restaurante' ? 'latin1' : 'utf8mb4'}`)
    }
    await db.query("INSERT INTO restaurante (id,nombre,email,completed_onboarding) VALUES (1,'Local A','a@example.test',1),(2,'Local B','b@example.test',1)")
    await db.query("INSERT INTO producto (id,restaurante_id,nombre,precio) VALUES (1,1,'Pizza',100),(2,2,'Pizza B',200)")
    await db.query("INSERT INTO cliente (id,restaurante_id,nombre,telefono,puntos,marketing_opt_out) VALUES (1,1,'Viejo','341 5123456',3,1),(2,1,'Reciente','(341)5123456',4,0),(3,2,'Otro tenant','3415123456',0,0),(4,1,'Sin identidad','123',0,0)")
    expect(Number((await auditarClientesPos(db)).gruposDuplicados)).toBe(1)
    const additive = sentenciasMigracion(await Bun.file(new URL('../migrations/add_pos_offline_clientes.sql', import.meta.url)).text())
    const unique = sentenciasMigracion(await Bun.file(new URL('../migrations/unique_cliente_telefono_normalizado.sql', import.meta.url)).text())
    for (let i = 0; i < 2; i++) for (const sql of additive) await db.query(sql)
    const [columnas] = await db.query<any[]>("SELECT telefono_normalizado FROM cliente ORDER BY id")
    expect(columnas.map(c => c.telefono_normalizado)).toEqual(['3415123456', '3415123456', '3415123456', null])
    let rechazo = false
    try { for (const sql of unique) await db.query(sql) } catch (error: any) { rechazo = error.code === 'ER_SIGNAL_EXCEPTION' }
    expect(rechazo).toBe(true)

    // El helper ya serializa perfiles nuevos antes de habilitar unicidad.
    const perfiles = await Promise.all(Array.from({ length: 4 }, () => orm.transaction(tx => resolverClienteParaPedido(tx, { restauranteId: 1, nombre: 'Nuevo', telefono: '11 5555 8888' }))))
    expect(new Set(perfiles.map(p => p!.id)).size).toBe(1)
    expect(await orm.transaction(tx => resolverClienteParaPedido(tx, { restauranteId: 1, nombre: 'Sin teléfono', telefono: '123' }))).toBeNull()
    const otro = await orm.transaction(tx => resolverClienteParaPedido(tx, { restauranteId: 2, nombre: 'Nuevo', telefono: '11 5555 8888' }))
    expect(otro!.id).not.toBe(perfiles[0]!.id)

    // HTTP real, con autenticación/módulo simulados para las dos cuentas fixture.
    // La escritura, transacción, Zod, route y respuestas son los de producción.
    mock.module('../src/db', () => ({ pool }))
    mock.module('../src/middleware/auth', () => ({ authMiddleware: async (c: any, next: any) => {
      const token = c.req.header('Authorization')
      if (!['Bearer 1', 'Bearer 2'].includes(token)) return c.json({ success: false }, 401)
      c.user = { id: Number(token.slice(-1)) }; return next()
    } }))
    mock.module('../src/middleware/modulo', () => ({ requireModulo: () => async (c: any, next: any) => c.req.header('X-Sin-Pos') ? c.json({ moduleRequired: true }, 403) : next() }))
    const eventos: any[] = []
    const pedidos = await import('../src/lib/pedidos-activos')
    mock.module('../src/lib/pedidos-activos', () => ({ ...pedidos, emitirEventoPedido: async (_db: any, event: any) => { eventos.push(event) } }))
    const { pedidoUnificadoRoute } = await import('../src/routes/pedido-unificado')
    const { clientesRoute } = await import('../src/routes/clientes')
    const post = (body: any, tenant = 1) => pedidoUnificadoRoute.request('/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tenant}` }, body: JSON.stringify(body) })
    const input = { tipo: 'takeaway', clientRequestId: crypto.randomUUID(), nombreCliente: 'Caja', telefono: '(11) 5555-8888', anotadoManualmente: true, pagado: true, items: [{ productoId: 1, cantidad: 2 }] }
    const carrera = await Promise.all([post(input), post(input)])
    expect(carrera.map(r => r.status).sort()).toEqual([200, 201])
    const bodies = await Promise.all(carrera.map(r => r.json() as Promise<any>))
    expect(bodies[0].data.id).toBe(bodies[1].data.id)
    expect(bodies[0].data.clienteId).toBe(perfiles[0]!.id)
    expect(eventos).toHaveLength(1)
    const pedidoId = bodies[0].data.id
    const [items] = await db.query<any[]>('SELECT COUNT(*) AS n FROM item_pedido_unificado WHERE pedido_id=?', [pedidoId])
    expect(Number(items[0].n)).toBe(1)
    // Reintento incluso si el catálogo ya cambió: se responde antes de validarlo.
    expect((await post({ ...input, items: [{ productoId: 9999, cantidad: 1 }] })).status).toBe(200)
    expect(eventos).toHaveLength(1)
    // Admin viejo, sin UUID, sigue funcionando. Tenant separado puede usar el mismo UUID.
    expect((await post({ ...input, clientRequestId: undefined, telefono: '' })).status).toBe(201)
    const otroPedido = await (await post({ ...input, items: [{ productoId: 2, cantidad: 1 }] }, 2)).json() as any
    expect(otroPedido.data.id).not.toBe(pedidoId)
    expect((await post({ ...input, clientRequestId: 'invalido' })).status).toBe(400)
    const offline = await (await post({ ...input, clientRequestId: crypto.randomUUID(), impresoOffline: true })).json() as any
    const [impresion] = await db.query<any[]>('SELECT p.impreso, i.cantidad_impresa FROM pedido_unificado p JOIN item_pedido_unificado i ON i.pedido_id=p.id WHERE p.id=?', [offline.data.id])
    expect(impresion[0].impreso).toBe(1); expect(impresion[0].cantidad_impresa).toBe(2)
    expect(eventos.at(-1).shouldPrint).toBe(false)
    // Un pedido web también se puede editar; conserva origen y descuento.
    await db.query('UPDATE pedido_unificado SET anotado_manualmente=0, monto_descuento=25 WHERE id=?', [pedidoId])
    // Edición actualiza el vínculo sin modificar snapshots de pedidos anteriores.
    const edit = await pedidoUnificadoRoute.request(`/${pedidoId}/datos-pos`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer 1' }, body: JSON.stringify({ version: 1, nombreCliente: 'Editado', telefono: '22223333' }) })
    expect(edit.status).toBe(200)
    const edited = await edit.json() as any
    expect(edited.data.anotadoManualmente).toBe(false)
    expect(edited.data.editable).toBe(true)
    expect(edited.data.total).toBe('175.00')
    expect(edited.data.clienteId).not.toBe(perfiles[0]!.id)
    expect(edited.data.clienteIndice.telefonoNormalizado).toBe('22223333')
    const editCompleto = await pedidoUnificadoRoute.request(`/${pedidoId}/pos`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer 1' }, body: JSON.stringify({
      version: edited.data.version, tipo: 'takeaway', nombreCliente: 'Sin celular', telefono: '', metodoPago: 'cash', items: [{ productoId: 1, cantidad: 3 }],
    }) })
    expect(editCompleto.status).toBe(200)
    expect((await editCompleto.json() as any).data.clienteId).toBeNull()
    await db.query("INSERT INTO mesa_local (id,restaurante_id,nombre) VALUES (1,1,'Mesa 1')")
    const inputMesa = { ...input, tipo: 'mesa', mesaLocalId: 1, clientRequestId: crypto.randomUUID() }
    const mesas = await Promise.all([post(inputMesa), post(inputMesa)])
    expect(mesas.map(r => r.status).sort()).toEqual([200, 201])
    expect((await post({ ...inputMesa, clientRequestId: crypto.randomUUID() })).status).toBe(409)
    const delivery = await post({ ...input, tipo: 'delivery', direccion: 'Calle de prueba 123', deliveryFee: 50, clientRequestId: crypto.randomUUID(), telefono: '' })
    expect(delivery.status).toBe(201)
    const deliveryBody = await delivery.json() as any
    expect(deliveryBody.data.total).toBe('250.00')
    expect(deliveryBody.data.clienteId).toBeNull()
    const indiceRes = await clientesRoute.request('/indice-pos', { headers: { Authorization: 'Bearer 1' } })
    const indiceData = await indiceRes.json() as any
    expect(Object.keys(indiceData.data[0]).sort()).toEqual(['id', 'nombre', 'telefono', 'telefonoNormalizado', 'updatedAt'].sort())
    expect(indiceData.data.some((c: any) => c.id === otro!.id)).toBe(false)
    expect((await clientesRoute.request('/indice-pos')).status).toBe(401)
    expect((await clientesRoute.request('/indice-pos', { headers: { Authorization: 'Bearer 1', 'X-Sin-Pos': '1' } })).status).toBe(403)

    // Descubrimiento: legacy sin FK + nueva FK con otro nombre + FK compuesta.
    await db.query('ALTER TABLE cliente ADD UNIQUE INDEX fixture_cliente_tenant (restaurante_id,id)')
    await db.query('CREATE TABLE fixture_referencia (id INT PRIMARY KEY, restaurante_id INT, persona_id INT, FOREIGN KEY (restaurante_id,persona_id) REFERENCES cliente(restaurante_id,id))')
    await db.query('CREATE TABLE fixture_legacy (id INT PRIMARY KEY, cliente_id INT)')
    await db.query('INSERT INTO fixture_referencia VALUES (1,1,2)')
    await db.query('INSERT INTO fixture_legacy VALUES (1,2)')
    await db.query("UPDATE cliente SET updated_at='2026-01-01' WHERE id=1")
    await db.query("UPDATE cliente SET updated_at='2026-02-01' WHERE id=2")
    const refs = await descubrirReferenciasCliente(db)
    expect(refs.some(r => r.tabla === 'fixture_referencia' && r.columna === 'persona_id')).toBe(true)
    expect(refs.some(r => r.tabla === 'fixture_legacy')).toBe(true)
    // Una colisión imprevista debe revertir TODAS las referencias de este duplicado.
    await db.query('ALTER TABLE fixture_referencia ADD UNIQUE INDEX fixture_unica (persona_id)')
    await db.query('INSERT INTO fixture_referencia VALUES (2,1,1)')
    await expect(consolidarGrupoCliente(db, 1, 1, refs)).rejects.toThrow()
    expect((await db.query<any[]>('SELECT cliente_id FROM fixture_legacy'))[0][0].cliente_id).toBe(2)
    expect((await db.query<any[]>('SELECT COUNT(*) AS n FROM cliente WHERE id=2'))[0][0].n).toBe(1)
    await db.query('DELETE FROM fixture_referencia WHERE id=2')
    expect(await consolidarGrupoCliente(db, 1, 1, refs)).toBe(true)
    expect(await consolidarGrupoCliente(db, 1, 1, refs)).toBe(false)
    const [canonica] = await db.query<any[]>('SELECT nombre,puntos,marketing_opt_out FROM cliente WHERE id=1')
    expect(canonica[0]).toEqual({ nombre: 'Reciente', puntos: 7, marketing_opt_out: 1 })
    const [movida] = await db.query<any[]>('SELECT persona_id FROM fixture_referencia')
    expect(movida[0].persona_id).toBe(1)
    const audit = await auditarClientesPos(db)
    expect(Number(audit.gruposDuplicados)).toBe(0)
    expect(audit.referencias.every(r => !Number(r.huerfanas))).toBe(true)
    for (let i = 0; i < 2; i++) for (const sql of unique) await db.query(sql)
    await expect(db.query("INSERT INTO cliente (restaurante_id,nombre,telefono,telefono_normalizado) VALUES (1,'Duplicado','3415123456','3415123456')")).rejects.toThrow()
    await db.query("INSERT INTO pedido_unificado (restaurante_id,tipo,estado,nombre_cliente,telefono,total) VALUES (1,'takeaway','pending','Histórico','44445555',100),(1,'takeaway','cancelled','Cancelado','66667777',100),(1,'takeaway','pending','Corto','123',100)")
    let procesados = 0, vinculados = 0
    // Procesar uno por ejecución simula reinicios frecuentes del job.
    for (let i = 0; i < 20; i++) {
      const lote = await backfillPedidosPos(db, 1)
      procesados += lote.procesados; vinculados += lote.vinculados
      if (lote.loteAgotado) break
    }
    expect(vinculados).toBe(1)
    expect(procesados).toBeGreaterThan(1)
    expect((await backfillPedidosPos(db, 1)).procesados).toBe(0)
    const [historico] = await db.query<any[]>("SELECT nombre_cliente,telefono,cliente_id FROM pedido_unificado WHERE nombre_cliente IN ('Histórico','Cancelado','Corto') ORDER BY id")
    expect(historico[0].cliente_id).toBeGreaterThan(0)
    expect(historico[0].telefono).toBe('44445555')
    expect(historico[1].cliente_id).toBeNull(); expect(historico[2].cliente_id).toBeNull()
    expect(Number((await auditarClientesPos(db)).pedidosVinculables)).toBe(0)
    console.info('[pos_mysql_verificado]', { version: (await db.query<any[]>('SELECT VERSION() AS v'))[0][0].v, migracionAditiva: 2, migracionUnicidad: 2, duplicados: 0, eventos: eventos.length })
  } finally {
    await db.end(); await pool.end()
    // Exactamente la base sintética cuyo nombre se creó al comienzo de este test.
    if (!/^piru_pos_test_[a-f0-9]{32}$/.test(nombre)) throw new Error('Nombre de fixture inválido')
    await admin.query(`DROP DATABASE \`${nombre}\``)
    await admin.end()
  }
}, 120_000)
