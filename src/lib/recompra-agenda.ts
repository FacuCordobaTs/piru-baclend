import { and, asc, eq, sql } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { restaurante, campanaRecompra, colaRecompra } from '../db/schema'
import { cargarCohorteRecompra, type ClienteCohorte } from './recupero'
import { obtenerConfigMotor } from './motor-recompra'
import { calcularPatronEnvio, obtenerComponentesArgentina } from './motor-recompra-patron'
import { cargarDiasAbiertos, diasValleDelLocal, obtenerDiasFlojos } from './dias-flojos-db'
import { ErrorProgramacion } from './dias-flojos'
import { normalizarTelefonoCliente } from './clientes-identidad'
import { DIA_MS, fechaArgentina, horarioSemanal, ocurrenciaSemanal, ordenarOportunidades, siguienteHorario, textoInvitacionDia } from './recompra-semana'

type Db = MySql2Database<Record<string, never>>
const protegido = (c: ClienteCohorte) => c.optOut || c.topeAlcanzado || !normalizarTelefonoCliente(c.telefono)

/** Una campaña interna conserva historial y FK; no representa una tanda del operador. */
async function agendaDelLocal(db: Db, restauranteId: number) {
  const [existente] = await db.select().from(campanaRecompra)
    .where(and(eq(campanaRecompra.restauranteId, restauranteId), eq(campanaRecompra.origen, 'semanal'))).limit(1)
  if (existente) return existente.id
  const [ins] = await db.insert(campanaRecompra).values({
    restauranteId, origen: 'semanal', estado: 'activa', modo: 'manual', toqueHasta: 3,
    porcentajeControl: 0, activadaAt: new Date(),
  })
  return Number((ins as any).insertId)
}

export const dependenciasAgenda = {
  config: obtenerConfigMotor, cohorte: cargarCohorteRecompra, abiertos: cargarDiasAbiertos, valle: diasValleDelLocal, analisis: obtenerDiasFlojos,
}

/** POST explícito y job: nunca se escribe desde un GET. Bloqueo por tenant para evitar duplicados. */
export async function sincronizarAgendaSemanal(db: Db, restauranteId: number, ahora = Date.now(), dependencias = dependenciasAgenda) {
  return db.transaction(async tx => {
    const d = tx as unknown as Db
    await d.select({ id: restaurante.id }).from(restaurante).where(eq(restaurante.id, restauranteId)).for('update')
    const [config, cohorte, todas, abiertos, valle] = await Promise.all([
      dependencias.config(d, restauranteId), dependencias.cohorte(d, restauranteId, { incluirProtegidos: true, incluirActivos: true }),
      d.select().from(colaRecompra).where(eq(colaRecompra.restauranteId, restauranteId)).orderBy(asc(colaRecompra.id)),
      dependencias.abiertos(d, restauranteId), dependencias.valle(d, restauranteId),
    ])
    const campanaId = await agendaDelLocal(d, restauranteId)
    const porId = new Map(cohorte.map(c => [c.clienteId, c]))
    const ocupados = new Set<number>()
    // Reconciliar compras, bajas y duplicados históricos antes de agregar nuevos clientes.
    for (const fila of todas.filter(f => f.estado === 'pendiente')) {
      const c = porId.get(fila.clienteId)
      const nuevaCompra = c && c.ultimoPedidoMs != null && c.ultimoPedidoMs > new Date(fila.ultimoPedidoAtSnapshot ?? 0).getTime()
      const activo = c?.segmentoCliente === 'activo' || c?.segmentoCliente === 'vip'
      const invitacionVencida = fila.tipoMensaje === 'dia_flojo' && fila.dueDate && fechaArgentina(new Date(fila.dueDate).getTime()) < fechaArgentina(ahora)
      if (!c || protegido(c) || nuevaCompra || invitacionVencida || ocupados.has(fila.clienteId)
        || (fila.tipoMensaje !== 'dia_flojo' && (activo || c.toquesDesdeUltimoPedido >= config.toqueHasta || (fila.toque ?? 1) > config.toqueHasta || (fila.toque ?? 1) !== c.toquesDesdeUltimoPedido + 1))) {
        await d.update(colaRecompra).set({ estado: 'salido', errorEnvio: invitacionVencida ? 'invitacion_vencida' : 'agenda_reconciliada' })
          .where(and(eq(colaRecompra.id, fila.id), eq(colaRecompra.restauranteId, restauranteId)))
        continue
      }
      ocupados.add(fila.clienteId)
      if (fila.tipoMensaje !== 'dia_flojo' && (fila.toque ?? 1) > 1 && c.ultimoToqueMs != null) {
        const proximo = siguienteHorario(c.ultimoToqueMs, fila.toque === 2 ? config.diasToque2 : config.diasToque3, abiertos)
        await d.update(colaRecompra).set({ ...proximo, horarioSugerido: horarioSemanal(proximo.diaSemana, proximo.minutoDia) })
          .where(and(eq(colaRecompra.id, fila.id), eq(colaRecompra.restauranteId, restauranteId)))
      }
      if (fila.diaSemana == null || fila.minutoDia == null) {
        const momento = obtenerComponentesArgentina(new Date(fila.dueDate ?? ahora).getTime())
        await d.update(colaRecompra).set({ diaSemana: momento.diaSemana, minutoDia: momento.hora * 60 + momento.minutos })
          .where(and(eq(colaRecompra.id, fila.id), eq(colaRecompra.restauranteId, restauranteId)))
      }
    }
    let agregados = 0
    const altas: (typeof colaRecompra.$inferInsert)[] = []
    for (const c of cohorte) {
      if (protegido(c) || ocupados.has(c.clienteId) || c.segmentoCliente === 'activo' || c.segmentoCliente === 'vip' || c.toquesDesdeUltimoPedido >= config.toqueHasta) continue
      const ciclo = String(c.ultimoPedidoMs ?? 0)
      const toque = c.toquesDesdeUltimoPedido + 1
      // No revivir salidas ni fallos de este mismo ciclo durante cada actualización.
      const existente = todas.find(f => f.campanaId === campanaId && f.clienteId === c.clienteId && f.ciclo === ciclo && f.toque === toque)
      if (existente && !(existente.estado === 'salido' && existente.errorEnvio === 'agenda_reconciliada')) continue
      let diaSemana: number, minutoDia: number, dueDate: Date
      if (toque > 1 && c.ultimoToqueMs != null) {
        const proximo = siguienteHorario(c.ultimoToqueMs, toque === 2 ? config.diasToque2 : config.diasToque3, abiertos)
        ;({ diaSemana, minutoDia, dueDate } = proximo)
      } else {
        const patron = calcularPatronEnvio(c.fechasPedidosMs, c.segmento, ahora, c.clienteId, valle)
        diaSemana = patron.diaSemana
        minutoDia = patron.hora * 60 + (patron.minutos ?? 0)
        // El 1º contacto de segunda compra nunca invita al día siguiente de su pedido.
        const piso = Math.max((c.ultimoPedidoMs ?? 0) + 7 * DIA_MS, (c.ultimoToqueMs ?? 0) + 2 * DIA_MS)
        dueDate = ocurrenciaSemanal(diaSemana, minutoDia, ahora, piso)
        while (abiertos.length && !abiertos.includes(diaSemana)) {
          dueDate = new Date(dueDate.getTime() + DIA_MS)
          diaSemana = obtenerComponentesArgentina(dueDate.getTime()).diaSemana
        }
      }
      if (existente) {
        await d.update(colaRecompra).set({ estado: 'pendiente', errorEnvio: null, dueDate, diaSemana, minutoDia, horarioSugerido: horarioSemanal(diaSemana, minutoDia) })
          .where(and(eq(colaRecompra.id, existente.id), eq(colaRecompra.restauranteId, restauranteId)))
        continue
      }
      altas.push({ restauranteId, campanaId, clienteId: c.clienteId, ciclo, toque, diaSemana, minutoDia, dueDate,
        telefono: c.telefono, segmento: c.segmento, prioridad: c.totalGastado.toFixed(2),
        poblacion: 'flujo', rol: 'contactado', estado: 'pendiente', horarioSugerido: horarioSemanal(diaSemana, minutoDia),
        totalGastadoSnapshot: c.totalGastado.toFixed(2), ultimoPedidoAtSnapshot: c.ultimoPedidoMs == null ? null : new Date(c.ultimoPedidoMs),
      })
    }
    // Chunks no acotan la cantidad; sólo el tamaño de cada sentencia SQL.
    for (let i = 0; i < altas.length; i += 250) await d.insert(colaRecompra).values(altas.slice(i, i + 250))
    agregados = altas.length
    if (agregados) await d.update(campanaRecompra).set({ totalDetectados: sql`${campanaRecompra.totalDetectados} + ${agregados}` })
      .where(and(eq(campanaRecompra.id, campanaId), eq(campanaRecompra.restauranteId, restauranteId)))
    return { agregados }
  })
}

/** Sólo oportunidades fuera de la agenda: no se adelantan ni duplican toques existentes. */
export async function oportunidadesDiaFlojo(db: Db, restauranteId: number, dia: number, ahora = Date.now(), dependencias = dependenciasAgenda) {
  const [analisis, cohorte, pendientes] = await Promise.all([
    dependencias.analisis(db, restauranteId), dependencias.cohorte(db, restauranteId, { incluirActivos: true }),
    db.select({ clienteId: colaRecompra.clienteId }).from(colaRecompra)
      .where(and(eq(colaRecompra.restauranteId, restauranteId), eq(colaRecompra.estado, 'pendiente'))),
  ])
  const esFlojo = analisis.suficientesDatos && analisis.flojos.some(f => f.diaSemana === dia)
  const ocupados = new Set(pendientes.map(f => f.clienteId))
  const candidatos = !esFlojo ? [] : ordenarOportunidades(cohorte.filter(c => !protegido(c) && !c.cooldownHasta && !ocupados.has(c.clienteId)
    && (c.ultimoPedidoMs == null || fechaArgentina(c.ultimoPedidoMs) !== fechaArgentina(ahora))
    && (c.segmentoCliente === 'activo' || c.segmentoCliente === 'vip')), dia)
  return { esFlojo, candidatos: candidatos.map(c => ({ clienteId: c.clienteId, nombre: c.nombre, telefono: c.telefono,
    segmento: c.segmentoCliente, ticketPromedio: c.totalGastado / Math.max(1, c.cantidadPedidos),
    motivo: c.fechasPedidosMs.some(f => obtenerComponentesArgentina(f).diaSemana === dia) ? 'Suele comprar este día de la semana' : 'Cliente habitual con oportunidad de volver hoy',
    mensaje: textoInvitacionDia(c.segmentoCliente ?? '', dia), descuento: 0,
  })) }
}

export async function sumarClientesHoy(db: Db, restauranteId: number, clienteIds: number[], ahora = Date.now(), dependencias = dependenciasAgenda) {
  return db.transaction(async tx => {
    const d = tx as unknown as Db
    await d.select({ id: restaurante.id }).from(restaurante).where(eq(restaurante.id, restauranteId)).for('update')
    const dia = obtenerComponentesArgentina(ahora).diaSemana
    const oportunidades = await oportunidadesDiaFlojo(d, restauranteId, dia, ahora, dependencias)
    if (!oportunidades.esFlojo) throw new ErrorProgramacion('Hoy no aparece como día flojo en el historial del local')
    const elegibles = new Set(oportunidades.candidatos.map(c => c.clienteId))
    const ids = [...new Set(clienteIds)].filter(id => elegibles.has(id))
    if (!ids.length) throw new ErrorProgramacion('Los clientes elegidos ya no están disponibles para invitar hoy')
    const cohorte = await dependencias.cohorte(d, restauranteId, { incluirActivos: true })
    const campanaId = await agendaDelLocal(d, restauranteId)
    const minutoDia = Math.min(21 * 60 + 59, Math.max(11 * 60, obtenerComponentesArgentina(ahora).hora * 60 + obtenerComponentesArgentina(ahora).minutos))
    for (const id of ids) {
      const c = cohorte.find(c => c.clienteId === id)!
      await d.insert(colaRecompra).values({ restauranteId, campanaId, clienteId: id,
        ciclo: `dia-flojo:${fechaArgentina(ahora)}`, tipoMensaje: 'dia_flojo', toque: 1, diaSemana: dia, minutoDia,
        dueDate: new Date(ahora), telefono: c.telefono, segmento: c.segmentoCliente,
        poblacion: 'flujo', rol: 'contactado', estado: 'pendiente', prioridad: c.totalGastado.toFixed(2),
        mensajePersonalizado: textoInvitacionDia(c.segmentoCliente ?? '', dia), horarioSugerido: horarioSemanal(dia, minutoDia),
        ultimoPedidoAtSnapshot: c.ultimoPedidoMs == null ? null : new Date(c.ultimoPedidoMs), totalGastadoSnapshot: c.totalGastado.toFixed(2),
      })
    }
    return { agregados: ids.length, ignorados: clienteIds.filter(id => !ids.includes(id)) }
  })
}
