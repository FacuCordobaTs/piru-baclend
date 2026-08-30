import { describe, expect, test } from 'bun:test'
import { computarPerfilesRFM } from './clientes-rfm'

const MS_DIA = 24 * 60 * 60 * 1000
const ahora = new Date('2026-08-30T15:00:00.000Z').getTime()
const haceDias = (dias: number) => ahora - dias * MS_DIA

describe('computarPerfilesRFM', () => {
  test('mantiene nuevo a un cliente con un solo pedido aunque haya pasado mucho tiempo', () => {
    const [perfil] = computarPerfilesRFM([{
      cantidadPedidos: 1,
      totalGastado: 12_000,
      fechasPedidos: [haceDias(365)],
    }], ahora)

    expect(perfil.segmento).toBe('nuevo')
    expect(perfil.cadenciaDias).toBeNull()
    expect(perfil.diasDesdeUltimo).toBe(365)
  })

  test('aplica los segmentos de recencia cuando ya existe un patrón de recompra', () => {
    const [perfil] = computarPerfilesRFM([{
      cantidadPedidos: 2,
      totalGastado: 24_000,
      fechasPedidos: [haceDias(180), haceDias(170)],
    }], ahora)

    expect(perfil.cadenciaDias).toBe(10)
    expect(perfil.segmento).toBe('perdido')
  })
})
