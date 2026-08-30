export interface PedidoGrowthCliente {
  id: number
  clienteId: number | null
  total: number | string
  codigoDescuentoId?: number | null
  montoDescuento?: number | string | null
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

export interface CuponGrowthCliente {
  id: number
  codigo: string
  tipo: 'porcentaje' | 'monto_fijo'
  valor: number | string
}

export interface OportunidadGrowthCliente {
  cliente: { id: number }
  receta: unknown
  ultimoEnlacePreparado: unknown | null
}

export interface DatosGrowthCliente {
  fuenteAdquisicion: 'campana' | 'receta' | 'organico' | null
  campanaAdquisicion: { id: number; nombre: string; slug: string } | null
  primeraCompra: { pedidoId: number; fecha: string; revenue: number } | null
  revenueHistorico: number
  recetaRecomendada: unknown | null
  enlacePreparado: unknown | null
  revenueAcciones: number
  campanasParticipadas: Array<{
    id: number
    nombre: string
    slug: string
    pedidos: number
    revenueAtribuido: number
    primeraInteraccion: string
    ultimaInteraccion: string
  }>
  cuponesUsados: Array<{
    id: number
    codigo: string
    tipo: 'porcentaje' | 'monto_fijo'
    valor: number
    usos: number
    facturacion: number
    montoDescontado: number
    ultimoUsoAt: string
  }>
  actividadOrganica: { pedidos: number; facturacion: number; ultimoPedidoAt: string } | null
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
  opciones: {
    pedidoIdsOrganicos?: ReadonlySet<number>
    cupones?: CuponGrowthCliente[]
  } = {},
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
  const cuponPorId = new Map((opciones.cupones ?? []).map((cupon) => [cupon.id, cupon]))
  const pedidoIdsOrganicos = opciones.pedidoIdsOrganicos ?? new Set<number>()
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
    const campanasCliente = new Map<number, DatosGrowthCliente['campanasParticipadas'][number]>()
    const cuponesCliente = new Map<number, DatosGrowthCliente['cuponesUsados'][number]>()
    const pedidosOrganicos = pedidosCliente.filter((pedido) => pedidoIdsOrganicos.has(pedido.id))
    for (const pedido of pedidosCliente) {
      const atribucion = atribucionPorPedido.get(pedido.id)
      const campanaRelacionada = atribucion?.campanaId != null ? campanaPorId.get(atribucion.campanaId) : null
      if (campanaRelacionada && atribucion) {
        const fecha = new Date(atribucion.createdAt).toISOString()
        const actual = campanasCliente.get(campanaRelacionada.id)
        campanasCliente.set(campanaRelacionada.id, actual ? {
          ...actual,
          pedidos: actual.pedidos + 1,
          revenueAtribuido: actual.revenueAtribuido + Number(atribucion.revenueAtribuido),
          primeraInteraccion: actual.primeraInteraccion < fecha ? actual.primeraInteraccion : fecha,
          ultimaInteraccion: actual.ultimaInteraccion > fecha ? actual.ultimaInteraccion : fecha,
        } : {
          id: campanaRelacionada.id,
          nombre: campanaRelacionada.nombre,
          slug: campanaRelacionada.slug,
          pedidos: 1,
          revenueAtribuido: Number(atribucion.revenueAtribuido),
          primeraInteraccion: fecha,
          ultimaInteraccion: fecha,
        })
      }
      const cupon = pedido.codigoDescuentoId != null ? cuponPorId.get(pedido.codigoDescuentoId) : null
      if (cupon) {
        const fecha = new Date(pedido.createdAt).toISOString()
        const actual = cuponesCliente.get(cupon.id)
        cuponesCliente.set(cupon.id, actual ? {
          ...actual,
          usos: actual.usos + 1,
          facturacion: actual.facturacion + Number(pedido.total),
          montoDescontado: actual.montoDescontado + Number(pedido.montoDescuento ?? 0),
          ultimoUsoAt: actual.ultimoUsoAt > fecha ? actual.ultimoUsoAt : fecha,
        } : {
          id: cupon.id,
          codigo: cupon.codigo,
          tipo: cupon.tipo,
          valor: Number(cupon.valor),
          usos: 1,
          facturacion: Number(pedido.total),
          montoDescontado: Number(pedido.montoDescuento ?? 0),
          ultimoUsoAt: fecha,
        })
      }
    }
    return [cliente.id, {
      fuenteAdquisicion: atribucionAdquisicion?.origen ?? (primeraCompra && pedidoIdsOrganicos.has(primeraCompra.id) ? 'organico' : null),
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
      campanasParticipadas: Array.from(campanasCliente.values()).sort((a, b) => b.ultimaInteraccion.localeCompare(a.ultimaInteraccion)),
      cuponesUsados: Array.from(cuponesCliente.values()).sort((a, b) => b.ultimoUsoAt.localeCompare(a.ultimoUsoAt)),
      actividadOrganica: pedidosOrganicos.length ? {
        pedidos: pedidosOrganicos.length,
        facturacion: pedidosOrganicos.reduce((total, pedido) => total + Number(pedido.total), 0),
        ultimoPedidoAt: new Date(Math.max(...pedidosOrganicos.map((pedido) => new Date(pedido.createdAt).getTime()))).toISOString(),
      } : null,
    }]
  }))
}
