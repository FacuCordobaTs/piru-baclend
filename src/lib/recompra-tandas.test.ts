import { describe, expect, test } from 'bun:test'
import {
  asignarBeneficios,
  carritoRep,
  componerTextos,
  elegibles,
  planificarTanda,
  preparar,
  type ClienteTanda,
  type LocalTanda,
  type ProductoTanda,
} from './recompra-tandas'
import type { ConfigIncentivosPuntos } from './puntos-incentivos'

const DIA = 24 * 60 * 60 * 1000
// Un viernes al mediodía en Argentina.
const AHORA = Date.parse('2026-11-20T15:00:00Z')

const productos = new Map<number, ProductoTanda>([
  [1, { id: 1, nombre: 'Smash burger', precio: 12000, imagenUrl: 'https://img/smash.jpg', puntosGanados: 0, tieneVariantes: false, activo: true }],
  [2, { id: 2, nombre: 'Papas cheddar', precio: 6000, imagenUrl: null, puntosGanados: 30, tieneVariantes: false, activo: true }],
  [3, { id: 3, nombre: 'Doble bacon', precio: 15000, imagenUrl: 'https://img/bacon.jpg', puntosGanados: 0, tieneVariantes: false, activo: true }],
])
const populares = [productos.get(3)!, productos.get(1)!]

const local: LocalTanda = { nombre: 'Brasa', deliveryEnabled: true, deliveryFee: 2500, puntos: null }

function cliente(id: number, diasEntrePedidos: number[], total = 20000, extra: Partial<ClienteTanda> = {}): ClienteTanda {
  let fecha = AHORA
  const pedidos = diasEntrePedidos.map((d) => {
    fecha -= d * DIA
    return { fecha, total, delivery: true, items: [{ productoId: 1, cantidad: 1 }, { productoId: 2, cantidad: 1 }] }
  })
  return { id, nombre: `cliente ${id}`, telefono: `54934100000${id}`, optOut: false, puntos: 0, pedidos, ultimoContacto: null, ...extra }
}

const base = [
  cliente(1, [10, 9, 9, 10, 9, 9, 9], 30000), // vip a tiempo
  cliente(2, [30, 10, 10, 10], 25000),        // en riesgo / dormido
  cliente(3, [90, 10, 10], 40000),            // perdido, ticket alto
  cliente(4, [8]),                            // nuevo, segunda compra
  cliente(5, [1, 10, 10]),                    // pidió ayer: no
  cliente(6, [30, 10, 10], 20000, { optOut: true }),
  cliente(7, [30, 10, 10], 20000, { ultimoContacto: AHORA - 2 * DIA }),
  cliente(8, [30, 10, 10], 20000, { telefono: null }),
]

describe('tandas de recompra', () => {
  test('sólo elige clientes contactables y en su momento', () => {
    const e = elegibles(base, productos, populares, AHORA)
    const ids = e.perfiles.map((p) => p.cliente.id)
    expect(ids).toEqual(expect.arrayContaining([1, 2, 3, 4]))
    expect(ids).not.toContain(5)
    expect(ids).not.toContain(6)
    expect(ids).not.toContain(7)
    expect(ids).not.toContain(8)
    const prep = preparar(e)
    expect(prep.recomendado).toBeGreaterThan(0)
    expect(prep.recomendado).toBeLessThanOrEqual(prep.maximo)
  })

  test('sin presupuesto ningún mensaje lleva beneficio', () => {
    const e = elegibles(base, productos, populares, AHORA)
    const plan = planificarTanda({ elegibles: e.perfiles, cantidad: 4, presupuesto: 0, local, productos, semilla: 1, ahora: AHORA })
    expect(plan.every((m) => m.beneficio.tipo === 'ninguno')).toBe(true)
  })

  test('el presupuesto no se reparte parejo ni se va en un solo cliente, y nunca se pasa', () => {
    const e = elegibles(base, productos, populares, AHORA)
    const perfiles = e.perfiles.slice(0, 4)
    const presupuesto = 12000
    const asign = asignarBeneficios(perfiles, local, presupuesto)
    const costos = asign.map((a) => a.beneficio.costo)
    const total = costos.reduce((s, c) => s + c, 0)
    expect(total).toBeLessThanOrEqual(presupuesto)
    expect(Math.max(...costos)).toBeLessThan(presupuesto)
    expect(new Set(costos).size).toBeGreaterThan(1)
    // El VIP que pide seguido vuelve solo; el perdido de ticket alto es el que más recibe.
    const vip = asign[perfiles.findIndex((p) => p.cliente.id === 1)]
    const perdido = asign[perfiles.findIndex((p) => p.cliente.id === 3)]
    expect(vip.beneficio.costo).toBeLessThan(perdido.beneficio.costo)
  })

  test('con el club activo los beneficios son puntos y respetan el techo', () => {
    const puntos: ConfigIncentivosPuntos = {
      activo: true, pesosPorPunto: 100, puntosMinimosCanje: 0, permiteCanjeEnvioGratis: true, puntosEnvioGratis: 300,
      permiteCanjeDescuento: true, descuentoTipo: 'fijo', descuentoValor: 3000, descuentoPuntosCosto: 300,
      puntosBonusMaximo: 500, puntosBonusTopePorcentaje: 12, puntosBonusPorCliente30Dias: 2,
    }
    const e = elegibles(base, productos, populares, AHORA)
    const plan = planificarTanda({ elegibles: e.perfiles, cantidad: 4, presupuesto: 20000, local: { ...local, puntos }, productos, semilla: 3, ahora: AHORA })
    expect(plan.every((m) => m.beneficio.tipo === 'ninguno' || m.beneficio.tipo === 'puntos')).toBe(true)
    for (const m of plan) if (m.beneficio.tipo === 'puntos') expect(m.beneficio.puntos).toBeLessThanOrEqual(500)
    const sinBonus = planificarTanda({ elegibles: e.perfiles, cantidad: 4, presupuesto: 0, local: { ...local, puntos }, productos, semilla: 3, ahora: AHORA })
    expect(sinBonus.some((m) => m.linea?.includes('puntos'))).toBe(true)
  })

  test('cada cliente recibe un mensaje distinto, con motivos y una sola línea para la plantilla', () => {
    const muchos = Array.from({ length: 12 }, (_, i) => cliente(100 + i, [20 + i, 9 + (i % 4), 10, 11], 18000 + i * 1000))
    const e = elegibles(muchos, productos, populares, AHORA)
    const plan = planificarTanda({ elegibles: e.perfiles, cantidad: 12, presupuesto: 30000, local, productos, semilla: 9, ahora: AHORA })
    const textos = plan.map((m) => componerTextos(m, 'https://brasa.com/r/abc'))
    expect(new Set(textos.map((t) => t.texto)).size).toBe(plan.length)
    for (const t of textos) {
      expect(t.texto).toContain('https://brasa.com/r/abc')
      expect(t.textoPlantilla).not.toMatch(/\n/)
      expect(t.textoPlantilla).not.toContain('https://')
    }
    for (const m of plan) expect(m.motivos.length).toBeGreaterThanOrEqual(3)
  })

  test('el carrito del link usa el formato durable v2', () => {
    expect(carritoRep([{ productoId: 4, cantidad: 2, varianteId: 9, agregadoIds: [3, 3] }])).toBe('v2:[{"p":4,"q":2,"v":9,"a":[3]}]')
    expect(carritoRep([])).toBeNull()
  })
})
