import { describe, expect, test } from 'bun:test'
import {
  filtrarClientesListado,
  filtraPorPedidos,
  paginarListado,
  repartirPedidosPorCliente,
  resumirClientesListado,
  SEGMENTOS_LISTADO,
  type ClienteListable,
  type PedidoReparto,
} from './clientes-listado'
import { deduplicarPedidosHistorial } from './clientes-historial'
import { normalizarTelefonoCliente } from './clientes-identidad'

// ─── Reparto de pedidos ──────────────────────────────────────────────────────

type Pedido = PedidoReparto & { sucursalId?: number | null }
interface ClienteFila {
  id: number
  telefono: string | null
  telefonoNormalizado: string | null
}

const item = (extra: Partial<Pedido['items'][number]> = {}) => ({
  clienteId: null,
  clienteTelefono: null,
  cantidad: 1,
  precioUnitario: '1000.00',
  nombreProducto: 'Pizza',
  ...extra,
})
const pedido = (id: number, extra: Partial<Pedido> = {}): Pedido => ({
  id,
  clienteId: null,
  grupal: false,
  tipo: 'delivery',
  total: '1000.00',
  createdAt: new Date(Date.UTC(2026, 9, 1, 12, id)),
  items: [item()],
  ...extra,
})

/**
 * Lo que hacía `GET /clientes/list` antes de indexar: por cada cliente, recorrer
 * todos los pedidos. Es el oráculo de `repartirPedidosPorCliente`.
 */
function repartoAnterior(cliente: ClienteFila, todos: Pedido[]) {
  const telNorm =
    cliente.telefonoNormalizado ||
    (cliente.telefono ? normalizarTelefonoCliente(cliente.telefono) : null)
  const matched: Pedido[] = []
  for (const p of todos) {
    if (p.grupal) {
      const propios = p.items.filter((it) => {
        if (it.clienteId && it.clienteId === cliente.id) return true
        if (it.clienteTelefono && telNorm && normalizarTelefonoCliente(it.clienteTelefono) === telNorm) return true
        return false
      })
      if (propios.length > 0) {
        const total = propios.reduce((s, it) => s + parseFloat(it.precioUnitario || '0') * it.cantidad, 0)
        matched.push({ ...p, items: propios, total: total.toFixed(2) })
      }
    } else if (p.clienteId === cliente.id) {
      matched.push(p)
    }
  }
  return deduplicarPedidosHistorial(matched)
}

describe('reparto de pedidos por cliente', () => {
  const clientes: ClienteFila[] = [
    { id: 1, telefono: '+54 9 11 1111-1111', telefonoNormalizado: '5491111111111' },
    { id: 2, telefono: '5491122222222', telefonoNormalizado: null },
    { id: 3, telefono: null, telefonoNormalizado: null },
  ]

  test('un pedido individual es del cliente que lo hizo', () => {
    const r = repartirPedidosPorCliente(clientes, [
      pedido(1, { clienteId: 1 }),
      pedido(2, { clienteId: 2, createdAt: new Date(Date.UTC(2026, 9, 2)) }),
      pedido(3, { clienteId: 99 }),
      pedido(4, { clienteId: null }),
    ])
    expect(r.get(1)?.map((p) => p.id)).toEqual([1])
    expect(r.get(2)?.map((p) => p.id)).toEqual([2])
    expect(r.has(3)).toBe(false)
  })

  test('un pedido grupal se reparte por ítem, por id o por celular, con su parte del total', () => {
    const grupal = pedido(10, {
      grupal: true,
      total: '5000.00',
      items: [
        item({ clienteId: 1, precioUnitario: '1000.00', cantidad: 2 }),
        item({ clienteTelefono: '11 2222-2222', precioUnitario: '1500.00' }),
        item({ clienteTelefono: '+54 9 11 2222 2222', precioUnitario: '500.00' }),
        item({ clienteTelefono: '123', precioUnitario: '700.00' }),
        item({ precioUnitario: '300.00' }),
      ],
    })
    const r = repartirPedidosPorCliente(clientes, [grupal])
    expect(r.get(1)).toHaveLength(1)
    expect(r.get(1)![0].total).toBe('2000.00')
    expect(r.get(1)![0].items).toHaveLength(1)
    // «11 2222-2222» no normaliza al mismo número que el guardado con 54 9: no es de él.
    expect(r.get(2)![0].total).toBe('500.00')
    expect(r.has(3)).toBe(false)
  })

  test('colapsa el reintento idéntico del checkout y deja el más nuevo', () => {
    const r = repartirPedidosPorCliente(clientes, [
      pedido(1, { clienteId: 1, createdAt: new Date(Date.UTC(2026, 9, 1, 12, 0)) }),
      pedido(2, { clienteId: 1, createdAt: new Date(Date.UTC(2026, 9, 1, 12, 10)) }),
      pedido(3, { clienteId: 1, createdAt: new Date(Date.UTC(2026, 9, 1, 14, 0)) }),
    ])
    expect(r.get(1)?.map((p) => p.id)).toEqual([3, 2])
  })

  test('da lo mismo que recorrer todos los pedidos por cada cliente (datos mezclados)', () => {
    let semilla = 7
    const azar = () => {
      semilla = (semilla * 1103515245 + 12345) & 0x7fffffff
      return semilla / 0x7fffffff
    }
    const telefonos = ['5491100000001', '5491100000002', '5491100000003', '5491100000004']
    const clientesAzar: ClienteFila[] = telefonos.map((t, i) => ({
      id: i + 1,
      telefono: i % 2 ? `+${t.slice(0, 2)} ${t.slice(2)}` : t,
      telefonoNormalizado: i === 3 ? null : t,
    }))
    const pedidos: Pedido[] = []
    for (let id = 1; id <= 80; id++) {
      const grupal = azar() < 0.35
      const carrito = Math.floor(azar() * 3)
      pedidos.push(
        pedido(id, {
          grupal,
          clienteId: azar() < 0.8 ? Math.ceil(azar() * 4) : null,
          total: `${(carrito + 1) * 1000}.00`,
          createdAt: new Date(Date.UTC(2026, 9, 1 + Math.floor(azar() * 5), 12, Math.floor(azar() * 90))),
          items: Array.from({ length: 1 + Math.floor(azar() * 3) }, () => {
            const quien = Math.floor(azar() * 6)
            return item({
              nombreProducto: `P${carrito}`,
              precioUnitario: `${(carrito + 1) * 1000}.00`,
              cantidad: 1 + Math.floor(azar() * 2),
              clienteId: quien < 2 ? quien + 1 : null,
              clienteTelefono:
                quien === 2 ? '+54 9 11 0000-0003' : quien === 3 ? '5491100000004' : quien === 4 ? '12' : null,
            })
          }),
        }),
      )
    }
    const indexado = repartirPedidosPorCliente(clientesAzar, pedidos)
    for (const cliente of clientesAzar) {
      expect(indexado.get(cliente.id) ?? []).toEqual(repartoAnterior(cliente, pedidos))
    }
  })
})

// ─── Filtros, orden y paginación ─────────────────────────────────────────────

// Los pedidos de la base llevan la hora del local etiquetada UTC (db.ts): el día
// de Argentina es el día UTC del Date.
const pedidoF = (createdAt: string, extra: Record<string, unknown> = {}) => ({ createdAt, ...extra })
const cliente = (id: number, nombre: string, extra: Partial<ClienteListable> = {}): ClienteListable => ({
  id,
  nombre,
  telefono: `54911000000${id}`,
  direccion: null,
  puntos: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  cantidadPedidos: 0,
  totalGastado: 0,
  ultimoPedidoAt: null,
  segmento: 'nuevo',
  campanasParticipadas: [],
  cuponesUsados: [],
  pedidos: [],
  ...extra,
})

const ana = cliente(1, 'Ana', {
  direccion: 'Mitre 123',
  puntos: 100,
  cantidadPedidos: 2,
  totalGastado: 13500,
  ultimoPedidoAt: '2026-10-10T20:00:00.000Z',
  segmento: 'activo',
  campanasParticipadas: [{ nombre: 'Historia martes' }],
  pedidos: [
    pedidoF('2026-10-10T20:00:00.000Z', { sucursalId: 1, esOrganico: true }),
    pedidoF('2026-09-01T15:00:00.000Z', { sucursalId: 1, campanaId: 9 }),
  ],
})
const beto = cliente(2, 'Beto', {
  puntos: 0,
  cantidadPedidos: 1,
  totalGastado: 6750,
  ultimoPedidoAt: '2026-10-11T20:00:00.000Z',
  segmento: 'vip',
  cuponesUsados: [{ codigo: 'PRIMAVERA' }],
  pedidos: [
    // 00:30 del 3 de octubre en el local: el día es el 3, no el 2.
    pedidoF('2026-10-03T00:30:00.000Z', { sucursalId: 2, esOrganico: true, codigoDescuentoId: 7 }),
  ],
})
const caro = cliente(3, 'Caro', { puntos: 40, segmento: 'nuevo' })
const jose = cliente(4, 'José Pérez', {
  telefono: '5491155556666',
  puntos: 40,
  cantidadPedidos: 3,
  totalGastado: 13500,
  ultimoPedidoAt: '2026-10-10T20:00:00.000Z',
  segmento: 'en_riesgo',
})
const todos = [caro, ana, beto, jose]
const nombres = (lista: ClienteListable[]) => lista.map((c) => c.nombre)

describe('filtros del listado de clientes', () => {
  test('sin filtros, el orden histórico es el de alta, del más nuevo al más viejo', () => {
    const a = cliente(1, 'Uno', { createdAt: '2026-03-01T00:00:00.000Z' })
    const b = cliente(2, 'Dos', { createdAt: '2026-05-01T00:00:00.000Z' })
    expect(nombres(filtrarClientesListado([a, b], {}))).toEqual(['Dos', 'Uno'])
  })

  test('la búsqueda mira nombre, celular, dirección, campañas y cupones, sin tildes ni mayúsculas', () => {
    const buscar = (q: string) => nombres(filtrarClientesListado(todos, { busqueda: q }))
    expect(buscar('mitre')).toEqual(['Ana'])
    expect(buscar('HISTORIA')).toEqual(['Ana'])
    expect(buscar('primavera')).toEqual(['Beto'])
    expect(buscar('jose')).toEqual(['José Pérez'])
    expect(buscar('perez')).toEqual(['José Pérez'])
    expect(buscar('  ')).toHaveLength(4)
  })

  test('el celular se encuentra aunque se escriba con espacios o guiones', () => {
    expect(nombres(filtrarClientesListado(todos, { busqueda: '11 5555-6666' }))).toEqual(['José Pérez'])
    expect(nombres(filtrarClientesListado(todos, { busqueda: '5491155556666' }))).toEqual(['José Pérez'])
  })

  test('segmento y con puntos', () => {
    expect(nombres(filtrarClientesListado(todos, { segmento: 'vip' }))).toEqual(['Beto'])
    expect(nombres(filtrarClientesListado(todos, { conPuntos: true, orden: 'nombre' }))).toEqual([
      'Ana',
      'Caro',
      'José Pérez',
    ])
    expect(nombres(filtrarClientesListado(todos, { conPuntos: true, segmento: 'nuevo' }))).toEqual(['Caro'])
  })

  test('el período cuenta días del local y deja afuera a quien no pidió', () => {
    const f = { desde: '2026-10-03', hasta: '2026-10-03' }
    expect(nombres(filtrarClientesListado(todos, f))).toEqual(['Beto'])
    expect(nombres(filtrarClientesListado(todos, { desde: '2026-10-04' }))).toEqual(['Ana'])
    expect(nombres(filtrarClientesListado(todos, { hasta: '2026-09-30' }))).toEqual(['Ana'])
  })

  test('sucursal, campaña, orgánico y cupón miran los pedidos de la ventana', () => {
    expect(nombres(filtrarClientesListado(todos, { sucursalId: 1 }))).toEqual(['Ana'])
    expect(nombres(filtrarClientesListado(todos, { campana: 9 }))).toEqual(['Ana'])
    expect(nombres(filtrarClientesListado(todos, { campana: 'organico', orden: 'nombre' }))).toEqual([
      'Ana',
      'Beto',
    ])
    expect(nombres(filtrarClientesListado(todos, { cuponId: 7 }))).toEqual(['Beto'])
    // La campaña es de septiembre: en la ventana de octubre, Ana ya no cuenta.
    expect(nombres(filtrarClientesListado(todos, { campana: 9, desde: '2026-10-01' }))).toEqual([])
    expect(nombres(filtrarClientesListado(todos, { cuponId: 7, desde: '2026-10-04' }))).toEqual([])
  })

  test('qué filtros obligan a mirar los pedidos', () => {
    expect(filtraPorPedidos({})).toBe(false)
    expect(filtraPorPedidos({ busqueda: 'x', segmento: 'vip', conPuntos: true, orden: 'gasto' })).toBe(false)
    expect(filtraPorPedidos({ desde: '2026-10-01' })).toBe(true)
    expect(filtraPorPedidos({ sucursalId: 2 })).toBe(true)
    expect(filtraPorPedidos({ campana: 'organico' })).toBe(true)
    expect(filtraPorPedidos({ cuponId: 1 })).toBe(true)
  })

  test('ordena por pedidos, gasto, puntos, nombre y últimos pedidos, con desempate estable', () => {
    const orden = (o: any) => nombres(filtrarClientesListado(todos, { orden: o }))
    // Ana y José empatan en gasto y en último pedido: manda el id más alto primero.
    expect(orden('gasto')).toEqual(['José Pérez', 'Ana', 'Beto', 'Caro'])
    expect(orden('pedidos')).toEqual(['José Pérez', 'Ana', 'Beto', 'Caro'])
    expect(orden('puntos')).toEqual(['Ana', 'José Pérez', 'Caro', 'Beto'])
    expect(orden('nombre')).toEqual(['Ana', 'Beto', 'Caro', 'José Pérez'])
    expect(orden('recientes')).toEqual(['Beto', 'José Pérez', 'Ana', 'Caro'])
  })

  test('no modifica la lista de entrada', () => {
    const copia = [...todos]
    filtrarClientesListado(todos, { orden: 'nombre' })
    expect(todos).toEqual(copia)
  })
})

describe('resumen y paginación', () => {
  test('resume la base entera con todos los segmentos', () => {
    const r = resumirClientesListado(todos)
    expect(r).toEqual({
      total: 4,
      conPuntos: 3,
      puntosEnCirculacion: 180,
      porSegmento: { nuevo: 1, activo: 1, vip: 1, en_riesgo: 1, dormido: 0, perdido: 0 },
    })
    expect(Object.keys(r.porSegmento)).toEqual([...SEGMENTOS_LISTADO])
  })

  test('corta la página y devuelve los totales reales', () => {
    const lista = Array.from({ length: 53 }, (_, i) => i + 1)
    const p2 = paginarListado(lista, 2, 25)
    expect(p2.items).toEqual(lista.slice(25, 50))
    expect(p2).toMatchObject({ pagina: 2, limite: 25, total: 53, paginas: 3 })
    expect(paginarListado(lista, 3, 25).items).toEqual([51, 52, 53])
  })

  test('una página fuera de rango queda vacía sin perder los totales', () => {
    const p = paginarListado([1, 2, 3], 9, 2)
    expect(p).toEqual({ items: [], pagina: 9, limite: 2, total: 3, paginas: 2 })
  })

  test('acota el tamaño y tolera valores raros', () => {
    expect(paginarListado([1], undefined, undefined)).toMatchObject({ pagina: 1, limite: 25 })
    expect(paginarListado([1], 0, 500)).toMatchObject({ pagina: 1, limite: 100 })
    expect(paginarListado([1], -4, 0)).toMatchObject({ pagina: 1, limite: 25 })
    expect(paginarListado([], 1, 10)).toEqual({ items: [], pagina: 1, limite: 10, total: 0, paginas: 0 })
  })

  test('recorrer todas las páginas devuelve a cada cliente una sola vez, aun con empates', () => {
    const base = Array.from({ length: 40 }, (_, i) =>
      cliente(i + 1, `C${i}`, {
        totalGastado: 1000 * (i % 3),
        cantidadPedidos: 1 + (i % 2),
        puntos: i % 4,
        ultimoPedidoAt: i % 5 ? '2026-10-01T00:00:00.000Z' : null,
      }),
    )
    for (const orden of ['recientes', 'pedidos', 'gasto', 'nombre', 'puntos', 'alta'] as const) {
      const ordenada = filtrarClientesListado(base, { orden })
      const vistos: number[] = []
      for (let pagina = 1; pagina <= 4; pagina++) {
        vistos.push(...paginarListado(ordenada, pagina, 10).items.map((c) => c.id))
      }
      expect([...vistos].sort((a, b) => a - b)).toEqual(base.map((c) => c.id))
    }
  })
})
