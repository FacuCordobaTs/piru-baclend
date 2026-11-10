/**
 * Dominio puro de las zonas especiales (countries y barrios cerrados).
 *
 * Una zona especial no es un polígono: es un punto de entrega con nombre, días
 * de reparto (por ejemplo sólo miércoles) y una ventana horaria en la que se
 * aceptan pre-pedidos (por ejemplo 10:00–16:00). El horario de entrega no se
 * fija: el local avisa por WhatsApp cuando está en camino. La zona sólo se
 * ofrece en sus días de reparto. El servidor es la fuente de verdad: el
 * checkout muestra lo que este módulo calcula.
 */

export interface HorarioZonaEspecial {
  horaInicio: string
  horaFin: string
  /** Días de reparto como "0,3" (0 = domingo, igual que Date#getDay). Vacío = todos. */
  diasReparto?: string | null
}

export const TODOS_LOS_DIAS = [0, 1, 2, 3, 4, 5, 6]

/** "3,0,3" → [0, 3]. Un valor vacío o inválido equivale a todos los días. */
export function parsearDiasReparto(valor: string | null | undefined): number[] {
  const dias = [...new Set(
    (valor ?? '').split(',').filter((d) => d.trim() !== '').map((d) => Number(d.trim())).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
  )].sort((a, b) => a - b)
  return dias.length > 0 ? dias : TODOS_LOS_DIAS
}

export function serializarDiasReparto(dias: number[]): string {
  return parsearDiasReparto(dias.join(',')).join(',')
}

/** ¿Hoy es día de reparto de la zona? Decide si la tienda la muestra. */
export function esDiaDeReparto(horario: HorarioZonaEspecial, ahora: Date = new Date()): boolean {
  return parsearDiasReparto(horario.diasReparto).includes(ahora.getDay())
}

export interface VentanaEntrega {
  /** Inicio de la ventana (hora local del servidor). */
  inicio: Date
  /** Fin de la ventana. Puede caer al día siguiente si cruza medianoche. */
  fin: Date
  /** Fecha local del inicio, en formato YYYY-MM-DD. */
  fecha: string
  esHoy: boolean
  esManana: boolean
  /** "Hoy de 17:00 a 20:00" / "Mañana de 17:00 a 20:00". */
  etiqueta: string
}

const MS_POR_MINUTO = 60_000

/** Convierte "HH:mm" a minutos desde las 00:00. `null` si no es válido. */
export function minutosDeHora(hora: string | null | undefined): number | null {
  if (typeof hora !== 'string') return null
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hora.trim())
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** Normaliza "17:00:00" y "17:00" a "17:00". `null` si no es una hora válida. */
export function normalizarHora(hora: string | null | undefined): string | null {
  const minutos = minutosDeHora(hora?.slice(0, 5))
  if (minutos === null) return null
  return `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`
}

export function horarioValido(horario: HorarioZonaEspecial | null | undefined): boolean {
  return minutosDeHora(horario?.horaInicio) !== null && minutosDeHora(horario?.horaFin) !== null
}

function fechaLocal(fecha: Date): string {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`
}

function esMismoDia(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * Devuelve la ventana vigente si el momento cae dentro, o la próxima en un día
 * de reparto. Soporta ventanas que cruzan medianoche (20:00–00:00, 20:00–02:00).
 */
export function ventanaDeEntrega(
  horario: HorarioZonaEspecial,
  ahora: Date = new Date(),
): VentanaEntrega {
  const inicioMin = minutosDeHora(horario.horaInicio)
  const finMin = minutosDeHora(horario.horaFin)

  if (inicioMin === null || finMin === null) {
    throw new Error('Horario de zona especial inválido')
  }

  // Si el fin es igual o anterior al inicio, la ventana termina al día siguiente.
  const duracion = finMin > inicioMin ? finMin - inicioMin : 24 * 60 - inicioMin + finMin

  // La ventana de ayer cuenta si cruza medianoche y sigue vigente; si no, la
  // primera de hoy en adelante que caiga en un día de reparto y no haya terminado.
  const dias = parsearDiasReparto(horario.diasReparto)
  let inicio: Date | null = null
  for (let offset = -1; offset <= 7 && !inicio; offset++) {
    const candidato = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + offset, 0, inicioMin, 0, 0)
    const finCandidato = new Date(candidato.getTime() + duracion * MS_POR_MINUTO)
    if (dias.includes(candidato.getDay()) && ahora < finCandidato) inicio = candidato
  }
  if (!inicio) throw new Error('Zona especial sin días de reparto')
  const fin = new Date(inicio.getTime() + duracion * MS_POR_MINUTO)

  const manana = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + 1)
  const esHoy = esMismoDia(inicio, ahora)
  const esManana = esMismoDia(inicio, manana)
  const etiqueta = `${esHoy ? 'Hoy' : esManana ? 'Mañana' : inicio.toLocaleDateString('es-AR', { weekday: 'long' })} de ${horario.horaInicio} a ${horario.horaFin}`

  return { inicio, fin, fecha: fechaLocal(inicio), esHoy, esManana, etiqueta }
}

export interface EstadoVentanaZona {
  enVentana: boolean
  ventana: VentanaEntrega
}

export function estadoVentanaZona(
  horario: HorarioZonaEspecial,
  ahora: Date = new Date(),
): EstadoVentanaZona {
  const ventana = ventanaDeEntrega(horario, ahora)
  const enVentana = ahora >= ventana.inicio && ahora < ventana.fin
  return { enVentana, ventana }
}

export type MotivoRechazoZona =
  | 'inactiva'
  | 'horario_invalido'
  | 'fuera_de_ventana'
  | 'local_cerrado'

export interface ResultadoPedidoZona {
  permitido: boolean
  /** Con el local cerrado el pedido entra igual, como pre-pedido. */
  esPreOrden: boolean
  motivo: MotivoRechazoZona | null
  ventana: VentanaEntrega | null
}

/**
 * ¿Se puede crear un pedido para esta zona ahora?
 *
 * - Sólo dentro de la ventana de pre-pedidos de un día de reparto.
 * - Con el local cerrado, además, el local tiene que haber habilitado los
 *   pre-pedidos con el local cerrado.
 */
export function puedePedirZonaEspecial(
  zona: HorarioZonaEspecial & { activa?: boolean | null },
  opciones: {
    ahora?: Date
    pedidosPreOrdenadosHabilitados: boolean
    localCerrado?: boolean
  },
): ResultadoPedidoZona {
  if (zona.activa === false) {
    return { permitido: false, esPreOrden: false, motivo: 'inactiva', ventana: null }
  }
  if (!horarioValido(zona)) {
    return { permitido: false, esPreOrden: false, motivo: 'horario_invalido', ventana: null }
  }

  const ahora = opciones.ahora ?? new Date()
  const { enVentana, ventana } = estadoVentanaZona(zona, ahora)

  if (!enVentana) {
    return { permitido: false, esPreOrden: false, motivo: 'fuera_de_ventana', ventana }
  }
  if (opciones.localCerrado && !opciones.pedidosPreOrdenadosHabilitados) {
    return { permitido: false, esPreOrden: false, motivo: 'local_cerrado', ventana }
  }
  return { permitido: true, esPreOrden: !!opciones.localCerrado, motivo: null, ventana }
}

/** Texto del aviso manual (wa.me) y referencia de la plantilla de Meta. */
export function mensajeLlegadaZona(datos: {
  nombreCliente?: string | null
  nombreZona: string
  nombreLocal?: string | null
}): string {
  const nombre = datos.nombreCliente?.trim()
  const local = datos.nombreLocal?.trim()
  return `${nombre ? `Hola ${nombre}` : 'Hola'}, tu pedido${local ? ` de ${local}` : ''} ya está en la puerta de ${datos.nombreZona} esperándote. ¡Te esperamos!`
}

/** Número listo para `wa.me` (E.164 sin +), o null si no sirve. */
export function telefonoWaMe(telefono: string | null | undefined): string | null {
  const normalizado = (telefono ?? '').replace(/\D/g, '')
  return /^\d{8,15}$/.test(normalizado) ? normalizado : null
}

export function urlWaMe(telefono: string, texto: string): string {
  return `https://api.whatsapp.com/send?phone=${telefono}&text=${encodeURIComponent(texto)}`
}
