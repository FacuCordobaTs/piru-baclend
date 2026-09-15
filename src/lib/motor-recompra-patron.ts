// src/lib/motor-recompra-patron.ts
//
// Detección de hábitos temporales (día habitual y franja horaria) de clientes
// y planificación inteligente del momento óptimo de envío para el Motor de Recompra.
//
// Reglas de negocio:
//   1) Clientes habituales (en_riesgo, dormido): se detecta su día de la semana y
//      hora más frecuente (ej. Clari pide viernes a las 21:00 hs -> Viernes 21:00 hs habitual).
//   2) Clientes de primer pedido: se toma el día y hora de su 1º pedido previo (según 1º pedido).
//   3) Clientes perdidos: llevan meses sin pedir; se planifican en DÍAS VALLE de baja demanda
//      (Lunes, Martes, Miércoles) para no saturar la cocina los días pico (Jueves a Domingo).
//   4) Horario de silencio: los envíos respetan siempre la ventana 22:00 a 09:00 ART (acotado a máx 21:00).

export interface PatronEnvioCliente {
  diaSemana: number // 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
  hora: number // 11 .. 21
  dueDate: Date
  horarioSugerido: string
}

const NOMBRES_DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

// Días de baja demanda gastronómica (días valle)
const DIAS_VALLE = [1, 2, 3] // Lunes, Martes, Miércoles

const MS_HORA = 60 * 60 * 1000
const MS_DIA = 24 * MS_HORA

/** Convierte una marca de tiempo UTC a los componentes locales de Argentina (UTC-3) */
export function obtenerComponentesArgentina(fechaMs: number): {
  diaSemana: number
  hora: number
  minutos: number
  anio: number
  mes: number
  diaMes: number
} {
  // Argentina está en UTC-3 fijo todo el año sin horario de verano
  const argDate = new Date(fechaMs - 3 * MS_HORA)
  return {
    diaSemana: argDate.getUTCDay(),
    hora: argDate.getUTCHours(),
    minutos: argDate.getUTCMinutes(),
    anio: argDate.getUTCFullYear(),
    mes: argDate.getUTCMonth(),
    diaMes: argDate.getUTCDate(),
  }
}

/** Construye una fecha Date dada una fecha/hora local de Argentina */
export function crearDateArgentina(
  anio: number,
  mes: number,
  diaMes: number,
  hora: number,
  minutos: number = 0,
): Date {
  // En UTC, la hora local de Argentina es hora + 3
  return new Date(Date.UTC(anio, mes, diaMes, hora + 3, minutos, 0, 0))
}

/**
 * Analiza el historial de pedidos y determina el momento óptimo de despacho.
 */
export function calcularPatronEnvio(
  fechasPedidosMs: number[],
  segmento: string,
  ahoraMs: number = Date.now(),
  clienteId: number = 0,
): PatronEnvioCliente {
  const ahoraArg = obtenerComponentesArgentina(ahoraMs)

  // 1. Detección de frecuencias de días y horas
  const conteoDias = new Array(7).fill(0)
  const conteoHoras = new Array(24).fill(0)

  for (const fMs of fechasPedidosMs) {
    const comp = obtenerComponentesArgentina(fMs)
    conteoDias[comp.diaSemana]++
    conteoHoras[comp.hora]++
  }

  // Día más frecuente (desempate: el día del pedido más reciente)
  let diaFavorito = -1
  let maxDiaCount = 0
  for (let d = 0; d < 7; d++) {
    if (conteoDias[d] > maxDiaCount) {
      maxDiaCount = conteoDias[d]
      diaFavorito = d
    }
  }

  // Hora más frecuente
  let horaFavorita = -1
  let maxHoraCount = 0
  for (let h = 0; h < 24; h++) {
    if (conteoHoras[h] > maxHoraCount) {
      maxHoraCount = conteoHoras[h]
      horaFavorita = h
    }
  }

  // Si no hay historial o pedidos válidos, defaults razonables
  if (diaFavorito === -1) {
    diaFavorito = 5 // Viernes por defecto
  }
  if (horaFavorita === -1) {
    horaFavorita = 20 // 20:00 hs por defecto
  }

  // Acotar la hora a la ventana permitida (no molestar de 22:00 a 09:00; entre 11 y 21)
  const horaValida = Math.min(21, Math.max(11, horaFavorita))

  let targetDiaSemana: number
  let targetHora: number
  let sufijoEtiqueta: string

  const esPerdido = segmento === 'perdido'
  const esPrimerPedido = segmento === 'primer_pedido' || (segmento === 'nuevo' && fechasPedidosMs.length <= 1)

  if (esPerdido) {
    // Para perdidos: programar en días valle (Lunes, Martes, Miércoles) para repartir carga
    const valleIndex = Math.abs(clienteId) % DIAS_VALLE.length
    targetDiaSemana = DIAS_VALLE[valleIndex]
    // Usar la hora preferida del cliente si es cena/almuerzo, o 20:00 hs por defecto
    targetHora = horaValida >= 18 ? horaValida : (horaValida <= 14 ? horaValida : 20)
    sufijoEtiqueta = 'día valle'
  } else if (esPrimerPedido) {
    targetDiaSemana = diaFavorito
    targetHora = horaValida
    sufijoEtiqueta = 'según 1º pedido'
  } else {
    // Habituales: en_riesgo, dormido
    targetDiaSemana = diaFavorito
    targetHora = horaValida
    sufijoEtiqueta = 'habitual'
  }

  // 2. Calcular la próxima fecha del targetDiaSemana a las targetHora:00
  let diasHastaTarget = (targetDiaSemana - ahoraArg.diaSemana + 7) % 7

  // Si el target es hoy:
  if (diasHastaTarget === 0) {
    // Si ya pasó la hora objetivo hoy, pasar a la próxima semana
    if (ahoraArg.hora > targetHora || (ahoraArg.hora === targetHora && ahoraArg.minutos > 0)) {
      diasHastaTarget = 7
    }
  }

  // Construir la fecha objetivo sumando los días necesarios
  const targetMs = ahoraMs + diasHastaTarget * MS_DIA
  const targetArg = obtenerComponentesArgentina(targetMs)
  const dueDate = crearDateArgentina(targetArg.anio, targetArg.mes, targetArg.diaMes, targetHora, 0)

  const nombreDia = NOMBRES_DIAS[targetDiaSemana]
  const horaTexto = `${targetHora.toString().padStart(2, '0')}:00 hs`
  const horarioSugerido = `${nombreDia} ${horaTexto} (${sufijoEtiqueta})`

  return {
    diaSemana: targetDiaSemana,
    hora: targetHora,
    dueDate,
    horarioSugerido,
  }
}
