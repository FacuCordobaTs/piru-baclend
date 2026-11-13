import { describe, expect, test } from 'bun:test'
import { liquidarRepartidor, type ConfigPagoRepartidor } from './repartidor-pagos'

const config: ConfigPagoRepartidor = {
  precioEnvio: 500,
  pagoDiaHabil: 10_000,
  pagoFinDeSemana: 15_000,
  pagoFeriado: 20_000,
}

describe('liquidarRepartidor', () => {
  test('suma envíos y el fijo de cada tipo de día', () => {
    const liquidacion = liquidarRepartidor(config, [
      { fecha: '2026-08-17', entregas: 3 }, // lunes feriado (San Martín)
      { fecha: '2026-08-18', entregas: 2 }, // martes hábil
      { fecha: '2026-08-22', entregas: 1 }, // sábado
    ])

    expect(liquidacion).toEqual({
      entregas: 6,
      diasTrabajados: 3,
      diasHabiles: 1,
      diasFinDeSemana: 1,
      diasFeriados: 1,
      pagoEnvios: 3000,
      pagoDias: 45_000,
      pagoTotal: 48_000,
    })
  })

  test('un feriado propio del local reemplaza la tarifa del día', () => {
    const liquidacion = liquidarRepartidor(
      config,
      [{ fecha: '2026-08-18', entregas: 1 }],
      new Set(['2026-08-18']),
    )
    expect(liquidacion.diasFeriados).toBe(1)
    expect(liquidacion.diasHabiles).toBe(0)
    expect(liquidacion.pagoDias).toBe(20_000)
  })

  test('sin días trabajados no hay fijo ni envíos', () => {
    const liquidacion = liquidarRepartidor(config, [])
    expect(liquidacion.diasTrabajados).toBe(0)
    expect(liquidacion.pagoTotal).toBe(0)
  })

  test('sin importes configurados no inventa un pago', () => {
    const liquidacion = liquidarRepartidor(
      { precioEnvio: 0, pagoDiaHabil: 0, pagoFinDeSemana: 0, pagoFeriado: 0 },
      [{ fecha: '2026-08-18', entregas: 5 }],
    )
    expect(liquidacion.pagoTotal).toBe(0)
  })

  test('redondea a centavos sin arrastrar decimales de coma flotante', () => {
    const liquidacion = liquidarRepartidor(
      { ...config, precioEnvio: 333.33 },
      [{ fecha: '2026-08-18', entregas: 3 }],
    )
    expect(liquidacion.pagoEnvios).toBe(999.99)
  })
})
