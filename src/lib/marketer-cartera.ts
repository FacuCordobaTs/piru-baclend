import { obtenerComponentesArgentina } from './motor-recompra-patron'

export interface PedidoCartera {
  restauranteId: number
  createdAt: Date
  total: string | number
  pagado: boolean
}
/** Un solo conjunto de pedidos de 60 días produce ventas, actividad y sparkline en ART. */
export function metricasCartera(pedidos: PedidoCartera[], ahora = new Date()) {
  const diaMs = 86400000
  const limite30 = ahora.getTime() - 30 * diaMs
  const limite60 = ahora.getTime() - 60 * diaMs
  const semanas = new Array<number>(8).fill(0)
  let ventas30d = 0,
    ventas30dAnterior = 0,
    pedidos30d = 0
  const dias = new Array<number>(7).fill(0)
  const semanasConPedidos = new Set<number>()
  const compHoy = obtenerComponentesArgentina(ahora.getTime())
  const lunesActual = Date.UTC(
    compHoy.anio,
    compHoy.mes,
    compHoy.diaMes - ((compHoy.diaSemana + 6) % 7),
    3,
  )
  for (const pedido of pedidos) {
    const fecha = pedido.createdAt.getTime()
    if (fecha < limite60 || fecha > ahora.getTime()) continue
    if (fecha >= limite30) {
      pedidos30d++
      if (pedido.pagado) ventas30d += Number(pedido.total)
    } else if (pedido.pagado) ventas30dAnterior += Number(pedido.total)
    const comp = obtenerComponentesArgentina(fecha)
    const dia = comp.hora < 6 ? (comp.diaSemana + 6) % 7 : comp.diaSemana
    dias[dia]++
    const indice = 7 + Math.floor((fecha - lunesActual) / (7 * diaMs))
    if (indice >= 0 && indice < 8) {
      semanasConPedidos.add(indice)
      if (pedido.pagado) semanas[indice] += Number(pedido.total)
    }
  }
  return {
    ventas30d,
    ventas30dAnterior,
    pedidos30d,
    ventasSemanales: semanas,
    conteosDia: dias,
    semanasConPedidos: semanasConPedidos.size,
  }
}
