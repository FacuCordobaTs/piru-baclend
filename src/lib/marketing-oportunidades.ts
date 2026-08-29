import { computarPerfilesRFM, type SegmentoCliente } from './clientes-rfm'
import { recomendarRecetaCrecimiento, type CodigoRecetaCrecimiento, type ItemCarritoReceta, type ProductoFavoritoReceta } from './recetas-crecimiento'

export interface ClienteOportunidadInput {
  id: number
  nombre: string
  marketingOptOut: boolean
}

export interface PedidoOportunidadInput {
  id: number
  clienteId: number | null
  total: number | string
  createdAt: Date
}

export interface ItemOportunidadInput {
  pedidoId: number
  productoId: number
  cantidad: number
}

export interface ProductoOportunidadInput { id: number; nombre: string }
export interface ToqueOportunidadInput { clienteId: number | null; createdAt: Date }
export interface EnlaceOportunidadInput {
  id: number
  clienteId: number | null
  recetaCodigo: string | null
  destinoTipo: 'tienda' | 'producto' | 'carrito'
  productoId: number | null
  carritoRep: string | null
  codigoDescuentoId: number | null
  activo: boolean
  expiraAt: Date | null
  createdAt: Date
}

export interface DatosOportunidadesMarketing {
  clientes: ClienteOportunidadInput[]
  pedidos: PedidoOportunidadInput[]
  items: ItemOportunidadInput[]
  productos: ProductoOportunidadInput[]
  recuperos: ToqueOportunidadInput[]
  contactos: ToqueOportunidadInput[]
}

export interface OportunidadMarketing {
  cliente: { id: number; nombre: string }
  diagnostico: {
    segmento: SegmentoCliente
    esVip: boolean
    cadenciaDias: number | null
    diasDesdeUltimo: number | null
    ticketPromedio: number
    cantidadPedidos: number
    totalGastado: number
  }
  receta: ReturnType<typeof recomendarRecetaCrecimiento>['receta']
  destino: ReturnType<typeof recomendarRecetaCrecimiento>['destino']
  incentivoSugerido: ReturnType<typeof recomendarRecetaCrecimiento>['incentivoSugerido']
  textoSugerido: string
  prioridad: 'normal' | 'alta'
  tituloOportunidad: string
  elegibilidad: ReturnType<typeof recomendarRecetaCrecimiento>['elegibilidad']
  ultimoEnlacePreparado: EnlaceOportunidadInput | null
}

const MS_HORA = 60 * 60 * 1000
const MS_DIA = 24 * MS_HORA
const COOLDOWN_HORAS = 48
const TOPE_MARKETING = 4

/**
 * Construye oportunidades en memoria a partir de cargas batch del restaurante.
 * El repositorio resuelve las seis consultas acotadas; este dominio nunca hace
 * una consulta por cliente y conserva la clasificación RFM relativa al local.
 */
export function resolverOportunidadesMarketing(
  datos: DatosOportunidadesMarketing,
  enlaces: EnlaceOportunidadInput[],
  ahora: Date = new Date(),
): OportunidadMarketing[] {
  const pedidosPorCliente = new Map<number, PedidoOportunidadInput[]>()
  for (const pedido of datos.pedidos) {
    if (pedido.clienteId == null) continue
    const lista = pedidosPorCliente.get(pedido.clienteId) ?? []
    lista.push(pedido)
    pedidosPorCliente.set(pedido.clienteId, lista)
  }
  const itemsPorPedido = new Map<number, ItemOportunidadInput[]>()
  for (const item of datos.items) {
    const lista = itemsPorPedido.get(item.pedidoId) ?? []
    lista.push(item)
    itemsPorPedido.set(item.pedidoId, lista)
  }
  const productos = new Map(datos.productos.map((producto) => [producto.id, producto]))
  const toquesPorCliente = new Map<number, Date[]>()
  for (const toque of [...datos.recuperos, ...datos.contactos]) {
    if (toque.clienteId == null) continue
    const lista = toquesPorCliente.get(toque.clienteId) ?? []
    lista.push(new Date(toque.createdAt))
    toquesPorCliente.set(toque.clienteId, lista)
  }
  const enlacePorCliente = new Map<number, EnlaceOportunidadInput>()
  for (const enlace of enlaces) {
    if (enlace.clienteId == null) continue
    const previo = enlacePorCliente.get(enlace.clienteId)
    if (!previo || new Date(enlace.createdAt).getTime() > new Date(previo.createdAt).getTime()) enlacePorCliente.set(enlace.clienteId, enlace)
  }

  const perfiles = computarPerfilesRFM(datos.clientes.map((cliente) => {
    const pedidos = pedidosPorCliente.get(cliente.id) ?? []
    return {
      cantidadPedidos: pedidos.length,
      totalGastado: pedidos.reduce((total, pedido) => total + Number(pedido.total), 0),
      fechasPedidos: pedidos.map((pedido) => new Date(pedido.createdAt).getTime()),
    }
  }), ahora.getTime())

  return datos.clientes.map((cliente, indice) => {
    const pedidos = pedidosPorCliente.get(cliente.id) ?? []
    const perfil = perfiles[indice]
    const ultimoPedido = pedidos.reduce<PedidoOportunidadInput | null>((ultimo, pedido) =>
      !ultimo || new Date(pedido.createdAt) > new Date(ultimo.createdAt) ? pedido : ultimo, null)
    const conteo = new Map<number, number>()
    for (const pedido of pedidos) for (const item of itemsPorPedido.get(pedido.id) ?? []) {
      conteo.set(item.productoId, (conteo.get(item.productoId) ?? 0) + item.cantidad)
    }
    const favoritoId = [...conteo.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const favorito: ProductoFavoritoReceta | null = favoritoId != null && productos.has(favoritoId)
      ? { productoId: favoritoId, nombre: productos.get(favoritoId)!.nombre } : null
    const ultimoCarrito: ItemCarritoReceta[] = ultimoPedido
      ? (itemsPorPedido.get(ultimoPedido.id) ?? []).filter((item) => productos.has(item.productoId))
        .map((item) => ({ productoId: item.productoId, cantidad: item.cantidad })) : []
    const toques = toquesPorCliente.get(cliente.id) ?? []
    const ultimoToque = toques.reduce<Date | null>((ultimo, toque) => !ultimo || toque > ultimo ? toque : ultimo, null)
    const desdeVentana = ahora.getTime() - 30 * MS_DIA
    const recomendacion = recomendarRecetaCrecimiento({
      segmento: perfil.segmento,
      esVip: perfil.esVip,
      ultimoCarrito,
      productoFavorito: favorito,
      marketingOptOut: cliente.marketingOptOut,
      enCooldown: Boolean(ultimoToque && ahora.getTime() - ultimoToque.getTime() < COOLDOWN_HORAS * MS_HORA),
      presionMarketingAlcanzada: toques.filter((toque) => toque.getTime() >= desdeVentana).length >= TOPE_MARKETING,
    })
    return {
      cliente: { id: cliente.id, nombre: cliente.nombre },
      diagnostico: {
        segmento: perfil.segmento, esVip: perfil.esVip, cadenciaDias: perfil.cadenciaDias,
        diasDesdeUltimo: perfil.diasDesdeUltimo, ticketPromedio: perfil.ticketPromedio,
        cantidadPedidos: pedidos.length, totalGastado: pedidos.reduce((total, pedido) => total + Number(pedido.total), 0),
      },
      receta: recomendacion.receta, destino: recomendacion.destino,
      incentivoSugerido: recomendacion.incentivoSugerido, textoSugerido: recomendacion.textoSugerido,
      prioridad: recomendacion.prioridad, tituloOportunidad: recomendacion.tituloOportunidad,
      elegibilidad: recomendacion.elegibilidad, ultimoEnlacePreparado: enlacePorCliente.get(cliente.id) ?? null,
    }
  }).sort((a, b) => (a.prioridad === b.prioridad ? b.diagnostico.totalGastado - a.diagnostico.totalGastado : a.prioridad === 'alta' ? -1 : 1))
}

export function filtrarOportunidadesMarketing(
  oportunidades: OportunidadMarketing[],
  filtros: { segmento?: SegmentoCliente; receta?: CodigoRecetaCrecimiento },
): OportunidadMarketing[] {
  return oportunidades.filter((oportunidad) =>
    (!filtros.segmento || oportunidad.diagnostico.segmento === filtros.segmento)
    && (!filtros.receta || oportunidad.receta.codigo === filtros.receta))
}
