import { crearDateArgentina, obtenerComponentesArgentina } from './motor-recompra-patron'
import { diasEntreToques } from './recompra-goteo'

export const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']
export const DIA_MS = 86400000
export function fechaArgentina(ms: number): string {
  return new Date(ms - 3 * 3600000).toISOString().slice(0, 10)
}
export function horarioSemanal(dia: number, minuto: number): string {
  return `${DIAS_SEMANA[dia]} ${String(Math.floor(minuto / 60)).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')} hs`
}
/** La hora es sugerida: la ocurrencia sigue disponible durante TODO su día. */
export function ocurrenciaSemanal(dia: number, minuto: number, desde: number, noAntesDe = 0): Date {
  const base = Math.max(desde, noAntesDe)
  const c = obtenerComponentesArgentina(base)
  const salto = (dia - c.diaSemana + 7) % 7
  let fecha = crearDateArgentina(c.anio, c.mes, c.diaMes + salto, Math.floor(minuto / 60), minuto % 60)
  if (fecha.getTime() < noAntesDe) fecha = new Date(fecha.getTime() + 7 * DIA_MS)
  return fecha
}
/** El intervalo se cuenta desde el envío real, sin volver a esperar el día habitual de compra. */
export function siguienteHorario(enviadoMs: number, dias: number, diasAbiertos: number[]) {
  const piso = enviadoMs + diasEntreToques(dias) * DIA_MS
  const c = obtenerComponentesArgentina(piso)
  const minuto = Math.min(21 * 60 + 59, Math.max(11 * 60, c.hora * 60 + c.minutos + 1))
  let dueDate = crearDateArgentina(c.anio, c.mes, c.diaMes, Math.floor(minuto / 60), minuto % 60)
  const abiertos = diasAbiertos.length ? diasAbiertos : [0, 1, 2, 3, 4, 5, 6]
  while (dueDate.getTime() < piso || !abiertos.includes(obtenerComponentesArgentina(dueDate.getTime()).diaSemana)) {
    dueDate = new Date(dueDate.getTime() + DIA_MS)
  }
  return { dueDate, diaSemana: obtenerComponentesArgentina(dueDate.getTime()).diaSemana, minutoDia: minuto }
}
export function textoInvitacionDia(segmento: string, dia: number): string {
  const inicio = segmento === 'vip'
    ? '¡Hola {nombre}! Sos de quienes siempre eligen {local} y hoy queríamos invitarte especialmente.'
    : '¡Hola {nombre}! ¿Te tentás con {favorito} de {local}?'
  return `${inicio} Este ${DIAS_SEMANA[dia].toLowerCase()} te esperamos para darte un gusto. Pedí acá: {link}`
}
export function ordenarOportunidades<T extends { clienteId: number; segmentoCliente?: string; fechasPedidosMs: number[]; totalGastado: number; cantidadPedidos: number }>(clientes: T[], dia: number): T[] {
  const afinidad = (c: T) => c.fechasPedidosMs.filter(f => obtenerComponentesArgentina(f).diaSemana === dia).length / Math.max(1, c.cantidadPedidos)
  return [...clientes].sort((a, b) => afinidad(b) - afinidad(a)
    || Number(b.segmentoCliente === 'vip') - Number(a.segmentoCliente === 'vip')
    || b.totalGastado / Math.max(1, b.cantidadPedidos) - a.totalGastado / Math.max(1, a.cantidadPedidos)
    || a.clienteId - b.clienteId)
}
