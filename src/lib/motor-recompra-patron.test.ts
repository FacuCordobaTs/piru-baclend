import { describe, expect, test } from 'bun:test'
import {
  calcularPatronEnvio,
  crearDateArgentina,
  obtenerComponentesArgentina,
} from './motor-recompra-patron'

describe('motor-recompra-patron', () => {
  test('detecta que Clari pide los viernes a las 21:00 hs y programa Viernes 21:00 hs (habitual)', () => {
    // Viernes 2026-08-07 21:00 ART
    const viernes1 = crearDateArgentina(2026, 7, 7, 21, 0).getTime()
    // Viernes 2026-08-14 21:30 ART
    const viernes2 = crearDateArgentina(2026, 7, 14, 21, 30).getTime()
    // Viernes 2026-08-21 20:45 ART
    const viernes3 = crearDateArgentina(2026, 7, 21, 20, 45).getTime()

    // Ahora es Martes 2026-08-25 15:00 ART
    const ahora = crearDateArgentina(2026, 7, 25, 15, 0).getTime()

    const patron = calcularPatronEnvio([viernes1, viernes2, viernes3], 'dormido', ahora, 123)

    expect(patron.diaSemana).toBe(5) // Viernes
    expect(patron.hora).toBe(21)
    expect(patron.horarioSugerido).toBe('Viernes 21:00 hs (habitual)')

    // El dueDate debe ser el próximo viernes: 2026-08-28 a las 21:00 ART
    const dueComp = obtenerComponentesArgentina(patron.dueDate.getTime())
    expect(dueComp.diaSemana).toBe(5)
    expect(dueComp.diaMes).toBe(28)
    expect(dueComp.hora).toBe(21)
  })

  test('asigna cliente perdido a días valle (Lunes, Martes o Miércoles)', () => {
    // Cliente perdido que pedía hace meses
    const pedidoAntiguo = crearDateArgentina(2026, 1, 10, 21, 0).getTime()
    // Ahora es Jueves 2026-08-27 12:00 ART
    const ahora = crearDateArgentina(2026, 7, 27, 12, 0).getTime()

    const patronLun = calcularPatronEnvio([pedidoAntiguo], 'perdido', ahora, 0)
    expect([1, 2, 3]).toContain(patronLun.diaSemana)
    expect(patronLun.horarioSugerido).toContain('(día valle)')

    const patronMar = calcularPatronEnvio([pedidoAntiguo], 'perdido', ahora, 1)
    expect([1, 2, 3]).toContain(patronMar.diaSemana)
    expect(patronMar.horarioSugerido).toContain('(día valle)')
  })

  test('reconoce y etiqueta primer_pedido según el único pedido previo', () => {
    // Primer pedido un Sábado a las 13:00 ART
    const primerPedido = crearDateArgentina(2026, 7, 15, 13, 0).getTime()
    const ahora = crearDateArgentina(2026, 7, 25, 10, 0).getTime()

    const patron = calcularPatronEnvio([primerPedido], 'primer_pedido', ahora, 45)
    expect(patron.diaSemana).toBe(6) // Sábado
    expect(patron.hora).toBe(13)
    expect(patron.horarioSugerido).toBe('Sábado 13:00 hs (según 1º pedido)')
  })

  test('acota horas tardías a las 21:00 hs para respetar la ventana de silencio (22:00 a 09:00)', () => {
    // Pedido a las 23:30 ART
    const pedidoTardio = crearDateArgentina(2026, 7, 10, 23, 30).getTime()
    const ahora = crearDateArgentina(2026, 7, 25, 10, 0).getTime()

    const patron = calcularPatronEnvio([pedidoTardio], 'en_riesgo', ahora, 10)
    expect(patron.hora).toBe(21) // acotado a 21:00
    expect(patron.horarioSugerido).toContain('21:00 hs')
  })
})
