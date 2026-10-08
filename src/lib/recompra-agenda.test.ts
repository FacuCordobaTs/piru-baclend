import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { getTableColumns, getTableName, SQL } from 'drizzle-orm'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { sincronizarAgendaSemanal, oportunidadesDiaFlojo, sumarClientesHoy, dependenciasAgenda } from './recompra-agenda'
import type { ClienteCohorte } from './recupero'
import { fechaArgentina } from './recompra-semana'
import { marcarFilaColaComoEnviadaManual, obtenerMensajeFilaCola } from './motor-recompra'
afterEach(() => setSystemTime())

const ahora = Date.parse('2026-10-08T15:00:00-03:00')
const diaMs = 86400000
const cliente = (id: number, extra: Partial<ClienteCohorte> = {}): ClienteCohorte => ({
  clienteId: id, nombre: `Cliente ${id}`, telefono: '5491112345678', segmento: 'dormido', segmentoCliente: 'dormido',
  diasDesdeUltimo: 35, totalGastado: 20000, ultimoPedidoMs: ahora - 35 * diaMs,
  cantidadPedidos: 2, proximoNivel: 1, toquesDesdeUltimoPedido: 0, ultimoToqueMs: null,
  fechasPedidosMs: [ahora - 35 * diaMs, ahora - 42 * diaMs], ...extra,
})
const config = { estado: 'activa', modo: 'manual', automaticoDisponible: false, cupoDiario: 2, toqueHasta: 3,
  diasToque2: 2, diasToque3: 2, porcentajeControl: 0, ultimoDrenajeDia: null, avisoSinSaldoAt: null }
const fila = (id: number, extra: Record<string, unknown> = {}) => ({
  id, restauranteId: 7, campanaId: 19, clienteId: id, rol: 'contactado', estado: 'pendiente', toque: 1, ciclo: String(ahora - 35 * diaMs),
  tipoMensaje: 'recompra', diaSemana: 4, minutoDia: 766, dueDate: new Date(ahora - 35 * diaMs),
  ultimoPedidoAtSnapshot: new Date(ahora - 35 * diaMs), ...extra,
})

// Este repositorio ejecuta los WHERE que produce Drizzle, incluida la separación entre locales.
// No abre MySQL: la migración necesita validación adicional sobre la base efectiva.
function repositorio(cola: any[] = []) {
  const dialect = new MySqlDialect()
  const tablas: Record<string, any[]> = { restaurante: [{ id: 7 }, { id: 8 }], cola_recompra: cola,
    campana_recompra: [{ id: 19, restauranteId: 7, origen: 'semanal', estado: 'activa', totalDetectados: 0 }] }
  tablas.restaurante[0] = { id: 7, nombre: 'Brasa', username: 'brasa', whatsappEnabled: false };
  tablas.config_motor_recompra = [{ restauranteId: 7, ...config }];
  tablas.cliente = [{ id: 1, restauranteId: 7, nombre: 'Ana', telefono: '5491112345678', marketingOptOut: false }];
  tablas.pedido_unificado = [{ id: 1, restauranteId: 7, clienteId: 1, createdAt: new Date(ahora - 35 * diaMs), estado: 'delivered', total: '20000' }];
  tablas.recupero_cliente = [];
  let siguienteId = 1000
  function filtro(tabla: any, condicion?: SQL) {
    if (!condicion) return () => true
    const q = dialect.sqlToQuery(condicion)
    const nombres = Object.fromEntries(Object.entries(getTableColumns(tabla) as Record<string, { name: string }>).map(([k, c]) => [c.name, k]))
    let indice = 0;
    const reglas = [...q.sql.matchAll(/`[^`]+`\.`([^`]+)` (not in|in|=) (\?|\([^)]*\))/g)].map(m => {
      const cantidad = (m[3].match(/\?/g) ?? []).length;
      const valores = q.params.slice(indice, indice + cantidad); indice += cantidad;
      return { key: nombres[m[1]], op: m[2], valores };
    });
    if (indice !== q.params.length || /\bor\b/i.test(q.sql)) throw Error('WHERE no implementado en prueba: ' + q.sql);
    return (row: any) => reglas.every(r => r.op === 'not in' ? !r.valores.includes(row[r.key]) : r.valores.includes(row[r.key]));
  }
  const db: any = {
    transaction: async (f: any) => f(db),
    select: (seleccion?: Record<string, any>) => {
      let tabla: any, condicion: SQL, limite = Infinity
      const builder: any = {
        from: (t: any) => { tabla = t; return builder }, where: (c: SQL) => { condicion = c; return builder },
        limit: (n: number) => { limite = n; return builder }, orderBy: () => builder, for: () => builder,
        then: (resolve: any, reject: any) => {
          const rows = (tablas[getTableName(tabla)] ?? []).filter(filtro(tabla, condicion)).slice(0, limite);
          const campos = Object.fromEntries(Object.entries(getTableColumns(tabla) as Record<string, { name: string }>).map(([k, c]) => [c.name, k]));
          const resultado = seleccion && Object.values(seleccion).some(v => v instanceof SQL)
            ? [Object.fromEntries(Object.keys(seleccion).map(k => [k, rows.length]))]
            : rows.map(r => seleccion ? Object.fromEntries(Object.entries(seleccion).map(([alias,c]) => [alias,r[campos[c.name]]])) : ({ ...r }));
          return Promise.resolve(resultado).then(resolve, reject);
        },
      }
      return builder
    },
    insert: (t: any) => ({ values: async (values: any) => {
      const rows = Array.isArray(values) ? values : [values]
      const target = tablas[getTableName(t)] ??= []
      for (const r of rows) {
        if (getTableName(t) === 'cola_recompra' && target.some(e => e.campanaId === r.campanaId && e.clienteId === r.clienteId && e.ciclo === r.ciclo && e.toque === r.toque)) throw Error('Duplicado')
        target.push({ createdAt: new Date(), id: siguienteId++, tipoMensaje: 'recompra', ...r })
      }
      return [{ insertId: target.at(-1).id }]
    } }),
    update: (t: any) => ({ set: (values: any) => ({ where: async (where: SQL) => {
      for (const r of (tablas[getTableName(t)] ?? []).filter(filtro(t, where))) {
        for (const [key, value] of Object.entries(values)) {
          if (value instanceof SQL) r[key] = Number(r[key] ?? 0) + Number(dialect.sqlToQuery(value).params[0])
          else r[key] = value
        }
      }
      return [{ affectedRows: 1 }]
    } }) }),
  }
  return { db, cola: tablas.cola_recompra, campanas: tablas.campana_recompra, tablas }
}
function deps(cohorte: ClienteCohorte[], patch: Record<string, unknown> = {}): typeof dependenciasAgenda {
  return {
    config: async () => ({ ...config, ...patch }) as any,
    cohorte: async () => cohorte,
    abiertos: async () => [0,1,2,3,4,5,6], valle: async () => [1,2,3],
    analisis: async () => ({ suficientesDatos: true, flojos: [{ diaSemana: 4 }] }) as any,
  }
}

describe('reconciliación de la agenda continua', () => {
  test('agenda TODOS los 613 clientes aunque el cupo automático sea 2; repetir no duplica', async () => {
    const r = repositorio(), d = deps(Array.from({ length: 613 }, (_, i) => cliente(i + 1)))
    expect(await sincronizarAgendaSemanal(r.db, 7, ahora, d)).toEqual({ agregados: 613 })
    expect(r.cola).toHaveLength(613)
    expect(r.cola.every(f => f.toque === 1 && f.diaSemana === 4 && f.rol === 'contactado')).toBe(true)
    expect(await sincronizarAgendaSemanal(r.db, 7, ahora, d)).toEqual({ agregados: 0 })
    expect(r.cola).toHaveLength(613)
  })
  test('una sincronización conserva pendientes de su día y no toca el otro local', async () => {
    const ajena = fila(2, { restauranteId: 8, clienteId: 1, minutoDia: 123 })
    const r = repositorio([fila(1), ajena])
    await sincronizarAgendaSemanal(r.db, 7, ahora + diaMs, deps([cliente(1)]))
    expect(r.cola).toHaveLength(2)
    expect(r.cola[0]).toMatchObject({ estado: 'pendiente', diaSemana: 4, minutoDia: 766 })
    expect(r.cola[1]).toEqual(ajena)
    await sincronizarAgendaSemanal(r.db, 8, ahora, deps([cliente(3)]))
    expect(r.campanas.find(c => c.restauranteId === 8)).toBeDefined()
    expect(r.cola.some(f => f.restauranteId === 8 && f.clienteId === 3)).toBe(true)
  })
  test('bajas, sin teléfono, tope, activos, VIP y secuencias completas no reciben recupero', async () => {
    const r = repositorio()
    await sincronizarAgendaSemanal(r.db, 7, ahora, deps([
      cliente(1, { optOut: true }), cliente(2, { telefono: 'inválido' }), cliente(3, { topeAlcanzado: true }),
      cliente(4, { segmentoCliente: 'activo' }), cliente(5, { segmentoCliente: 'vip' }), cliente(6, { toquesDesdeUltimoPedido: 3 }), cliente(7),
    ]))
    expect(r.cola.map(f => f.clienteId)).toEqual([7])
  })
  test('una compra cierra el pendiente; su nuevo ciclo comienza después del descanso', async () => {
    const r = repositorio([fila(1)])
    await sincronizarAgendaSemanal(r.db, 7, ahora, deps([cliente(1, { ultimoPedidoMs: ahora, fechasPedidosMs: [ahora], segmento: 'primer_pedido' })]))
    expect(r.cola[0].estado).toBe('salido')
    expect(r.cola[1]).toMatchObject({ toque: 1, ciclo: String(ahora) })
    expect(r.cola[1].dueDate.getTime()).toBeGreaterThanOrEqual(ahora + 7 * diaMs)
  })
  test('recupera el segundo toque desde el envío del jueves y respeta un sábado cerrado', async () => {
    const r = repositorio(), d = deps([cliente(1, { toquesDesdeUltimoPedido: 1, ultimoToqueMs: ahora })])
    d.abiertos = async () => [0,1,2,3,4,5]
    await sincronizarAgendaSemanal(r.db, 7, ahora, d)
    expect(r.cola[0]).toMatchObject({ toque: 2, diaSemana: 0 })
    expect(fechaArgentina(r.cola[0].dueDate.getTime())).toBe('2026-10-11')
  })
  test('cambiar intervalo reubica el siguiente toque; bajar y subir el máximo conserva su historial', async () => {
    const r = repositorio([fila(1, { toque: 2 })])
    const cohorte = [cliente(1, { toquesDesdeUltimoPedido: 1, ultimoToqueMs: ahora })]
    await sincronizarAgendaSemanal(r.db, 7, ahora, deps(cohorte, { diasToque2: 3 }))
    expect(r.cola[0].diaSemana).toBe(0)
    await sincronizarAgendaSemanal(r.db, 7, ahora, deps(cohorte, { toqueHasta: 1 }))
    expect(r.cola[0].estado).toBe('salido')
    await sincronizarAgendaSemanal(r.db, 7, ahora, deps(cohorte, { toqueHasta: 3 }))
    expect(r.cola).toHaveLength(1)
    expect(r.cola[0]).toMatchObject({ estado: 'pendiente', toque: 2, diaSemana: 6 })
  })
  test('cierra duplicados históricos y toques que el ledger ya avanzó', async () => {
    const r = repositorio([fila(1), fila(2, { clienteId: 1 }), fila(3)])
    await sincronizarAgendaSemanal(r.db, 7, ahora, deps([cliente(1), cliente(3, { toquesDesdeUltimoPedido: 2, ultimoToqueMs: ahora })]))
    expect(r.cola.filter(f => f.estado === 'pendiente').map(f => [f.clienteId, f.toque])).toEqual([[1,1],[3,3]])
  })
})

describe('reforzar Hoy con clientes habituales', () => {
  test('encuentra activos y VIP sin adelantar recuperos ni violar descansos', async () => {
    const r = repositorio([fila(1)]), d = deps([
      cliente(1, { segmentoCliente: 'activo' }), cliente(2, { segmentoCliente: 'vip' }), cliente(3, { segmentoCliente: 'activo' }),
      cliente(4, { optOut: true, segmentoCliente: 'vip' }), cliente(5, { segmentoCliente: 'vip', cooldownHasta: new Date(ahora + diaMs).toISOString() }),
      cliente(6, { segmentoCliente: 'activo', ultimoPedidoMs: ahora }), cliente(7),
    ])
    const o = await oportunidadesDiaFlojo(r.db, 7, 4, ahora, d)
    expect(o.candidatos.map(c => c.clienteId)).toEqual([2,3])
    expect(o.candidatos.every(c => c.descuento === 0)).toBe(true)
    expect(o.candidatos[0].mensaje).not.toBe(o.candidatos[1].mensaje)
    expect(await sumarClientesHoy(r.db, 7, [2,3,1,999], ahora, d)).toEqual({ agregados: 2, ignorados: [1,999] })
    expect(r.cola.slice(1).every(f => f.tipoMensaje === 'dia_flojo' && f.segmento !== 'dormido')).toBe(true)
    await expect(sumarClientesHoy(r.db, 7, [2,3], ahora, d)).rejects.toThrow('ya no están disponibles')
    await sincronizarAgendaSemanal(r.db, 7, ahora + diaMs, d)
    expect(r.cola.filter(f => f.tipoMensaje === 'dia_flojo').every(f => f.estado === 'salido' && f.errorEnvio === 'invitacion_vencida')).toBe(true)
  })
  test('si hoy no es flojo no permite crear invitaciones', async () => {
    const r = repositorio(), d = deps([cliente(1, { segmentoCliente: 'vip' })])
    d.analisis = async () => ({ suficientesDatos: false, flojos: [] }) as any
    await expect(sumarClientesHoy(r.db, 7, [1], ahora, d)).rejects.toThrow('no aparece como día flojo')
    expect(r.cola).toHaveLength(0)
  })
})

describe('envío real de los toques de la agenda', () => {
  test('bajar el máximo bloquea la confirmación aunque la agenda todavía no se haya sincronizado', async () => {
    setSystemTime(ahora)
    const r = repositorio([fila(1, { toque: 2 })])
    r.tablas.config_motor_recompra[0].toqueHasta = 1
    const vista = await obtenerMensajeFilaCola(r.db, 7, 1, {}, ahora)
    expect(vista.ok && vista.data.envio).toMatchObject({ puedeEnviar: false, motivo: 'Este cliente ya completó el máximo de toques configurado' })
    expect(await marcarFilaColaComoEnviadaManual(r.db, 7, 1)).toMatchObject({ ok: false, mensaje: 'Este cliente ya completó el máximo de toques configurado' })
    expect(r.tablas.recupero_cliente).toHaveLength(0)
    expect(r.cola[0].estado).toBe('pendiente')
  })
  test('marcar jueves genera sábado; el copy elegido no adelanta la escalera, y el tercero termina', async () => {
    setSystemTime(ahora)
    const r = repositorio([fila(1)])
    const primero = await marcarFilaColaComoEnviadaManual(r.db, 7, 1, { toque: 3, link: 'lo-mismo', descuento: 0 })
    expect(primero).toMatchObject({ ok: true, nivel: 1, toque: 3 })
    expect(r.tablas.recupero_cliente).toHaveLength(1)
    expect(r.cola[0]).toMatchObject({ estado: 'enviado', toque: 1, toqueEnviado: 3 })
    const segundo = r.cola.find(f => f.toque === 2)!
    expect(segundo).toMatchObject({ diaSemana: 6, estado: 'pendiente', ciclo: r.cola[0].ciclo })
    expect(fechaArgentina(segundo.dueDate.getTime())).toBe('2026-10-10')
    await marcarFilaColaComoEnviadaManual(r.db, 7, 1)
    expect(r.tablas.recupero_cliente).toHaveLength(1)
    setSystemTime(segundo.dueDate)
    expect(await marcarFilaColaComoEnviadaManual(r.db, 7, segundo.id, { link: 'lo-mismo', descuento: 0 })).toMatchObject({ ok: true, nivel: 2 })
    const tercero = r.cola.find(f => f.toque === 3)!
    expect(tercero.diaSemana).toBe(1)
    setSystemTime(tercero.dueDate)
    expect(await marcarFilaColaComoEnviadaManual(r.db, 7, tercero.id, { link: 'lo-mismo', descuento: 0 })).toMatchObject({ ok: true, nivel: 3 })
    expect(r.cola).toHaveLength(3)
    expect(r.cola.every(f => f.estado === 'enviado')).toBe(true)
    expect(r.tablas.recupero_cliente).toHaveLength(3)
  })
  test('una compra antes de confirmar detiene el mensaje sin registrar un envío', async () => {
    setSystemTime(ahora)
    const r = repositorio([fila(1)])
    r.tablas.pedido_unificado.push({ id: 2, restauranteId: 7, clienteId: 1, createdAt: new Date(ahora), estado: 'delivered' })
    expect(await marcarFilaColaComoEnviadaManual(r.db, 7, 1)).toMatchObject({ ok: false, mensaje: 'Este cliente ya volvió a comprar' })
    expect(r.tablas.recupero_cliente).toHaveLength(0)
    expect(r.cola[0].estado).toBe('pendiente')
  })
  test('una invitación VIP fuerza su propio texto y cero descuento, y no genera segundo toque', async () => {
    setSystemTime(ahora)
    const r = repositorio([fila(1, { tipoMensaje: 'dia_flojo', segmento: 'vip', dueDate: new Date(ahora),
      mensajePersonalizado: 'Hola {nombre}, este jueves te esperamos en {local}. {link}' })])
    const opciones = { link: 'reactivacion' as const, descuento: 30 }
    const mensaje = await obtenerMensajeFilaCola(r.db, 7, 1, opciones, ahora)
    expect(mensaje.ok).toBe(true)
    if (!mensaje.ok) return
    expect(mensaje.data).toMatchObject({ tipoMensaje: 'dia_flojo', segmentoCliente: 'vip', descuento: 0, link: 'lo-mismo', codigoDescuento: null })
    expect(mensaje.data.texto).toContain('Hola Ana, este jueves te esperamos en Brasa.')
    expect(await marcarFilaColaComoEnviadaManual(r.db, 7, 1, opciones)).toMatchObject({ ok: true, nivel: 0, descuento: 0 })
    expect(r.cola).toHaveLength(1)
    expect(r.tablas.recupero_cliente[0].nivel).toBe(0)
    expect(r.tablas.codigo_descuento ?? []).toHaveLength(0)
  })
})
