import { describe, expect, test } from 'bun:test'
import type { SegmentoCliente } from './clientes-rfm'
import {
  RECETAS_CRECIMIENTO,
  codificarCarritoReceta,
  recomendarRecetaCrecimiento,
  resolverDestinoReceta,
  resolverElegibilidadReceta,
} from './recetas-crecimiento'

const SEGMENTOS: SegmentoCliente[] = [
  'nuevo',
  'activo',
  'vip',
  'en_riesgo',
  'dormido',
  'perdido',
]

describe('recetas de Crecimiento', () => {
  test('modela exactamente una receta por cada segmento vigente', () => {
    expect(Object.keys(RECETAS_CRECIMIENTO)).toEqual(SEGMENTOS)
    expect(SEGMENTOS.map((segmento) => recomendarRecetaCrecimiento({
      segmento,
      esVip: segmento === 'vip',
    }).receta.codigo)).toEqual([
      'segunda_compra',
      'mantener_ritmo',
      'beneficio_vip',
      'volver_a_tiempo',
      'recuperar_habito',
      'ultimo_intento',
    ])
  })

  test('no sugiere descuento temprano y reserva los incentivos para dormido y perdido', () => {
    expect(SEGMENTOS.map((segmento) => ({
      segmento,
      incentivo: RECETAS_CRECIMIENTO[segmento].incentivoSugerido,
    }))).toEqual([
      { segmento: 'nuevo', incentivo: { descuentoPorcentaje: 0, expiraHoras: null } },
      { segmento: 'activo', incentivo: { descuentoPorcentaje: 0, expiraHoras: null } },
      { segmento: 'vip', incentivo: { descuentoPorcentaje: 0, expiraHoras: null } },
      { segmento: 'en_riesgo', incentivo: { descuentoPorcentaje: 0, expiraHoras: null } },
      { segmento: 'dormido', incentivo: { descuentoPorcentaje: 10, expiraHoras: null } },
      { segmento: 'perdido', incentivo: { descuentoPorcentaje: 20, expiraHoras: 48 } },
    ])
  })

  test('mantiene VIP como condición ortogonal cuando el ciclo de vida está enfriado', () => {
    const recomendacion = recomendarRecetaCrecimiento({
      segmento: 'dormido',
      esVip: true,
    })

    expect(recomendacion.receta.codigo).toBe('recuperar_habito')
    expect(recomendacion.segmento).toBe('dormido')
    expect(recomendacion.esVipEnfriado).toBe(true)
    expect(recomendacion.prioridad).toBe('alta')
    expect(recomendacion.tituloOportunidad).toBe('VIP recuperá el hábito')
  })

  test('resuelve el destino con fallback carrito, favorito y tienda', () => {
    expect(resolverDestinoReceta({
      ultimoCarrito: [{ productoId: 12, cantidad: 2 }, { productoId: 15, cantidad: 1 }],
      productoFavorito: { productoId: 99, nombre: 'Empanada' },
    })).toEqual({ tipo: 'carrito', carritoRep: '12x2-15x1' })

    expect(resolverDestinoReceta({
      ultimoCarrito: [{ productoId: 0, cantidad: 2 }],
      productoFavorito: { productoId: 99, nombre: ' Empanada ' },
    })).toEqual({ tipo: 'producto', productoId: 99, nombreProducto: 'Empanada' })

    expect(resolverDestinoReceta({})).toEqual({ tipo: 'tienda' })
  })

  test('permite editar o quitar el incentivo sugerido sin mutar la receta', () => {
    const editada = recomendarRecetaCrecimiento({
      segmento: 'dormido',
      esVip: false,
      incentivo: { descuentoPorcentaje: 15, expiraHoras: 72 },
    })
    const sinDescuento = recomendarRecetaCrecimiento({
      segmento: 'perdido',
      esVip: false,
      incentivo: { descuentoPorcentaje: 0, expiraHoras: null },
    })

    expect(editada.incentivoSeleccionado).toEqual({ descuentoPorcentaje: 15, expiraHoras: 72 })
    expect(editada.incentivoFueEditado).toBe(true)
    expect(editada.textoSugerido).toContain('15%')
    expect(sinDescuento.incentivoSeleccionado.descuentoPorcentaje).toBe(0)
    expect(sinDescuento.textoSugerido).not.toContain('20%')
    expect(RECETAS_CRECIMIENTO.dormido.incentivoSugerido).toEqual({
      descuentoPorcentaje: 10,
      expiraHoras: null,
    })
  })

  test('rechaza incentivos inválidos antes de preparar una recomendación', () => {
    expect(() => recomendarRecetaCrecimiento({
      segmento: 'dormido',
      esVip: false,
      incentivo: { descuentoPorcentaje: 101, expiraHoras: null },
    })).toThrow(RangeError)
    expect(() => recomendarRecetaCrecimiento({
      segmento: 'dormido',
      esVip: false,
      incentivo: { descuentoPorcentaje: 10, expiraHoras: 0 },
    })).toThrow(RangeError)
  })

  test('evalúa opt-out, cooldown y presión sin depender del transporte', () => {
    expect(resolverElegibilidadReceta({})).toEqual({ elegible: true, bloqueos: [] })
    expect(resolverElegibilidadReceta({
      marketingOptOut: true,
      enCooldown: true,
      presionMarketingAlcanzada: true,
    })).toMatchObject({
      elegible: false,
      bloqueos: [
        { motivo: 'opt_out' },
        { motivo: 'cooldown' },
        { motivo: 'presion_marketing' },
      ],
    })
  })

  test('es determinista, no muta inputs y sólo produce datos', () => {
    const carrito = [{ productoId: 12, cantidad: 2 }, { productoId: -1, cantidad: 1 }]
    const snapshot = structuredClone(carrito)
    const primera = recomendarRecetaCrecimiento({
      segmento: 'nuevo',
      esVip: false,
      ultimoCarrito: carrito,
    })
    const segunda = recomendarRecetaCrecimiento({
      segmento: 'nuevo',
      esVip: false,
      ultimoCarrito: carrito,
    })

    expect(codificarCarritoReceta(carrito)).toBe('12x2')
    expect(carrito).toEqual(snapshot)
    expect(primera).toEqual(segunda)
    expect(primera.textoSugerido).toEndWith('{{enlace}}')
  })
})
