import {
  crearDateArgentina,
  obtenerComponentesArgentina,
} from './motor-recompra-patron'

const DIA_MS = 86400000
export const NOMBRES_DIAS = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
]
export interface FranjaDiaFlojo {
  id: string
  nombre: string
  horaInicio: string
  horaFin: string
}
export const FRANJAS_DEFAULT: FranjaDiaFlojo[] = [
  { id: 'mediodia', nombre: 'Mediodía', horaInicio: '11:00', horaFin: '16:00' },
  { id: 'tarde', nombre: 'Tarde', horaInicio: '16:00', horaFin: '19:00' },
  { id: 'noche', nombre: 'Noche', horaInicio: '19:00', horaFin: '06:00' },
]
export interface PedidoDiaFlojo {
  createdAt: Date | string
  total: string | number | null
  pagado: boolean
  estado: string
}
const minutos = (hora: string) =>
  Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3, 5))
export function diaOperativo(fechaMs: number) {
  const hora = obtenerComponentesArgentina(fechaMs)
  return {
    ...obtenerComponentesArgentina(fechaMs - (hora.hora < 6 ? DIA_MS : 0)),
    hora: hora.hora,
    minutos: hora.minutos,
  }
}
export function calcularDiasFlojos(
  pedidos: PedidoDiaFlojo[],
  opciones: {
    semanas?: number
    ahora?: number
    franjas?: FranjaDiaFlojo[]
    diasAbiertos?: number[]
  } = {},
) {
  const ahora = opciones.ahora ?? Date.now()
  const semanas = Math.max(1, Math.min(26, Math.trunc(opciones.semanas ?? 8)))
  const hoy = obtenerComponentesArgentina(ahora)
  // Ventana de días completos; cada día de la semana aparece exactamente N veces.
  const hastaMs = crearDateArgentina(hoy.anio, hoy.mes, hoy.diaMes, 0).getTime()
  const desdeMs = hastaMs - semanas * 7 * DIA_MS
  const franjas = opciones.franjas?.length ? opciones.franjas : FRANJAS_DEFAULT
  const abiertos = new Set(opciones.diasAbiertos ?? [0, 1, 2, 3, 4, 5, 6])
  const dias = NOMBRES_DIAS.map((nombre, diaSemana) => ({
    diaSemana,
    nombre,
    abierto: abiertos.has(diaSemana),
    pedidosPromedio: 0,
    ventasPromedio: 0,
    franjas: franjas.map((f) => ({
      ...f,
      pedidosPromedio: 0,
      ventasPromedio: 0,
    })),
  }))
  const semanasConPedidos = new Set<number>()
  for (const p of pedidos) {
    const fechaMs = new Date(p.createdAt).getTime()
    if (!Number.isFinite(fechaMs) || p.estado === 'cancelled') continue
    const fecha = diaOperativo(fechaMs)
    const fechaOperativaMs = crearDateArgentina(
      fecha.anio,
      fecha.mes,
      fecha.diaMes,
      0,
    ).getTime()
    if (fechaOperativaMs < desdeMs || fechaOperativaMs >= hastaMs) continue
    semanasConPedidos.add(
      Math.floor((fechaOperativaMs - desdeMs) / (7 * DIA_MS)),
    )
    const dia = dias[fecha.diaSemana]
    dia.pedidosPromedio += 1 / semanas
    const ventas = p.pagado ? Number(p.total ?? 0) / semanas : 0
    dia.ventasPromedio += Number.isFinite(ventas) ? ventas : 0
    const minuto = fecha.hora * 60 + fecha.minutos
    const franja = dia.franjas.find((f) => {
      const inicio = minutos(f.horaInicio)
      const fin = minutos(f.horaFin)
      return inicio < fin
        ? minuto >= inicio && minuto < fin
        : minuto >= inicio || minuto < fin
    })
    if (franja) {
      franja.pedidosPromedio += 1 / semanas
      franja.ventasPromedio += Number.isFinite(ventas) ? ventas : 0
    }
  }
  const diasAbiertos = dias.filter((d) => d.abierto)
  const promedioDiaAbierto =
    diasAbiertos.reduce((acc, d) => acc + d.pedidosPromedio, 0) /
    (diasAbiertos.length || 1)
  const suficientesDatos = semanasConPedidos.size >= 2
  const flojos: {
    diaSemana: number
    nombre: string
    franja: string | null
    pedidosPromedio: number
    pedidosFaltantes: number
  }[] = []
  if (suficientesDatos)
    for (const d of diasAbiertos) {
      if (d.pedidosPromedio < promedioDiaAbierto * 0.7)
        flojos.push({
          diaSemana: d.diaSemana,
          nombre: d.nombre,
          franja: null,
          pedidosPromedio: d.pedidosPromedio,
          pedidosFaltantes: Math.max(
            0,
            Math.ceil(promedioDiaAbierto - d.pedidosPromedio),
          ),
        })
      for (const f of d.franjas) {
        const promedioFranja =
          diasAbiertos.reduce(
            (acc, otro) =>
              acc +
              (otro.franjas.find((v) => v.id === f.id)?.pedidosPromedio ?? 0),
            0,
          ) / (diasAbiertos.length || 1)
        if (f.pedidosPromedio < promedioFranja * 0.7)
          flojos.push({
            diaSemana: d.diaSemana,
            nombre: `${d.nombre} · ${f.nombre}`,
            franja: f.id,
            pedidosPromedio: f.pedidosPromedio,
            pedidosFaltantes: Math.max(
              0,
              Math.ceil(promedioFranja - f.pedidosPromedio),
            ),
          })
      }
    }
  flojos.sort(
    (a, b) =>
      a.pedidosPromedio - b.pedidosPromedio || a.diaSemana - b.diaSemana,
  )
  return {
    ventana: {
      desde: new Date(desdeMs).toISOString(),
      hasta: new Date(hastaMs).toISOString(),
      semanas,
    },
    franjas,
    dias,
    promedioDiaAbierto,
    flojos,
    suficientesDatos,
    semanasConPedidos: semanasConPedidos.size,
  }
}

export class ErrorProgramacion extends Error {}
export function validarFechaObjetivo(
  fecha: string,
  hora: number | null | undefined,
  diasAbiertos: number[],
  ahora = Date.now(),
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha))
    throw new ErrorProgramacion('La fecha debe tener formato YYYY-MM-DD')
  const [anio, mes, dia] = fecha.split('-').map(Number)
  const horaFinal = hora ?? 18
  if (!Number.isInteger(horaFinal) || horaFinal < 11 || horaFinal > 21)
    throw new ErrorProgramacion('La hora debe estar entre 11 y 21')
  const dueDate = crearDateArgentina(anio, mes - 1, dia, horaFinal)
  const componentes = obtenerComponentesArgentina(dueDate.getTime())
  if (
    componentes.anio !== anio ||
    componentes.mes !== mes - 1 ||
    componentes.diaMes !== dia
  )
    throw new ErrorProgramacion('La fecha no existe')
  const hoy = obtenerComponentesArgentina(ahora)
  const diferencia =
    (crearDateArgentina(anio, mes - 1, dia, 0).getTime() -
      crearDateArgentina(hoy.anio, hoy.mes, hoy.diaMes, 0).getTime()) /
    DIA_MS
  if (diferencia < 1 || diferencia > 14)
    throw new ErrorProgramacion(
      'Elegí una fecha entre mañana y los próximos 14 días',
    )
  if (!diasAbiertos.includes(componentes.diaSemana))
    throw new ErrorProgramacion('El local está cerrado ese día')
  return {
    dueDate,
    diaSemana: componentes.diaSemana,
    hora: horaFinal,
    horarioSugerido: `${NOMBRES_DIAS[componentes.diaSemana]} ${String(horaFinal).padStart(2, '0')}:00 hs (día flojo)`,
  }
}

export function componerMensajeManual(
  plantilla: string,
  variables: Record<
    'nombre' | 'local' | 'favorito' | 'tiempo' | 'beneficio' | 'link',
    string
  >,
) {
  const texto = plantilla.replace(
    /\{(nombre|local|favorito|tiempo|beneficio|link)\}/g,
    (_, clave: keyof typeof variables) => variables[clave],
  )
  return plantilla.includes('{link}') ? texto : `${texto}\n\n${variables.link}`
}
