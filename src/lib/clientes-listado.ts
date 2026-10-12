// src/lib/clientes-listado.ts
//
// Listado paginado de Clientes: `GET /clientes/list?pagina=&limite=…`.
//
// El segmento RFM de cada cliente depende de TODA la base del local (cadencia
// global y umbral VIP, ver clientes-rfm.ts), así que el servidor sigue calculando
// el perfil de todos; lo que cambia es que filtra, ordena y corta acá, y sólo
// arma el detalle pesado (pedidos con sus ítems, favoritos, estado de recupero,
// actividad de puntos) de la página que se va a mostrar. Este módulo es puro:
// no toca la base, así que se prueba con datos en memoria.

import { deduplicarPedidosHistorial } from './clientes-historial'
import { normalizarTelefonoCliente } from './clientes-identidad'

export const SEGMENTOS_LISTADO = ['nuevo', 'activo', 'vip', 'en_riesgo', 'dormido', 'perdido'] as const
export type SegmentoListado = (typeof SEGMENTOS_LISTADO)[number]

/**
 * `alta` es el orden histórico del endpoint (clientes más nuevos primero) y se
 * conserva como valor por omisión para quien no pide otro.
 */
export const ORDENES_LISTADO = ['recientes', 'pedidos', 'gasto', 'nombre', 'puntos', 'alta'] as const
export type OrdenListado = (typeof ORDENES_LISTADO)[number]

export const LIMITE_LISTADO_DEFAULT = 25
export const LIMITE_LISTADO_MAX = 100

// ─── Reparto de pedidos por cliente ──────────────────────────────────────────

interface ItemReparto {
  clienteId: number | null
  clienteTelefono: string | null
  cantidad: number
  precioUnitario: string
  nombreProducto: string
}

export interface PedidoReparto {
  id: number
  clienteId: number | null
  grupal: boolean
  tipo: string
  total: string
  createdAt: Date | string
  items: ItemReparto[]
}

export interface ClienteReparto {
  id: number
  telefono: string | null
  telefonoNormalizado: string | null
}

/**
 * Qué pedidos son de cada cliente, en una sola pasada.
 *
 * Un pedido individual es del cliente que lo hizo. Uno grupal (sala) se reparte
 * por ítem: cada ítem es de quien lo pidió, por `clienteId` o por celular
 * normalizado, y el cliente ve sólo sus ítems y su parte del total. Es la misma
 * regla que antes se resolvía recorriendo todos los pedidos por cada cliente
 * (cuadrático); acá se indexa una vez por id y por celular.
 *
 * Cada lista sale depurada de reintentos del checkout (`deduplicarPedidosHistorial`),
 * del más nuevo al más viejo.
 */
export function repartirPedidosPorCliente<P extends PedidoReparto>(
  clientes: ClienteReparto[],
  pedidos: P[],
): Map<number, P[]> {
  const ids = new Set(clientes.map((c) => c.id))
  const porTelefono = new Map<string, number[]>()
  for (const cliente of clientes) {
    const telefono =
      cliente.telefonoNormalizado ||
      (cliente.telefono ? normalizarTelefonoCliente(cliente.telefono) : null)
    if (!telefono) continue
    const lista = porTelefono.get(telefono)
    if (lista) lista.push(cliente.id)
    else porTelefono.set(telefono, [cliente.id])
  }

  const acumulado = new Map<number, P[]>()
  const sumar = (clienteId: number, pedido: P) => {
    const lista = acumulado.get(clienteId)
    if (lista) lista.push(pedido)
    else acumulado.set(clienteId, [pedido])
  }

  for (const pedido of pedidos) {
    if (!pedido.grupal) {
      if (pedido.clienteId != null && ids.has(pedido.clienteId)) sumar(pedido.clienteId, pedido)
      continue
    }
    const itemsPorCliente = new Map<number, ItemReparto[]>()
    for (const item of pedido.items) {
      const destinos = new Set<number>()
      if (item.clienteId && ids.has(item.clienteId)) destinos.add(item.clienteId)
      if (item.clienteTelefono) {
        const telefono = normalizarTelefonoCliente(item.clienteTelefono)
        if (telefono) for (const id of porTelefono.get(telefono) ?? []) destinos.add(id)
      }
      for (const id of destinos) {
        const lista = itemsPorCliente.get(id)
        if (lista) lista.push(item)
        else itemsPorCliente.set(id, [item])
      }
    }
    for (const [clienteId, items] of itemsPorCliente) {
      const total = items.reduce(
        (suma, item) => suma + parseFloat(item.precioUnitario || '0') * item.cantidad,
        0,
      )
      sumar(clienteId, { ...pedido, items: items as P['items'], total: total.toFixed(2) })
    }
  }

  const depurado = new Map<number, P[]>()
  for (const [clienteId, lista] of acumulado) depurado.set(clienteId, deduplicarPedidosHistorial(lista))
  return depurado
}

// ─── Filtros, orden y paginación ─────────────────────────────────────────────

export interface PedidoFiltrable {
  createdAt: Date | string
  sucursalId?: number | null
  esOrganico?: boolean
  campanaId?: number | null
  codigoDescuentoId?: number | null
}

export interface ClienteListable {
  id: number
  nombre: string
  telefono: string | null
  direccion: string | null
  puntos: number | null
  createdAt: Date | string | null
  cantidadPedidos: number
  totalGastado: number
  ultimoPedidoAt: string | null
  segmento: SegmentoListado
  campanasParticipadas: { nombre: string }[]
  cuponesUsados: { codigo: string }[]
  /** Sólo hace falta (y sólo se arma) cuando hay un filtro por pedidos activo. */
  pedidos: PedidoFiltrable[]
}

export interface FiltrosListado {
  busqueda?: string | null
  segmento?: SegmentoListado | null
  /** Sólo clientes con puntos a favor. */
  conPuntos?: boolean
  /** Días de Argentina (`YYYY-MM-DD`); vacío = sin límite. */
  desde?: string | null
  hasta?: string | null
  sucursalId?: number | null
  /** Una campaña puntual, `organico` (pedidos sin campaña) o ninguna. */
  campana?: number | 'organico' | null
  cuponId?: number | null
  orden?: OrdenListado | null
}

/** Minúsculas y sin tildes: «jose» encuentra a «José». */
const plegar = (texto: string) =>
  texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const soloDigitos = (texto: string) => texto.replace(/\D/g, '')

/**
 * Los timestamps llegan de la base como hora del local etiquetada UTC (ver
 * db.ts): el día de Argentina de un pedido es, entonces, el día UTC del Date.
 */
export function diaDelPedido(createdAt: Date | string): string | null {
  const fecha = createdAt instanceof Date ? createdAt : new Date(createdAt)
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString().slice(0, 10)
}

function coincideBusqueda(cliente: ClienteListable, q: string, qDigitos: string): boolean {
  const texto = plegar(
    [
      cliente.nombre,
      cliente.telefono ?? '',
      cliente.direccion ?? '',
      ...cliente.campanasParticipadas.map((campana) => campana.nombre),
      ...cliente.cuponesUsados.map((cupon) => cupon.codigo),
    ].join(' '),
  )
  if (texto.includes(q)) return true
  // «11 2345-6789» también encuentra al celular guardado como 5491123456789.
  return qDigitos.length >= 3 && soloDigitos(cliente.telefono ?? '').includes(qDigitos)
}

function cumplePedidos(cliente: ClienteListable, f: FiltrosListado): boolean {
  const desde = f.desde || null
  const hasta = f.hasta || null
  const enVentana = cliente.pedidos.filter((pedido) => {
    const dia = diaDelPedido(pedido.createdAt)
    if (dia === null) return false
    return (
      (desde === null || dia >= desde) &&
      (hasta === null || dia <= hasta) &&
      (f.sucursalId == null || pedido.sucursalId === f.sucursalId)
    )
  })
  if (!enVentana.length) return false
  if (f.campana === 'organico' && !enVentana.some((pedido) => pedido.esOrganico)) return false
  if (typeof f.campana === 'number' && !enVentana.some((pedido) => pedido.campanaId === f.campana)) {
    return false
  }
  if (f.cuponId != null && !enVentana.some((pedido) => pedido.codigoDescuentoId === f.cuponId)) {
    return false
  }
  return true
}

/** ¿Algún filtro mira los pedidos del cliente? Si no, no hace falta armarlos. */
export function filtraPorPedidos(f: FiltrosListado): boolean {
  return Boolean(
    f.desde || f.hasta || f.sucursalId != null || f.campana != null || f.cuponId != null,
  )
}

const ms = (valor: Date | string | null | undefined) => {
  if (!valor) return 0
  const t = valor instanceof Date ? valor.getTime() : Date.parse(valor)
  return Number.isFinite(t) ? t : 0
}

/**
 * El orden es total: el desempate por id evita que un cliente aparezca en dos
 * páginas, o en ninguna, cuando varios empatan en el campo que se ordena.
 */
function comparar(orden: OrdenListado): (a: ClienteListable, b: ClienteListable) => number {
  switch (orden) {
    case 'pedidos':
      return (a, b) => b.cantidadPedidos - a.cantidadPedidos || b.totalGastado - a.totalGastado || b.id - a.id
    case 'gasto':
      return (a, b) => b.totalGastado - a.totalGastado || b.cantidadPedidos - a.cantidadPedidos || b.id - a.id
    case 'puntos':
      return (a, b) =>
        (b.puntos ?? 0) - (a.puntos ?? 0) || ms(b.ultimoPedidoAt) - ms(a.ultimoPedidoAt) || b.id - a.id
    case 'nombre':
      return (a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.id - b.id
    case 'alta':
      return (a, b) => ms(b.createdAt) - ms(a.createdAt) || b.id - a.id
    case 'recientes':
    default:
      return (a, b) => ms(b.ultimoPedidoAt) - ms(a.ultimoPedidoAt) || b.id - a.id
  }
}

/** Aplica los filtros y devuelve la lista ordenada. No modifica la entrada. */
export function filtrarClientesListado<T extends ClienteListable>(
  clientes: T[],
  f: FiltrosListado,
): T[] {
  const q = plegar((f.busqueda ?? '').trim())
  const qDigitos = soloDigitos(q)
  const porPedidos = filtraPorPedidos(f)
  return clientes
    .filter((cliente) => {
      if (f.segmento && cliente.segmento !== f.segmento) return false
      if (f.conPuntos && !((cliente.puntos ?? 0) > 0)) return false
      if (q && !coincideBusqueda(cliente, q, qDigitos)) return false
      if (porPedidos && !cumplePedidos(cliente, f)) return false
      return true
    })
    .sort(comparar(f.orden ?? 'alta'))
}

export interface ResumenListado {
  /** Clientes de la base, antes de los filtros. */
  total: number
  conPuntos: number
  puntosEnCirculacion: number
  porSegmento: Record<SegmentoListado, number>
}

/** Los números de la base entera: no dependen de la búsqueda ni de los filtros. */
export function resumirClientesListado(
  clientes: Pick<ClienteListable, 'puntos' | 'segmento'>[],
): ResumenListado {
  const porSegmento = Object.fromEntries(SEGMENTOS_LISTADO.map((s) => [s, 0])) as Record<
    SegmentoListado,
    number
  >
  let conPuntos = 0
  let puntosEnCirculacion = 0
  for (const cliente of clientes) {
    porSegmento[cliente.segmento] += 1
    const puntos = cliente.puntos ?? 0
    if (puntos > 0) {
      conPuntos += 1
      puntosEnCirculacion += puntos
    }
  }
  return { total: clientes.length, conPuntos, puntosEnCirculacion, porSegmento }
}

export interface PaginaListado<T> {
  items: T[]
  pagina: number
  limite: number
  total: number
  paginas: number
}

/**
 * Una página de la lista. Una página fuera de rango devuelve `items` vacío con
 * los totales reales: quien pide decide a dónde volver (p. ej. al borrar el
 * último cliente de la última página).
 */
export function paginarListado<T>(
  items: T[],
  pagina: number | null | undefined,
  limite: number | null | undefined,
): PaginaListado<T> {
  const tamano = Math.min(
    Math.max(Math.trunc(Number(limite) || LIMITE_LISTADO_DEFAULT), 1),
    LIMITE_LISTADO_MAX,
  )
  const numero = Math.max(Math.trunc(Number(pagina) || 1), 1)
  const desde = (numero - 1) * tamano
  return {
    items: items.slice(desde, desde + tamano),
    pagina: numero,
    limite: tamano,
    total: items.length,
    paginas: Math.ceil(items.length / tamano),
  }
}
