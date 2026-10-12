import { describe, expect, test } from 'bun:test'
import * as schema from '../db/schema'
import {
  borrarDatosEjemplo,
  estadoDatosEjemplo,
  sembrarDatosEjemplo,
} from './datos-ejemplo-db'
import { esRequestIdEjemplo } from './pedido-ejemplo'

const NOMBRES = new Map<unknown, string>(
  Object.entries(schema)
    .filter(([, v]) => v && typeof v === 'object')
    .map(([k, v]) => [v, k]),
)

const AHORA = new Date('2026-10-12T15:30:00-03:00')
const AYER = new Date('2026-10-11T20:00:00-03:00')

const PROSPECTO = {
  origen: 'outbound',
  claimedAt: null,
  telefonoVerificado: false,
  deliveryFee: '1500.00',
  direccionLat: '-31.6300000',
  direccionLng: '-60.7000000',
  id: 7,
}

type Opciones = {
  local?: Record<string, unknown> | null
  previo?: Record<string, unknown> | null
  clientes?: number
  pedidos?: number
  pedidosAjenos?: { id: number }[]
  productos?: unknown[]
  sedes?: unknown[]
}

/** Una base mínima que sólo registra qué se escribe y en qué orden. */
function baseFalsa(opciones: Opciones = {}) {
  const log: { op: 'insert' | 'update' | 'delete'; tabla: string; valores?: any }[] = []
  let siguiente = 500
  const productos = opciones.productos ?? [
    { id: 11, nombre: 'Smash', precio: '9500.00' },
    { id: 12, nombre: 'Papas', precio: '6500.00' },
    { id: 13, nombre: 'Gaseosa', precio: '4000.00' },
  ]
  const responder = (tabla: string, cols: Record<string, unknown> | undefined) => {
    switch (tabla) {
      case 'restaurante':
        return opciones.local === null ? [] : [opciones.local ?? PROSPECTO]
      case 'datosEjemplo':
        return opciones.previo ? [opciones.previo] : []
      case 'cliente':
        return [{ clientes: opciones.clientes ?? 0, n: opciones.clientes ?? 0 }]
      case 'pedidoUnificado':
        return cols && ('pedidos' in cols || 'n' in cols)
          ? [{ pedidos: opciones.pedidos ?? 0, n: opciones.pedidos ?? 0 }]
          : (opciones.pedidosAjenos ?? [])
      case 'producto':
        return productos
      case 'sucursal':
        return opciones.sedes ?? []
      case 'modulo':
        return [
          { id: 1, tipo: 'incluido', activable: true },
          { id: 2, tipo: 'incluido', activable: true },
        ]
      case 'marketingSesion':
        return [{ id: 91 }, { id: 92 }]
      default:
        return []
    }
  }
  const tx: any = {
    select(cols?: Record<string, unknown>) {
      let tabla = ''
      const q: any = {
        from(t: unknown) {
          tabla = NOMBRES.get(t) ?? '?'
          return q
        },
        where: () => q,
        limit: () => q,
        orderBy: () => q,
        for: () => q,
        then: (ok: any, ko: any) => Promise.resolve(responder(tabla, cols)).then(ok, ko),
      }
      return q
    },
    insert(t: unknown) {
      return {
        values(valores: any) {
          log.push({ op: 'insert', tabla: NOMBRES.get(t) ?? '?', valores })
          const r = [{ insertId: siguiente++ }]
          const p: any = Promise.resolve(r)
          p.onDuplicateKeyUpdate = async () => r
          return p
        },
      }
    },
    update: (t: unknown) => ({
      set: (valores: any) => ({
        where: async () => void log.push({ op: 'update', tabla: NOMBRES.get(t) ?? '?', valores }),
      }),
    }),
    delete: (t: unknown) => ({
      where: async () => void log.push({ op: 'delete', tabla: NOMBRES.get(t) ?? '?' }),
    }),
    transaction: async (fn: (t: unknown) => unknown) => fn(tx),
  }
  const insertados = (tabla: string) => log.filter((l) => l.op === 'insert' && l.tabla === tabla)
  return { db: tx, log, insertados }
}

describe('sembrar los datos de ejemplo', () => {
  test('la primera vez deja clientes, pedidos, campañas y cupón, y anota qué sembró', async () => {
    const f = baseFalsa()
    const r = await sembrarDatosEjemplo(f.db, 7, { ahora: AHORA })
    expect(r).toMatchObject({ estado: 'sembrado', clientes: 16, campanas: 2 })

    expect(f.insertados('cliente')).toHaveLength(16)
    expect(f.insertados('marketingCampana')).toHaveLength(2)
    expect(f.insertados('codigoDescuento')).toHaveLength(1)
    const pedidos = f.insertados('pedidoUnificado')
    expect(pedidos.length).toBeGreaterThan(40)
    expect(r.estado === 'sembrado' && r.pedidos).toBe(pedidos.length)

    // Respeta las claves foráneas: cada cosa se inserta después de aquello a lo que apunta.
    const orden = f.log.filter((l) => l.op === 'insert').map((l) => l.tabla)
    const primero = (t: string) => orden.indexOf(t)
    const ultimo = (t: string) => orden.lastIndexOf(t)
    expect(ultimo('cliente')).toBeLessThan(primero('pedidoUnificado'))
    expect(primero('codigoDescuento')).toBeLessThan(primero('marketingCampana'))
    expect(ultimo('marketingCampana')).toBeLessThan(primero('pedidoUnificado'))
    expect(ultimo('pedidoUnificado')).toBeLessThan(primero('itemPedidoUnificado'))
    expect(orden).toContain('datosEjemplo')

    // Todos del local, ya impresos (abrir el panel con una impresora no saca comandas) y con cliente.
    const idsClientes = new Set(f.insertados('cliente').map((_, i) => 500 + i))
    for (const p of pedidos) {
      expect(p.valores.restauranteId).toBe(7)
      expect(p.valores.impreso).toBe(true)
      expect(idsClientes.has(p.valores.clienteId)).toBe(true)
      expect(p.valores.nombreCliente.endsWith('EJEMPLO')).toBe(true)
      // Marcados: el valor de la prueba, el claim y la cartera del marketer no los cuentan como reales.
      expect(esRequestIdEjemplo(p.valores.clientRequestId)).toBe(true)
    }
    expect(new Set(pedidos.map((p) => p.valores.clientRequestId)).size).toBe(pedidos.length)
    expect(f.insertados('cliente').every((c) => c.valores.nombre.endsWith('EJEMPLO'))).toBe(true)

    const registro = f.insertados('datosEjemplo')[0].valores
    expect(registro.restauranteId).toBe(7)
    expect(registro.registros.clientes).toHaveLength(16)
    expect(registro.registros.pedidos).toHaveLength(pedidos.length)
    expect(registro.registros.campanas).toHaveLength(2)
    expect(registro.registros.cupones).toHaveLength(1)
    expect(registro.borradoAt).toBeNull()

    // Los extras: visitas de las campañas y los módulos incluidos que las muestran.
    const visitas = f.insertados('marketingSesion').flatMap((s) => s.valores)
    expect(visitas).toHaveLength(132 + 46)
    expect(f.insertados('restauranteModulo')).toHaveLength(2)
    expect(f.insertados('restauranteModulo')[0].valores.origen).toBe('interno')
  })

  test('sólo siembra en un prospecto que su dueño todavía no reclamó', async () => {
    for (const local of [
      { ...PROSPECTO, claimedAt: new Date() },
      { ...PROSPECTO, telefonoVerificado: true },
      { ...PROSPECTO, origen: 'self_serve' },
    ]) {
      const f = baseFalsa({ local })
      expect(await sembrarDatosEjemplo(f.db, 7, { ahora: AHORA })).toEqual({ estado: 'no_aplica' })
      expect(f.log).toHaveLength(0)
    }
    const sinLocal = baseFalsa({ local: null })
    expect(await sembrarDatosEjemplo(sinLocal.db, 7, { ahora: AHORA })).toEqual({ estado: 'no_aplica' })
  })

  test('el mismo día no vuelve a sembrar', async () => {
    const f = baseFalsa({
      previo: {
        restauranteId: 7,
        sembradoAt: new Date(AHORA.getTime() - 3_600_000),
        borradoAt: null,
        registros: { clientes: [1], pedidos: [2], campanas: [3], cupones: [4] },
      },
    })
    expect(await sembrarDatosEjemplo(f.db, 7, { ahora: AHORA })).toEqual({ estado: 'vigente' })
    expect(f.log).toHaveLength(0)
  })

  test('si el dueño los borró, no vuelven solos', async () => {
    const f = baseFalsa({
      previo: {
        restauranteId: 7,
        sembradoAt: AYER,
        borradoAt: AYER,
        registros: { clientes: [], pedidos: [], campanas: [], cupones: [] },
      },
    })
    expect(await sembrarDatosEjemplo(f.db, 7, { ahora: AHORA })).toEqual({ estado: 'borrado' })
    expect(f.log).toHaveLength(0)
  })

  test('forzar vuelve a cargarlos aunque el dueño los haya borrado', async () => {
    const f = baseFalsa({
      previo: {
        restauranteId: 7,
        sembradoAt: AYER,
        borradoAt: AYER,
        registros: { clientes: [], pedidos: [], campanas: [], cupones: [] },
      },
    })
    const r = await sembrarDatosEjemplo(f.db, 7, { ahora: AHORA, forzar: true })
    expect(r.estado).toBe('sembrado')
    expect(f.insertados('cliente')).toHaveLength(16)
  })

  test('al día siguiente borra lo viejo y siembra de nuevo, para que "hoy" tenga pedidos de hoy', async () => {
    const f = baseFalsa({
      previo: {
        restauranteId: 7,
        sembradoAt: AYER,
        borradoAt: null,
        registros: { clientes: [1, 2], pedidos: [5, 6], campanas: [3], cupones: [4] },
      },
    })
    const r = await sembrarDatosEjemplo(f.db, 7, { ahora: AHORA })
    expect(r.estado).toBe('sembrado')
    const primerInsert = f.log.findIndex((l) => l.op === 'insert')
    const borrados = f.log.slice(0, primerInsert).filter((l) => l.op === 'delete').map((l) => l.tabla)
    expect(borrados).toEqual(expect.arrayContaining(['itemPedidoUnificado', 'pedidoUnificado', 'cliente', 'marketingCampana', 'codigoDescuento']))
  })

  test('no mezcla datos de ejemplo con un local que ya opera de verdad', async () => {
    for (const opciones of [{ clientes: 3 }, { pedidos: 4 }]) {
      const f = baseFalsa(opciones)
      expect(await sembrarDatosEjemplo(f.db, 7, { ahora: AHORA })).toEqual({ estado: 'con_datos_propios' })
      expect(f.log).toHaveLength(0)
    }
    // La prueba de la tienda deja un cliente y un pedido: eso no cuenta.
    const prueba = baseFalsa({ clientes: 1, pedidos: 1 })
    expect((await sembrarDatosEjemplo(prueba.db, 7, { ahora: AHORA })).estado).toBe('sembrado')
  })

  test('sin productos con precio no inventa pedidos', async () => {
    const f = baseFalsa({ productos: [] })
    expect(await sembrarDatosEjemplo(f.db, 7, { ahora: AHORA })).toEqual({ estado: 'sin_productos' })
    expect(f.insertados('cliente')).toHaveLength(0)
  })

  test('reparte los pedidos entre las sedes del local', async () => {
    const f = baseFalsa({ sedes: [{ id: 31, lat: null, lng: null }, { id: 32, lat: null, lng: null }] })
    await sembrarDatosEjemplo(f.db, 7, { ahora: AHORA })
    const sedes = new Set(f.insertados('pedidoUnificado').map((p) => p.valores.sucursalId))
    expect(sedes).toEqual(new Set([31, 32]))
  })
})

describe('borrar los datos de ejemplo', () => {
  const previo = {
    restauranteId: 7,
    sembradoAt: AHORA,
    borradoAt: null,
    registros: { clientes: [1, 2], pedidos: [5, 6], campanas: [3], cupones: [4] },
  }

  test('borra todo en el orden de las claves foráneas y deja constancia', async () => {
    const f = baseFalsa({ previo })
    const r = await borrarDatosEjemplo(f.db, 7, AHORA)
    expect(r).toEqual({ borrados: true })
    const borrados = f.log.filter((l) => l.op === 'delete').map((l) => l.tabla)
    const pos = (t: string) => borrados.indexOf(t)
    // Lo que apunta a un pedido, antes que el pedido; el pedido antes que su cliente y su campaña.
    expect(pos('pedidoMarketingAtribucion')).toBeLessThan(pos('pedidoUnificado'))
    expect(pos('itemPedidoUnificado')).toBeLessThan(pos('pedidoUnificado'))
    expect(pos('pedidoUnificado')).toBeLessThan(pos('cliente'))
    expect(pos('marketingSesion')).toBeLessThan(pos('marketingCampana'))
    expect(pos('marketingCampana')).toBeLessThan(pos('codigoDescuento'))
    const marca = f.log.find((l) => l.op === 'update' && l.tabla === 'datosEjemplo')!
    expect(marca.valores.borradoAt).toEqual(AHORA)
    expect(marca.valores.registros).toEqual({ clientes: [], pedidos: [], campanas: [], cupones: [] })
  })

  test('sin datos sembrados no hay nada que borrar', async () => {
    const f = baseFalsa()
    expect(await borrarDatosEjemplo(f.db, 7, AHORA)).toEqual({ borrados: false })
    expect(f.log.filter((l) => l.op === 'delete')).toHaveLength(0)
  })

  test('también se van los pedidos que el panel dejó a nombre de un cliente de ejemplo', async () => {
    const f = baseFalsa({ previo, pedidosAjenos: [{ id: 99 }] })
    await borrarDatosEjemplo(f.db, 7, AHORA)
    expect(f.log.some((l) => l.op === 'delete' && l.tabla === 'pedidoUnificado')).toBe(true)
  })
})

describe('el estado de los datos de ejemplo', () => {
  test('sin fila: no hay y no se borraron', async () => {
    expect(await estadoDatosEjemplo(baseFalsa().db, 7)).toEqual({
      hay: false,
      borrado: false,
      clientes: 0,
      pedidos: 0,
      campanas: 0,
    })
  })

  test('la cuenta sale de las filas que quedan', async () => {
    const f = baseFalsa({
      clientes: 5,
      pedidos: 9,
      previo: {
        restauranteId: 7,
        sembradoAt: AHORA,
        borradoAt: null,
        registros: { clientes: [1, 2], pedidos: [5], campanas: [], cupones: [] },
      },
    })
    expect(await estadoDatosEjemplo(f.db, 7)).toMatchObject({ hay: true, borrado: false, clientes: 5, pedidos: 9, campanas: 0 })
  })
})
