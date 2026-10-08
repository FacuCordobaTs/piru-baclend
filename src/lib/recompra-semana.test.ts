import { describe, expect, test } from 'bun:test'
import { fechaArgentina, horarioSemanal, ocurrenciaSemanal, ordenarOportunidades, siguienteHorario, textoInvitacionDia } from './recompra-semana'
import { estadoRecupero } from './recompra-goteo'
import { calcularPatronEnvio, obtenerComponentesArgentina } from './motor-recompra-patron'
import { ofertaProductoEstaVigente } from './campana-oferta'
const ms = (s: string) => Date.parse(s + '-03:00')

describe('agenda semanal continua', () => {
  test('jueves 12:46 conserva sus minutos y sigue visible después de esa hora', () => {
    const inicio = ms('2026-10-08T12:46:00')
    const fecha = ocurrenciaSemanal(4, 12 * 60 + 46, ms('2026-10-08T20:00:00'), inicio)
    expect(fecha.getTime()).toBe(inicio)
    expect(horarioSemanal(4, 766)).toBe('Jueves 12:46 hs')
  })
  test('un jueves sin enviar no se mezcla con viernes: reaparece el siguiente jueves', () => {
    expect(fechaArgentina(ocurrenciaSemanal(4, 766, ms('2026-10-09T12:00:00'), ms('2026-10-08T12:46:00')).getTime())).toBe('2026-10-15')
  })
  test('los próximos siete días contienen la próxima ocurrencia de cada cliente', () => {
    const fechas = Array.from({ length: 7 }, (_, dia) => fechaArgentina(ocurrenciaSemanal(dia, 19 * 60, ms('2026-10-08T20:00:00')).getTime()))
    expect(new Set(fechas).size).toBe(7)
    expect(fechas.every(f => f >= '2026-10-08' && f <= '2026-10-14')).toBe(true)
  })
  test('el segundo toque del jueves va al sábado y el tercero al lunes', () => {
    const segundo = siguienteHorario(ms('2026-10-08T12:46:15'), 2, [0,1,2,3,4,5,6])
    expect(segundo.diaSemana).toBe(6)
    expect(fechaArgentina(segundo.dueDate.getTime())).toBe('2026-10-10')
    expect(segundo.dueDate.getTime()).toBeGreaterThanOrEqual(ms('2026-10-08T12:46:15') + 48 * 3600000)
    const tercero = siguienteHorario(segundo.dueDate.getTime(), 2, [0,1,2,3,4,5,6])
    expect(tercero.diaSemana).toBe(1)
    expect(fechaArgentina(tercero.dueDate.getTime())).toBe('2026-10-12')
  })
  test('si el sábado cierra, el toque del jueves pasa al domingo', () => {
    expect(siguienteHorario(ms('2026-10-08T12:46:00'), 2, [0,1,2,3,4,5]).diaSemana).toBe(0)
  })
  test('un intervalo inválido nunca adelanta el contacto a menos de 48 horas', () => {
    const ahora = ms('2026-10-08T21:59:59')
    expect(siguienteHorario(ahora, 0, [0,1,2,3,4,5,6]).dueDate.getTime()).toBeGreaterThanOrEqual(ahora + 48 * 3600000)
  })
  test('antes del piso, la ocurrencia no aparece en la semana equivocada', () => {
    expect(fechaArgentina(ocurrenciaSemanal(4, 766, ms('2026-10-08T11:00:00'), ms('2026-10-09T11:00:00')).getTime())).toBe('2026-10-15')
  })
  test('el patrón de compras conserva 12:46', () => {
    expect(calcularPatronEnvio([ms('2026-10-01T12:46:00')], 'primer_pedido', ms('2026-10-08T10:00:00')).minutos).toBe(46)
  })
  test('los días se interpretan en Argentina, incluso cuando UTC ya es mañana', () => {
    expect(fechaArgentina(Date.parse('2026-10-09T01:00:00Z'))).toBe('2026-10-08')
    expect(obtenerComponentesArgentina(Date.parse('2026-10-09T01:00:00Z')).diaSemana).toBe(4)
  })
})
describe('refuerzo de días flojos', () => {
  test('la afinidad al día precede a VIP y al ticket', () => {
    const lista = ordenarOportunidades([
      { clienteId: 1, segmentoCliente: 'vip', fechasPedidosMs: [ms('2026-10-01T12:46:00')], totalGastado: 10000, cantidadPedidos: 1 },
      { clienteId: 2, segmentoCliente: 'activo', fechasPedidosMs: [ms('2026-09-30T12:46:00')], totalGastado: 1000, cantidadPedidos: 1 },
    ], 3)
    expect(lista.map(c => c.clienteId)).toEqual([2,1])
  })
  test('activos y VIP tienen invitaciones propias sin promesas de descuento', () => {
    const activo = textoInvitacionDia('activo', 3)
    const vip = textoInvitacionDia('vip', 3)
    expect(activo).not.toBe(vip)
    expect(vip).toContain('especialmente')
    for (const texto of [activo,vip]) {
      expect(texto).toContain('miércoles')
      expect(texto).toContain('{link}')
      expect(texto).not.toMatch(/descuento|%|extrañamos/)
    }
  })
  test('la invitación cuenta para descanso pero no sube la escalera', () => {
    const ahora = ms('2026-10-08T12:46:00')
    const estado = estadoRecupero([{ nivel: 0, createdAt: new Date(ahora - 3600000) }], ahora - 10 * 86400000, ahora)
    expect(estado.toquesDesdeUltimoPedido).toBe(0)
    expect(estado.proximoNivel).toBe(1)
    expect(estado.puedeEnviar).toBe(false)
  })
  test('la oferta exclusiva del miércoles se valida también al pagar', () => {
    const oferta = { id: 1, productoId: 1, descuentoProductoPorcentaje: 20, limiteUsos: null, usosActuales: 0, fechaInicio: null, fechaFin: null, diaSemana: 3 }
    expect(ofertaProductoEstaVigente(oferta, new Date(ms('2026-10-07T12:00:00')))).toBe(true)
    expect(ofertaProductoEstaVigente(oferta, new Date(ms('2026-10-08T12:00:00')))).toBe(false)
    expect(ofertaProductoEstaVigente(oferta, new Date(ms('2026-10-14T12:00:00')))).toBe(true)
  })
})
