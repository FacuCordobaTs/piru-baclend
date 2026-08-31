export interface FiltrosResultadosMarketing {
  from?: Date
  to?: Date
  campaniaId?: number
  sucursalId?: number
  /** Vista virtual de tráfico directo. No existe una fila artificial en marketing_campana. */
  fuente?: 'organico'
}

export interface PedidoResultadoMarketing {
  id: number; clienteId: number | null; sucursalId: number | null; total: number | string
  montoDescuento: number | string | null; marketingCampanaId?: number | null; createdAt: Date; pagado: boolean
}
export interface CampanaResultadoMarketing { id: number; nombre: string; slug: string; tipo: 'adquisicion' | 'recompra'; productoId: number | null; inversionManual: number | string; usaGrupoControl: boolean }
export interface AtribucionResultadoMarketing { pedidoUnificadoId: number; campanaId: number | null; recetaCodigo: string | null; revenueAtribuido: number | string; descuentoAtribuido: number | string; createdAt: Date }
export interface SesionResultadoMarketing {
  id: number
  firstTouchTipo?: 'directo' | 'campana' | 'receta'
  lastTouchTipo?: 'directo' | 'campana' | 'receta'
  firstTouchCampanaId: number | null
  lastTouchCampanaId: number | null
  createdAt: Date
}
export interface EventoResultadoMarketing {
  id: number
  marketingSesionId: number | null
  sesionUuid?: string | null
  campanaId?: number | null
  tipo: 'session_start' | 'product_view' | 'add_to_cart' | 'checkout_start' | 'purchase'
  productoId?: number | null
  pedidoUnificadoId?: number | null
  ocurridoAt: Date
}
export interface ContactoResultadoMarketing { id: number; enlaceId: number; canal: 'copiado' | 'wa_me' | 'piru_whatsapp' | 'otro'; estado: 'preparado' | 'abierto' | 'reservado' | 'enviado' | 'fallido' | 'revertido'; costoMensajes: number | string; createdAt: Date }
export interface EnlaceResultadoMarketing { id: number; campanaId: number | null; recetaCodigo: string | null; createdAt: Date }
export interface OportunidadResultadoMarketing { segmento: string; recetaCodigo: string }

export interface DatosResultadosMarketing {
  pedidos: PedidoResultadoMarketing[]; campanas: CampanaResultadoMarketing[]; atribuciones: AtribucionResultadoMarketing[]
  sesiones: SesionResultadoMarketing[]; eventos: EventoResultadoMarketing[]; contactos: ContactoResultadoMarketing[]
  enlaces: EnlaceResultadoMarketing[]; oportunidades: OportunidadResultadoMarketing[]
}

export interface MetricasResultadosMarketing {
  ventas: number; pedidos: number; ticketPromedio: number; clientesNuevos: number; clientesRecurrentes: number
  sesiones: number; conversion: number; revenueAtribuido: number; descuentos: number; descuentosAtribuidos: number
  enlacesCreados: number; contactos: number; mensajesPagos: number; costoMensajes: number; inversionManual: number
  costoTotal: number; retorno: number
}

export interface ResultadoMarketing {
  filtros: { from: string | null; to: string | null; campaniaId: number | null; sucursalId: number | null }
  metricas: MetricasResultadosMarketing
  funnel: Record<string, number>
  oportunidades: { porSegmento: Record<string, number>; porReceta: Record<string, number>; total: number }
  recompra: { pedidosAtribuidos: number; revenueAtribuido: number }
  incremental: { disponible: boolean; motivo: string }
  campanas: Array<Pick<CampanaResultadoMarketing, 'id' | 'nombre' | 'slug' | 'tipo'> & MetricasResultadosMarketing & {
    metricas: MetricasResultadosMarketing
    incremental: { disponible: boolean; motivo: string }
  }>
}

const numero = (valor: number | string | null | undefined) => Number(valor ?? 0)
const redondear = (valor: number) => Math.round((valor + Number.EPSILON) * 100) / 100
const enRango = (fecha: Date, filtros: FiltrosResultadosMarketing) => (!filtros.from || fecha >= filtros.from) && (!filtros.to || fecha <= filtros.to)
const contarPor = <T>(filas: T[], clave: (fila: T) => string) => Object.fromEntries(filas.reduce((map, fila) => map.set(clave(fila), (map.get(clave(fila)) ?? 0) + 1), new Map<string, number>()))

/**
 * Agregador deliberadamente sin SQL: los reportes tienen una única semántica
 * comprobable y el repositorio sólo carga filas tenant-safe en batches. Un
 * pedido sólo entra una vez por su id, incluso si aparece atribución/evento.
 */
export function resumirResultadosMarketing(datos: DatosResultadosMarketing, filtros: FiltrosResultadosMarketing = {}, incluirCampanas = true): ResultadoMarketing {
  const pedidosPagados = datos.pedidos.filter((pedido) => pedido.pagado && enRango(pedido.createdAt, filtros)
    && (!filtros.sucursalId || pedido.sucursalId === filtros.sucursalId))
  // `pedido_unificado.marketing_campana_id` es la fuente operativa, escrita en
  // el mismo INSERT del pedido. La tabla analítica sigue aportando recetas y
  // snapshots, pero ya no puede convertir una venta real de campaña en orgánica.
  const atribucionesEfectivas = [...datos.atribuciones]
  const pedidosConAtribucion = new Set(atribucionesEfectivas.map((fila) => fila.pedidoUnificadoId))
  for (const pedido of datos.pedidos) {
    if (pedido.marketingCampanaId != null && !pedidosConAtribucion.has(pedido.id)) {
      atribucionesEfectivas.push({
        pedidoUnificadoId: pedido.id,
        campanaId: pedido.marketingCampanaId,
        recetaCodigo: null,
        revenueAtribuido: pedido.total,
        descuentoAtribuido: pedido.montoDescuento ?? 0,
        createdAt: pedido.createdAt,
      })
    }
  }
  const atribucionPorPedido = new Map(atribucionesEfectivas.map((fila) => [fila.pedidoUnificadoId, fila]))
  const idsCampania = filtros.campaniaId == null ? null : new Set([filtros.campaniaId])
  const sesionesOrganicas = filtros.fuente === 'organico'
    ? datos.sesiones.filter((sesion) => (
      (sesion.firstTouchTipo ?? (sesion.firstTouchCampanaId == null ? 'directo' : 'campana')) === 'directo'
      && (sesion.lastTouchTipo ?? (sesion.lastTouchCampanaId == null ? 'directo' : 'campana')) === 'directo'
    ))
    : []
  const idsSesionesOrganicas = new Set(sesionesOrganicas.map((sesion) => sesion.id))
  const idsPedidosOrganicos = new Set(datos.eventos
    .filter((evento) => evento.tipo === 'purchase' && evento.marketingSesionId != null
      && idsSesionesOrganicas.has(evento.marketingSesionId) && evento.pedidoUnificadoId != null)
    .map((evento) => evento.pedidoUnificadoId!))
  const pedidosScope = filtros.fuente === 'organico'
    // Orgánico incluye también pedidos previos al tracking o cuyo navegador
    // bloqueó analítica: la ausencia de una campaña atribuida es la definición
    // comercial relevante, no la presencia de un evento técnico.
    ? pedidosPagados.filter((pedido) => !atribucionPorPedido.has(pedido.id))
    : idsCampania
      ? pedidosPagados.filter((pedido) => idsCampania.has(atribucionPorPedido.get(pedido.id)?.campanaId ?? -1))
      : pedidosPagados
  const pedidosUnicos = Array.from(new Map(pedidosScope.map((pedido) => [pedido.id, pedido])).values())
  const idsPedidos = new Set(pedidosUnicos.map((pedido) => pedido.id))
  const atribuciones = atribucionesEfectivas.filter((fila) => idsPedidos.has(fila.pedidoUnificadoId))
  const sesiones = datos.sesiones.filter((fila) => enRango(fila.createdAt, filtros)
    && (filtros.fuente === 'organico'
      ? idsSesionesOrganicas.has(fila.id)
      : (!idsCampania || idsCampania.has(fila.firstTouchCampanaId ?? -1) || idsCampania.has(fila.lastTouchCampanaId ?? -1))))
  const idsSesiones = new Set(sesiones.map((fila) => fila.id))
  const eventos = datos.eventos.filter((fila) => enRango(fila.ocurridoAt, filtros) && (
    filtros.fuente === 'organico'
      ? fila.campanaId == null && fila.marketingSesionId != null && idsSesionesOrganicas.has(fila.marketingSesionId)
      : idsCampania
        ? idsCampania.has(fila.campanaId ?? -1)
          || (fila.marketingSesionId != null && idsSesiones.has(fila.marketingSesionId))
        : true
  ))
  const claveSesionEvento = (evento: EventoResultadoMarketing) => evento.marketingSesionId != null
    ? `id:${evento.marketingSesionId}`
    : evento.sesionUuid
      ? `uuid:${evento.sesionUuid}`
      : `evento:${evento.id}`
  const clavesSesiones = new Set([
    ...sesiones.map((sesion) => `id:${sesion.id}`),
    ...eventos.map(claveSesionEvento),
  ])
  const enlacesRelacionados = filtros.fuente === 'organico'
    ? []
    : datos.enlaces.filter((fila) => !idsCampania || idsCampania.has(fila.campanaId ?? -1))
  const enlaces = enlacesRelacionados.filter((fila) => enRango(fila.createdAt, filtros))
  const idsEnlaces = new Set(enlacesRelacionados.map((fila) => fila.id))
  const contactos = datos.contactos.filter((fila) => idsEnlaces.has(fila.enlaceId) && enRango(fila.createdAt, filtros))
  const ventas = redondear(pedidosUnicos.reduce((total, pedido) => total + numero(pedido.total), 0))
  const descuentos = redondear(pedidosUnicos.reduce((total, pedido) => total + numero(pedido.montoDescuento), 0))
  const revenueAtribuido = redondear(atribuciones.reduce((total, fila) => total + numero(fila.revenueAtribuido), 0))
  const descuentosAtribuidos = redondear(atribuciones.reduce((total, fila) => total + numero(fila.descuentoAtribuido), 0))
  const clientes = new Set(pedidosUnicos.map((pedido) => pedido.clienteId).filter((id): id is number => id != null))
  const primeraCompra = new Map<number, Date>()
  for (const pedido of datos.pedidos.filter((fila) => fila.pagado && fila.clienteId != null)) {
    const anterior = primeraCompra.get(pedido.clienteId!)
    if (!anterior || pedido.createdAt < anterior) primeraCompra.set(pedido.clienteId!, pedido.createdAt)
  }
  const nuevos = new Set(Array.from(clientes).filter((id) => pedidosUnicos.some((pedido) => pedido.clienteId === id && primeraCompra.get(id)?.getTime() === pedido.createdAt.getTime()))).size
  const inversion = filtros.fuente === 'organico' ? 0 : redondear(datos.campanas.filter((fila) => !idsCampania || idsCampania.has(fila.id)).reduce((total, fila) => total + numero(fila.inversionManual), 0))
  const costoMensajes = redondear(contactos.filter((fila) => fila.canal === 'piru_whatsapp' && fila.estado === 'enviado').reduce((total, fila) => total + numero(fila.costoMensajes), 0))
  const costoTotal = redondear(inversion + costoMensajes + descuentosAtribuidos)
  const retorno = redondear(revenueAtribuido - costoTotal)
  // El embudo cuenta personas/sesiones, no clicks repetidos. `purchase` se
  // concilia con pedidos cobrados para no depender de un evento del navegador.
  const funnel = Object.fromEntries(['session_start', 'product_view', 'add_to_cart', 'checkout_start', 'purchase'].map((tipo) => [
    tipo,
    tipo === 'purchase'
      ? pedidosUnicos.length
      : tipo === 'session_start'
        ? clavesSesiones.size
      : new Set(eventos.filter((evento) => evento.tipo === tipo).map(claveSesionEvento)).size,
  ])) as Record<string, number>
  const campanaUnica = filtros.campaniaId == null ? null : datos.campanas.find((campana) => campana.id === filtros.campaniaId) ?? null
  const sesionesQueAgregaronPromo = new Set(eventos.filter((evento) => evento.tipo === 'add_to_cart'
    && campanaUnica?.productoId != null && evento.productoId === campanaUnica.productoId).map(claveSesionEvento))
  const sesionesQueAgregaronOtro = new Set(eventos.filter((evento) => evento.tipo === 'add_to_cart'
    && campanaUnica?.productoId != null && evento.productoId != null && evento.productoId !== campanaUnica.productoId).map(claveSesionEvento))
  funnel.add_other_product = new Set([...sesionesQueAgregaronPromo].filter((id) => sesionesQueAgregaronOtro.has(id))).size
  const campanas: ResultadoMarketing['campanas'] = !incluirCampanas || filtros.fuente === 'organico' ? [] : datos.campanas.filter((campana) => !idsCampania || idsCampania.has(campana.id)).map((campana) => {
    const resultado = resumirResultadosMarketing(datos, { ...filtros, fuente: undefined, campaniaId: campana.id }, false)
    return {
      id: campana.id,
      nombre: campana.nombre,
      slug: campana.slug,
      tipo: campana.tipo,
      // `metricas` es el contrato canónico del admin nuevo. Los aliases planos
      // se conservan para bundles instalados durante el MVP inicial.
      metricas: resultado.metricas,
      ...resultado.metricas,
      incremental: { disponible: false, motivo: campana.usaGrupoControl ? 'No hay cohorte de control vinculada a esta campaña' : 'La campaña no configuró grupo de control' },
    }
  })
  return {
    filtros: { from: filtros.from?.toISOString() ?? null, to: filtros.to?.toISOString() ?? null, campaniaId: filtros.campaniaId ?? null, sucursalId: filtros.sucursalId ?? null },
    metricas: {
      ventas, pedidos: pedidosUnicos.length, ticketPromedio: pedidosUnicos.length ? redondear(ventas / pedidosUnicos.length) : 0,
      clientesNuevos: nuevos, clientesRecurrentes: Math.max(0, clientes.size - nuevos), sesiones: clavesSesiones.size,
      conversion: clavesSesiones.size ? redondear((pedidosUnicos.length / clavesSesiones.size) * 100) : 0,
      revenueAtribuido, descuentos, descuentosAtribuidos, enlacesCreados: enlaces.length, contactos: contactos.length,
      mensajesPagos: contactos.filter((fila) => fila.canal === 'piru_whatsapp' && fila.estado === 'enviado').length,
      costoMensajes, inversionManual: inversion, costoTotal, retorno,
    },
    funnel, oportunidades: { porSegmento: contarPor(datos.oportunidades, (fila) => fila.segmento), porReceta: contarPor(datos.oportunidades, (fila) => fila.recetaCodigo), total: datos.oportunidades.length },
    recompra: { pedidosAtribuidos: atribuciones.filter((fila) => fila.recetaCodigo != null).length, revenueAtribuido: redondear(atribuciones.filter((fila) => fila.recetaCodigo != null).reduce((total, fila) => total + numero(fila.revenueAtribuido), 0)) },
    incremental: { disponible: false, motivo: 'El MVP no vincula cohortes de control a marketing_campana; revenue atribuido e incremental se reportan por separado' },
    campanas,
  }
}
