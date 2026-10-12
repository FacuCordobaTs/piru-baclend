import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import * as jwt from 'jsonwebtoken'

// GET /clientes/list sin base: cada `select()` entrega la siguiente respuesta de
// la cola, en el orden en que el handler las pide. Si el handler cambia el orden
// de sus consultas, el test avisa.
let cola: unknown[][] = []
const consultas: string[] = []

function cadena(filas: unknown[]) {
  const q: any = new Proxy(function () {}, {
    get: (_t, prop) =>
      prop === 'then'
        ? (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve(filas).then(ok, err)
        : (...args: unknown[]) => {
            if (typeof prop === 'string') consultas.push(prop)
            void args
            return q
          },
    apply: () => q,
  })
  return q
}
const dbFalsa = { select: () => cadena(cola.shift() ?? []) }

// Los mocks de módulo valen para todo el proceso de `bun test`: se devuelven al terminar.
const RUTA_DB = resolve(import.meta.dir, '../db')
const dbReal = await import(RUTA_DB)
const drizzleReal = await import('drizzle-orm/mysql2')
mock.module(RUTA_DB, () => ({ pool: {} }))
mock.module('drizzle-orm/mysql2', () => ({ drizzle: () => dbFalsa }))
afterAll(() => {
  mock.module(RUTA_DB, () => dbReal)
  mock.module('drizzle-orm/mysql2', () => drizzleReal)
})

const { Hono } = await import('hono')
const { clientesRoute } = await import('./clientes')
const app = new Hono().route('/api/clientes', clientesRoute)

const token = jwt.sign({ id: 6, scope: 'restaurante' }, process.env.JWT_SECRET || 'fallback-secret')
const pedir = (ruta: string) =>
  app.request(`/api/clientes${ruta}`, { headers: { Authorization: `Bearer ${token}` } })

const dia = (d: number, h = 12) => new Date(Date.UTC(2026, 9, d, h))
const fila = (id: number, nombre: string, extra: Record<string, unknown> = {}) => ({
  id,
  restauranteId: 6,
  nombre,
  telefono: `54911000000${id}`,
  telefonoNormalizado: `54911000000${id}`,
  direccion: null,
  puntos: 0,
  marketingOptOut: false,
  createdAt: new Date(Date.UTC(2026, 0, id)),
  ...extra,
})
const pedido = (id: number, clienteId: number, extra: Record<string, unknown> = {}) => ({
  id,
  clienteId,
  total: '6750.00',
  sucursalId: 1,
  codigoDescuentoId: null,
  montoDescuento: null,
  marketingCampanaId: null,
  pagado: true,
  createdAt: dia(10),
  tipo: 'delivery',
  grupal: false,
  ...extra,
})
const itemDe = (pedidoId: number) => ({
  pedidoId,
  productoId: 5,
  cantidad: 1,
  precioUnitario: '6750.00',
  clienteNombre: null,
  clienteTelefono: null,
  clienteId: null,
})

/** La base de un local: Ana (2 pedidos, una campaña), Beto (1 pedido) y Caro (sin pedidos). */
function cargarBase(opciones: { toques?: unknown[]; actividad?: unknown[] } = {}) {
  cola = [
    [{ id: 6, email: null, nombre: 'Brasa', origen: null, claimedAt: null, telefonoVerificado: false, rapiboyToken: null }],
    [fila(3, 'Caro'), fila(2, 'Beto'), fila(1, 'Ana', { puntos: 100, direccion: 'Mitre 123' })],
    [
      pedido(11, 1, { createdAt: dia(9) }),
      pedido(12, 1, { createdAt: dia(10), sucursalId: 2 }),
      pedido(21, 2, { createdAt: dia(11) }),
    ],
    [itemDe(11), itemDe(12), itemDe(21)],
    [{ id: 5, nombre: 'Hamburguesa' }],
    // atribuciones, campañas, enlaces, recuperos, contactos y cupones
    [{ pedidoUnificadoId: 11, campanaId: 1, origen: 'campana', recetaCodigo: null, revenueAtribuido: '6750', createdAt: dia(9) }],
    [{ id: 1, nombre: 'Historia martes', slug: 'historia-martes' }],
    [],
    [],
    [],
    [],
    // toques de la escalera de recupero
    opciones.toques ?? [],
    // actividad de puntos (sólo en la versión paginada)
    ...(opciones.actividad ? [opciones.actividad] : []),
  ]
}

beforeEach(() => {
  cola = []
  consultas.length = 0
})

describe('GET /clientes/list', () => {
  test('sin pagina ni limite devuelve la lista completa, como siempre', async () => {
    cargarBase()
    const res = await pedir('/list?soloDespachados=true')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(Array.isArray(data)).toBe(true)
    expect(data.map((c: any) => c.nombre).sort()).toEqual(['Ana', 'Beto'])
    const ana = data.find((c: any) => c.nombre === 'Ana')
    expect(ana).toMatchObject({ cantidadPedidos: 2, totalGastado: 13500, puntos: 100 })
    expect(ana.pedidos.map((p: any) => [p.id, p.campanaId, p.esOrganico])).toEqual([
      [12, null, true],
      [11, 1, false],
    ])
    expect(ana).not.toHaveProperty('club')
    expect(ana.campanasParticipadas).toHaveLength(1)
  })

  test('con pagina devuelve una página con su resumen y la actividad de puntos', async () => {
    cargarBase({
      actividad: [
        { clienteId: 1, movimientos: '3', puntosOtorgados: '130', puntosCanjeados: '30', canjes: '1', ultimoMovimientoAt: '2026-10-10 20:00:00' },
      ],
    })
    const res = await pedir('/list?soloDespachados=true&pagina=1&limite=1&orden=gasto')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data).toMatchObject({ pagina: 1, limite: 1, total: 2, paginas: 2 })
    expect(data.items).toHaveLength(1)
    expect(data.items[0]).toMatchObject({ nombre: 'Ana', totalGastado: 13500 })
    expect(data.items[0].club).toMatchObject({
      puntosOtorgados: 130,
      puntosCanjeados: 30,
      canjes: 1,
      movimientos: 3,
    })
    // Resumen de la base entera (sin Caro, que no tiene pedidos despachados).
    expect(data.resumen).toMatchObject({ total: 2, conPuntos: 1, puntosEnCirculacion: 100 })
    expect(Object.values(data.resumen.porSegmento).reduce((a: number, b: any) => a + b, 0)).toBe(2)
  })

  test('el detalle pesado sólo se pide para la página: toques y puntos de sus clientes', async () => {
    cargarBase({ actividad: [] })
    await pedir('/list?soloDespachados=true&pagina=2&limite=1&orden=nombre')
    // Cola agotada: no hay consultas por todos los clientes.
    expect(cola).toHaveLength(0)
  })

  test('busca, filtra por segmento y por campaña y reporta el total filtrado', async () => {
    cargarBase({ actividad: [] })
    const porCampana = await (await pedir('/list?soloDespachados=true&pagina=1&campanaId=1')).json()
    expect(porCampana.data.items.map((c: any) => c.nombre)).toEqual(['Ana'])
    expect(porCampana.data.total).toBe(1)
    expect(porCampana.data.resumen.total).toBe(2)

    cargarBase({ actividad: [] })
    const porSucursal = await (await pedir('/list?soloDespachados=true&pagina=1&sucursalId=2')).json()
    expect(porSucursal.data.items.map((c: any) => c.nombre)).toEqual(['Ana'])

    cargarBase({ actividad: [] })
    const porTexto = await (await pedir('/list?soloDespachados=true&pagina=1&busqueda=mitre')).json()
    expect(porTexto.data.items.map((c: any) => c.nombre)).toEqual(['Ana'])

    cargarBase({ actividad: [] })
    const conPuntos = await (await pedir('/list?soloDespachados=true&pagina=1&conPuntos=true')).json()
    expect(conPuntos.data.items.map((c: any) => c.nombre)).toEqual(['Ana'])
  })

  test('un parámetro que no sirve se ignora en lugar de devolver un 400', async () => {
    cargarBase({ actividad: [] })
    const res = await pedir('/list?soloDespachados=true&pagina=1&limite=500&segmento=cualquiera&orden=raro&desde=ayer&sucursalId=')
    expect(res.status).toBe(200)
    const { data } = await res.json()
    // limite se acota a 100, y los filtros inválidos no filtran.
    expect(data).toMatchObject({ limite: 100, total: 2 })
  })
})
