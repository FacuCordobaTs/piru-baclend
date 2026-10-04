import { describe, expect, test } from 'bun:test'
import {
  calcularDiasFlojos,
  componerMensajeManual,
  diaOperativo,
  validarFechaObjetivo,
} from './dias-flojos'
import { calcularPatronEnvio } from './motor-recompra-patron'

const pedido = (fecha: string, pagado = true, estado = 'delivered') => ({
  createdAt: fecha,
  total: '1000',
  pagado,
  estado,
})
const ahora = Date.parse('2026-10-03T15:00:00Z')
describe('días flojos del local', () => {
  test('madrugada es la noche anterior en Argentina, hasta 05:59', () => {
    expect(diaOperativo(Date.parse('2026-10-03T04:00:00Z')).diaSemana).toBe(5)
    expect(diaOperativo(Date.parse('2026-10-03T08:59:00Z')).diaSemana).toBe(5)
    expect(diaOperativo(Date.parse('2026-10-03T09:00:00Z')).diaSemana).toBe(6)
  })
  test('divide por ocurrencias, excluye cancelados, ventas sólo pagadas y días cerrados', () => {
    const datos = calcularDiasFlojos(
      [
        pedido('2026-09-25T23:00:00Z'),
        pedido('2026-10-02T23:00:00Z', false),
        pedido('2026-10-02T23:00:00Z', true, 'cancelled'),
      ],
      { ahora, semanas: 2, diasAbiertos: [2, 5] },
    )
    expect(datos.suficientesDatos).toBe(true)
    expect(datos.dias[5].pedidosPromedio).toBe(1)
    expect(datos.dias[5].ventasPromedio).toBe(500)
    expect(
      datos.flojos.some((f) => f.diaSemana === 2 && f.franja === null),
    ).toBe(true)
    expect(datos.flojos.some((f) => f.diaSemana === 1)).toBe(false)
  })
  test('no propone análisis con menos de 2 semanas de pedidos', () => {
    const datos = calcularDiasFlojos([pedido('2026-09-25T23:00:00Z')], {
      ahora,
    })
    expect(datos.suficientesDatos).toBe(false)
    expect(datos.flojos).toEqual([])
  })
  test('franjas propias y noche cruzando medianoche', () => {
    const datos = calcularDiasFlojos(
      [pedido('2026-09-26T04:00:00Z'), pedido('2026-10-03T04:00:00Z')],
      {
        ahora,
        semanas: 2,
        franjas: [
          { id: 'cena', nombre: 'Cena', horaInicio: '20:00', horaFin: '03:00' },
        ],
      },
    )
    expect(datos.dias[5].franjas[0].pedidosPromedio).toBe(1)
  })
  test('los días valle reales reemplazan el fallback', () => {
    const fecha = Date.parse('2026-10-03T15:00:00Z')
    expect(
      calcularPatronEnvio([], 'perdido', fecha, 12, [0, 4]).diaSemana,
    ).toBe(0)
    expect(calcularPatronEnvio([], 'perdido', fecha, 12).diaSemana).toBe(1)
  })
})
describe('invitación con fecha y texto manual', () => {
  test('valida mañana, 14 días, fecha real y día abierto', () => {
    expect(
      validarFechaObjetivo('2026-10-04', 19, [0], ahora).dueDate.toISOString(),
    ).toBe('2026-10-04T22:00:00.000Z')
    expect(
      validarFechaObjetivo('2026-10-17', 11, [6], ahora).horarioSugerido,
    ).toContain('día flojo')
    for (const f of ['2026-10-03', '2026-10-18', '2026-02-30', '2026-9-04'])
      expect(() =>
        validarFechaObjetivo(f, 19, [0, 1, 2, 3, 4, 5, 6], ahora),
      ).toThrow()
    expect(() => validarFechaObjetivo('2026-10-04', 19, [1], ahora)).toThrow(
      'cerrado',
    )
    expect(() => validarFechaObjetivo('2026-10-04', 22, [0], ahora)).toThrow(
      'hora',
    )
  })
  test('toma el día argentino aunque UTC esté en el día siguiente', () => {
    const noche = Date.parse('2026-10-04T01:00:00Z')
    expect(validarFechaObjetivo('2026-10-04', 12, [0], noche).diaSemana).toBe(0)
  })
  test('variables en texto libre y link una única vez', () => {
    const v = {
      nombre: 'José',
      local: 'Brasa',
      favorito: 'pizza',
      tiempo: 'dos semanas',
      beneficio: '10 %',
      link: 'https://brasa.com/c/a',
    }
    expect(
      componerMensajeManual('Hola {nombre} 🍕 {beneficio}: {link}', v),
    ).toBe('Hola José 🍕 10 %: https://brasa.com/c/a')
    expect(componerMensajeManual('Pasá por {local}', v)).toBe(
      'Pasá por Brasa\n\nhttps://brasa.com/c/a',
    )
  })
})
