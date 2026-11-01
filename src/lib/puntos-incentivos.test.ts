import { describe, expect, test } from 'bun:test'
import {
  compraMinimaParaPuntos,
  evaluarBonusPuntos,
  evaluarSaldoParaRecordatorio,
  lineaBonusPuntos,
  maximoPuntosParaCompra,
  recomendarPuntosParaRecompra,
  sugerirBonusPuntos,
  valorPuntoEnPesos,
  type ConfigIncentivosPuntos,
} from './puntos-incentivos'

/**
 * Los puntos como incentivo tienen que cuidar dos cosas a la vez: que el cliente reciba lo
 * prometido y que el local no entregue más margen del que decidió. Estos tests fijan los topes,
 * la compra mínima y la regla "recordar antes que regalar".
 */

const base: ConfigIncentivosPuntos = {
  activo: true,
  pesosPorPunto: 100,
  puntosMinimosCanje: 0,
  permiteCanjeEnvioGratis: true,
  puntosEnvioGratis: 300,
  permiteCanjeDescuento: true,
  descuentoTipo: 'fijo',
  descuentoValor: 1000,
  descuentoPuntosCosto: 500,
  puntosBonusTopePorcentaje: 12,
  puntosBonusMaximo: 500,
  puntosBonusPorCliente30Dias: 2,
}

describe('valor y topes de los puntos', () => {
  test('el valor del punto sale del canje configurado', () => {
    expect(valorPuntoEnPesos(base)).toBe(2)
  })

  test('sin canje monetario se usa una referencia conservadora de $1', () => {
    expect(valorPuntoEnPesos({
      ...base,
      permiteCanjeDescuento: false,
      permiteCanjeEnvioGratis: false,
    })).toBe(1)
  })

  test('el techo de margen acota los puntos de un pedido chico', () => {
    // 12 % de $5.000 = $600; a $2 por punto, 300 puntos.
    expect(maximoPuntosParaCompra(base, 5000)).toBe(300)
    expect(maximoPuntosParaCompra(base, 100000)).toBe(500)
  })

  test('la compra mínima hace que la promesa entre en el techo', () => {
    const minimo = compraMinimaParaPuntos(base, 300)
    expect(minimo).toBeGreaterThanOrEqual(5000)
    expect(maximoPuntosParaCompra(base, minimo)).toBeGreaterThanOrEqual(300)
  })
})

describe('autorización del bonus', () => {
  test('no se otorga con el club pausado', () => {
    expect(evaluarBonusPuntos({
      config: { ...base, activo: false },
      puntos: 100,
      montoCompra: 10000,
      otorgadosCliente30Dias: 0,
    })).toMatchObject({ permitido: false, puntos: 0 })
  })

  test('no se otorga si el pedido no alcanza la compra mínima', () => {
    const r = evaluarBonusPuntos({
      config: base,
      puntos: 100,
      montoCompra: 4999,
      minimoCompra: 5000,
      otorgadosCliente30Dias: 0,
    })
    expect(r.permitido).toBe(false)
    expect(r.motivo).toContain('compra mínima')
  })

  test('respeta el cupo por cliente de 30 días', () => {
    const r = evaluarBonusPuntos({
      config: base,
      puntos: 100,
      montoCompra: 10000,
      otorgadosCliente30Dias: 2,
    })
    expect(r.permitido).toBe(false)
    expect(r.motivo).toContain('cupo')
  })

  test('recorta el pedido del operador para no pasar el techo de margen', () => {
    const r = evaluarBonusPuntos({
      config: base,
      puntos: 900,
      montoCompra: 5000,
      otorgadosCliente30Dias: 0,
    })
    expect(r.permitido).toBe(true)
    expect(r.puntos).toBe(300)
    expect(r.recortado).toBe(true)
  })

  test('un pedido chico recibe sólo lo que entra en el techo', () => {
    const r = evaluarBonusPuntos({
      config: base,
      puntos: 100,
      montoCompra: 100,
      otorgadosCliente30Dias: 0,
    })
    expect(r.permitido).toBe(true)
    expect(r.puntos).toBe(6)
    expect(r.recortado).toBe(true)
  })
})

describe('recomendación inteligente para recompra', () => {
  test('con saldo suficiente recomienda recordar los puntos, no un descuento', () => {
    const r = recomendarPuntosParaRecompra({
      config: base,
      ticketPromedio: 10000,
      descuentoEscalon: 10,
      otorgadosCliente30Dias: 0,
      saldoPuntos: 700,
    })
    expect(r?.tipo).toBe('usar_saldo')
    if (r?.tipo === 'usar_saldo') {
      expect(r.puedeCanjear).toBe(true)
      expect(r.linea).toContain('700 puntos')
    }
  })

  test('a pocos puntos de un premio también conviene recordarlo', () => {
    const r = evaluarSaldoParaRecordatorio(base, 280)
    expect(r.convieneRecordar).toBe(true)
    expect(r.faltan).toBe(20)
  })

  test('sin saldo, el motor igual prioriza el club e invita a empezar', () => {
    const r = recomendarPuntosParaRecompra({
      config: base,
      ticketPromedio: 10000,
      descuentoEscalon: 10,
      otorgadosCliente30Dias: 0,
      saldoPuntos: 0,
    })
    expect(r?.tipo).toBe('usar_saldo')
    if (r?.tipo === 'usar_saldo') {
      expect(r.saldo).toBe(0)
      expect(r.puedeCanjear).toBe(false)
      expect(r.linea.toLocaleLowerCase()).toContain('empezá a sumar puntos')
    }
  })

  test('la sugerencia de bonus reemplaza el valor del descuento del escalón', () => {
    const s = sugerirBonusPuntos({
      config: base,
      ticketPromedio: 10000,
      descuentoEscalon: 10,
      otorgadosCliente30Dias: 0,
    })
    expect(s).not.toBeNull()
    expect(s!.valorEstimadoPesos).toBeLessThanOrEqual(1000)
    expect(s!.compraMinima).toBeGreaterThan(0)
  })

  test('el texto del bonus no promete un descuento', () => {
    const texto = lineaBonusPuntos(150, 2500)
    expect(texto).toContain('150 puntos')
    expect(texto).toContain('$')
    expect(texto.toLocaleLowerCase()).not.toContain('descuento')
  })
})
