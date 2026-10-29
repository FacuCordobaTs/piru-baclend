/**
 * Dominio puro de las zonas especiales (countries y barrios cerrados).
 *
 * Una zona especial no es un polígono: es un punto de entrega con nombre y una
 * ventana horaria fija (por ejemplo 17:00–20:00). Si el pedido se arma fuera de
 * la ventana, se entrega en la próxima y sólo si el local habilitó los
 * pre-pedidos. El servidor es la fuente de verdad: el checkout muestra lo que
 * este módulo calcula.
 */

export interface HorarioZonaEspecial {
  horaInicio: string
  horaFin: string
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
 * Devuelve la ventana vigente si el momento cae dentro, o la próxima si ya pasó.
 * Soporta ventanas que cruzan medianoche (20:00–00:00, 20:00–02:00).
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

  const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 0, inicioMin, 0, 0)
  const finHoy = new Date(inicioHoy.getTime() + duracion * MS_POR_MINUTO)
  const inicioAyer = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - 1, 0, inicioMin, 0, 0)
  const finAyer = new Date(inicioAyer.getTime() + duracion * MS_POR_MINUTO)

  let inicio = inicioHoy
  if (ahora >= inicioAyer && ahora < finAyer) {
    // Ventana nocturna que empezó ayer y todavía está vigente (ej. 20:00–02:00).
    inicio = inicioAyer
  } else if (ahora >= finHoy) {
    inicio = new Date(inicioHoy)
    inicio.setDate(inicio.getDate() + 1)
  }
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

export interface ResultadoPedidoZona {
  permitido: boolean
  esPreOrden: boolean
  motivo: MotivoRechazoZona | null
  ventana: VentanaEntrega | null
}

/**
 * ¿Se puede crear un pedido para esta zona ahora?
 *
 * - Durante la ventana se puede pedir siempre (salvo que el local esté cerrado).
 * - Fuera de la ventana, o con el local cerrado, sólo con pre-pedidos habilitados;
 *   en ese caso el pedido se entrega en la próxima ventana.
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
  const abiertoAhora = !opciones.localCerrado && enVentana

  if (abiertoAhora) {
    return { permitido: true, esPreOrden: false, motivo: null, ventana }
  }
  if (opciones.pedidosPreOrdenadosHabilitados) {
    return { permitido: true, esPreOrden: true, motivo: null, ventana }
  }
  return { permitido: false, esPreOrden: false, motivo: 'fuera_de_ventana', ventana }
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
