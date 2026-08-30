export interface FiltrosResultadosMarketing {
  from?: Date
  to?: Date
  campaniaId?: number
  sucursalId?: number
}

export interface PedidoResultadoMarketing {
  id: number; clienteId: number | null; sucursalId: number | null; total: number | string
  montoDescuento: number | string | null; createdAt: Date; pagado: boolean
}
export interface CampanaResultadoMarketing { id: number; nombre: string; slug: string; tipo: 'adquisicion' | 'recompra'; inversionManual: number | string; usaGrupoControl: boolean }
export interface AtribucionResultadoMarketing { pedidoUnificadoId: number; campanaId: number | null; recetaCodigo: string | null; revenueAtribuido: number | string; descuentoAtribuido: number | string; createdAt: Date }
export interface SesionResultadoMarketing { id: number; firstTouchCampanaId: number | null; lastTouchCampanaId: number | null; createdAt: Date }
export interface EventoResultadoMarketing { id: number; marketingSesionId: number; tipo: 'session_start' | 'product_view' | 'add_to_cart' | 'checkout_start' | 'purchase'; ocurridoAt: Date }
export interface ContactoResultadoMarketing { id: number; enlaceId: number; canal: 'copiado' | 'wa_me' | 'piru_whatsapp' | 'otro'; estado: 'preparado' | 'abierto' | 'reservado' | 'enviado' | 'fallido' | 'revertido'; costoMensajes: number | string; createdAt: Date }
export interface EnlaceResultadoMarketing { id: number; campanaId: number | null; recetaCodigo: string | null; createdAt: Date }
export interface OportunidadResultadoMarketing { segmento: string; recetaCodigo: string }

export interface DatosResultadosMarketing {
  pedidos: PedidoResultadoMarketing[]; campanas: CampanaResultadoMarketing[]; atribuciones: AtribucionResultadoMarketing[]
  sesiones: SesionResultadoMarketing[]; eventos: EventoResultadoMarketing[]; contactos: ContactoResultadoMarketing[]
  enlaces: EnlaceResultadoMarketing[]; oportunidades: OportunidadResultadoMarketing[]
}

const numero = (valor: number | string | null | undefined) => Number(valor ?? 0)
const redondear = (valor: number) => Math.round((valor + Number.EPSILON) * 100) / 100
const enRango = (fecha: Date, filtros: FiltrosResultadosMarketing) => (!filtros.from || fecha >= filtros.from) && (!filtros.to || fecha <= filtros.to)
const contarPor = <T>(filas: T[], clave: (fila: T) => string) => Object.fromEntries([...filas.reduce((map, fila) => map.set(clave(fila), (map.get(clave(fila)) ?? 0) + 1), new Map<string, number>()).entries()])

/**
 * Agregador deliberadamente sin SQL: los reportes tienen una única semántica
 * comprobable y el repositorio sólo carga filas tenant-safe en batches. Un
 * pedido sólo entra una vez por su id, incluso si aparece atribución/evento.
 */
export function resumirResultadosMarketing(datos: DatosResultadosMarketing, filtros: FiltrosResultadosMarketing = {}, incluirCampanas = true) {
  const pedidosPagados = datos.pedidos.filter((pedido) => pedido.pagado && enRango(pedido.createdAt, filtros)
    && (!filtros.sucursalId || pedido.sucursalId === filtros.sucursalId))
  const atribucionPorPedido = new Map(datos.atribuciones.map((fila) => [fila.pedidoUnificadoId, fila]))
  const idsCampania = filtros.campaniaId == null ? null : new Set([filtros.campaniaId])
  const pedidosScope = idsCampania
    ? pedidosPagados.filter((pedido) => idsCampania.has(atribucionPorPedido.get(pedido.id)?.campanaId ?? -1))
    : pedidosPagados
  const pedidosUnicos = [...new Map(pedidosScope.map((pedido) => [pedido.id, pedido])).values()]
  const idsPedidos = new Set(pedidosUnicos.map((pedido) => pedido.id))
  const atribuciones = datos.atribuciones.filter((fila) => idsPedidos.has(fila.pedidoUnificadoId))
  const sesiones = datos.sesiones.filter((fila) => enRango(fila.createdAt, filtros) && (!idsCampania || idsCampania.has(fila.firstTouchCampanaId ?? -1) || idsCampania.has(fila.lastTouchCampanaId ?? -1)))
  const idsSesiones = new Set(sesiones.map((fila) => fila.id))
  const eventos = datos.eventos.filter((fila) => idsSesiones.has(fila.marketingSesionId) && enRango(fila.ocurridoAt, filtros))
  const enlacesRelacionados = datos.enlaces.filter((fila) => !idsCampania || idsCampania.has(fila.campanaId ?? -1))
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
  const nuevos = new Set([...clientes].filter((id) => pedidosUnicos.some((pedido) => pedido.clienteId === id && primeraCompra.get(id)?.getTime() === pedido.createdAt.getTime()))).size
  const inversion = redondear(datos.campanas.filter((fila) => !idsCampania || idsCampania.has(fila.id)).reduce((total, fila) => total + numero(fila.inversionManual), 0))
  const costoMensajes = redondear(contactos.filter((fila) => fila.canal === 'piru_whatsapp' && fila.estado === 'enviado').reduce((total, fila) => total + numero(fila.costoMensajes), 0))
  const costoTotal = redondear(inversion + costoMensajes + descuentosAtribuidos)
  const retorno = redondear(revenueAtribuido - costoTotal)
  const funnel = Object.fromEntries(['session_start', 'product_view', 'add_to_cart', 'checkout_start', 'purchase'].map((tipo) => [tipo, new Set(eventos.filter((evento) => evento.tipo === tipo).map((evento) => evento.id)).size])) as Record<string, number>
  const campanas = !incluirCampanas ? [] : datos.campanas.filter((campana) => !idsCampania || idsCampania.has(campana.id)).map((campana) => {
    const resultado = resumirResultadosMarketing(datos, { ...filtros, campaniaId: campana.id }, false)
    return { id: campana.id, nombre: campana.nombre, slug: campana.slug, tipo: campana.tipo, ...resultado.metricas, incremental: { disponible: false, motivo: campana.usaGrupoControl ? 'No hay cohorte de control vinculada a esta campaña' : 'La campaña no configuró grupo de control' } }
  })
  return {
    filtros: { from: filtros.from?.toISOString() ?? null, to: filtros.to?.toISOString() ?? null, campaniaId: filtros.campaniaId ?? null, sucursalId: filtros.sucursalId ?? null },
    metricas: {
      ventas, pedidos: pedidosUnicos.length, ticketPromedio: pedidosUnicos.length ? redondear(ventas / pedidosUnicos.length) : 0,
      clientesNuevos: nuevos, clientesRecurrentes: Math.max(0, clientes.size - nuevos), sesiones: sesiones.length,
      conversion: sesiones.length ? redondear((pedidosUnicos.length / sesiones.length) * 100) : 0,
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
