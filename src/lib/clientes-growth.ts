export interface PedidoGrowthCliente {
  id: number
  clienteId: number | null
  total: number | string
  createdAt: Date
}

export interface AtribucionGrowthCliente {
  pedidoUnificadoId: number
  campanaId: number | null
  origen: 'campana' | 'receta'
  recetaCodigo: string | null
  revenueAtribuido: number | string
  createdAt: Date
}

export interface CampanaGrowthCliente {
  id: number
  nombre: string
  slug: string
}

export interface OportunidadGrowthCliente {
  cliente: { id: number }
  receta: unknown
  ultimoEnlacePreparado: unknown | null
}

export interface DatosGrowthCliente {
  fuenteAdquisicion: 'campana' | 'receta' | null
  campanaAdquisicion: { id: number; nombre: string; slug: string } | null
  primeraCompra: { pedidoId: number; fecha: string; revenue: number } | null
  revenueHistorico: number
  recetaRecomendada: unknown | null
  enlacePreparado: unknown | null
  revenueAcciones: number
}

/**
 * Resume los datos comerciales que la lista legacy de clientes necesita sin
 * consultar por cliente. La adquisición sólo se adjudica si el primer pedido
 * conocido tiene una atribución: una campaña posterior es recompra, no fuente
 * de adquisición.
 */
export function resolverDatosGrowthClientes(
  clientes: Array<{ id: number }>,
  pedidos: PedidoGrowthCliente[],
  atribuciones: AtribucionGrowthCliente[],
  campanas: CampanaGrowthCliente[],
  oportunidades: OportunidadGrowthCliente[],
): Map<number, DatosGrowthCliente> {
  const pedidosPorCliente = new Map<number, PedidoGrowthCliente[]>()
  for (const pedido of pedidos) {
    if (pedido.clienteId == null) continue
    const lista = pedidosPorCliente.get(pedido.clienteId) ?? []
    lista.push(pedido)
    pedidosPorCliente.set(pedido.clienteId, lista)
  }
  const atribucionPorPedido = new Map(atribuciones.map((atribucion) => [atribucion.pedidoUnificadoId, atribucion]))
  const clientePorPedido = new Map(pedidos.map((pedido) => [pedido.id, pedido.clienteId]))
  const campanaPorId = new Map(campanas.map((campana) => [campana.id, campana]))
  const oportunidadPorCliente = new Map(oportunidades.map((oportunidad) => [oportunidad.cliente.id, oportunidad]))
  const revenueAccionesPorCliente = new Map<number, number>()
  for (const atribucion of atribuciones) {
    if (atribucion.origen !== 'receta') continue
    const clienteId = clientePorPedido.get(atribucion.pedidoUnificadoId)
    if (clienteId == null) continue
    revenueAccionesPorCliente.set(clienteId, (revenueAccionesPorCliente.get(clienteId) ?? 0) + Number(atribucion.revenueAtribuido))
  }

  return new Map(clientes.map((cliente) => {
    const pedidosCliente = [...(pedidosPorCliente.get(cliente.id) ?? [])]
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    const primeraCompra = pedidosCliente[0] ?? null
    const atribucionAdquisicion = primeraCompra ? atribucionPorPedido.get(primeraCompra.id) ?? null : null
    const campana = atribucionAdquisicion?.campanaId != null
      ? campanaPorId.get(atribucionAdquisicion.campanaId) ?? null : null
    const oportunidad = oportunidadPorCliente.get(cliente.id)
    return [cliente.id, {
      fuenteAdquisicion: atribucionAdquisicion?.origen ?? null,
      campanaAdquisicion: campana ? { id: campana.id, nombre: campana.nombre, slug: campana.slug } : null,
      primeraCompra: primeraCompra ? {
        pedidoId: primeraCompra.id,
        fecha: new Date(primeraCompra.createdAt).toISOString(),
        revenue: Number(primeraCompra.total),
      } : null,
      revenueHistorico: pedidosCliente.reduce((total, pedido) => total + Number(pedido.total), 0),
      recetaRecomendada: oportunidad?.receta ?? null,
      enlacePreparado: oportunidad?.ultimoEnlacePreparado ?? null,
      revenueAcciones: revenueAccionesPorCliente.get(cliente.id) ?? 0,
    }]
  }))
}
