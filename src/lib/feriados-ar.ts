// Feriados nacionales de Argentina, calculados sin depender de una API externa.
//
// Los feriados inamovibles y los trasladables salen de la Ley 27.399. Carnaval y
// Viernes Santo se derivan de la Pascua, así que se calculan para cualquier año.
// Los "puentes" turísticos y los feriados locales no se pueden inferir de la ley
// (se declaran por decreto cada año), por eso el local los carga a mano en la
// tabla `feriado`; esta lib sólo aporta la base nacional estable.
//
// Todo se maneja como fecha civil `YYYY-MM-DD` en UTC para que el día no cambie
// según la zona horaria del servidor. El día de la semana es el argentino.

const MS_POR_DIA = 86_400_000
const TZ_ARGENTINA = 'America/Argentina/Buenos_Aires'

export interface FeriadoNacional {
  fecha: string
  nombre: string
}

export type TipoDia = 'feriado' | 'fin_de_semana' | 'habil'

const cache = new Map<number, FeriadoNacional[]>()

function aFechaUTC(fecha: string): Date {
  return new Date(`${fecha}T00:00:00Z`)
}

function formatear(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function sumarDias(fecha: string, dias: number): string {
  return formatear(new Date(aFechaUTC(fecha).getTime() + dias * MS_POR_DIA))
}

/**
 * Domingo de Pascua (algoritmo gregoriano anónimo). Devuelve `YYYY-MM-DD`.
 */
export function domingoDePascua(anio: number): string {
  const a = anio % 19
  const b = Math.floor(anio / 100)
  const c = anio % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const mes = Math.floor((h + l - 7 * m + 114) / 31)
  const dia = ((h + l - 7 * m + 114) % 31) + 1
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

/**
 * Feriados trasladables (17/8, 12/10 y 20/11): martes o miércoles pasan al
 * lunes anterior; jueves o viernes, al lunes siguiente. El resto queda igual.
 */
function trasladarAlLunes(fecha: string): string {
  const dia = aFechaUTC(fecha).getUTCDay()
  if (dia === 2) return sumarDias(fecha, -1) // martes → lunes anterior
  if (dia === 3) return sumarDias(fecha, -2) // miércoles → lunes anterior
  if (dia === 4) return sumarDias(fecha, 4) // jueves → lunes siguiente
  if (dia === 5) return sumarDias(fecha, 3) // viernes → lunes siguiente
  return fecha
}

/**
 * Feriados nacionales del año, ordenados por fecha. No incluye puentes ni
 * feriados locales: esos los declara el local.
 */
export function feriadosNacionales(anio: number): FeriadoNacional[] {
  const guardado = cache.get(anio)
  if (guardado) return guardado

  const pascua = domingoDePascua(anio)
  const lista: FeriadoNacional[] = [
    { fecha: `${anio}-01-01`, nombre: 'Año Nuevo' },
    { fecha: sumarDias(pascua, -48), nombre: 'Carnaval' },
    { fecha: sumarDias(pascua, -47), nombre: 'Carnaval' },
    { fecha: `${anio}-03-24`, nombre: 'Día Nacional de la Memoria por la Verdad y la Justicia' },
    { fecha: `${anio}-04-02`, nombre: 'Día del Veterano y de los Caídos en la Guerra de Malvinas' },
    { fecha: sumarDias(pascua, -2), nombre: 'Viernes Santo' },
    { fecha: `${anio}-05-01`, nombre: 'Día del Trabajador' },
    { fecha: `${anio}-05-25`, nombre: 'Día de la Revolución de Mayo' },
    { fecha: `${anio}-06-20`, nombre: 'Paso a la Inmortalidad del General Manuel Belgrano' },
    { fecha: `${anio}-07-09`, nombre: 'Día de la Independencia' },
    { fecha: trasladarAlLunes(`${anio}-08-17`), nombre: 'Paso a la Inmortalidad del General José de San Martín' },
    { fecha: trasladarAlLunes(`${anio}-10-12`), nombre: 'Día del Respeto a la Diversidad Cultural' },
    { fecha: trasladarAlLunes(`${anio}-11-20`), nombre: 'Día de la Soberanía Nacional' },
    { fecha: `${anio}-12-08`, nombre: 'Inmaculada Concepción de María' },
    { fecha: `${anio}-12-25`, nombre: 'Navidad' },
  ]

  // Deduplicar por si un traslado cae sobre otro feriado y ordenar.
  const porFecha = new Map<string, FeriadoNacional>()
  for (const feriado of lista) {
    if (!porFecha.has(feriado.fecha)) porFecha.set(feriado.fecha, feriado)
  }
  const ordenada = [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha))
  cache.set(anio, ordenada)
  return ordenada
}

/** `YYYY-MM-DD` válido (existe en el calendario y no se normaliza). */
export function esFechaISO(fecha: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false
  const d = aFechaUTC(fecha)
  return !Number.isNaN(d.getTime()) && formatear(d) === fecha
}

export function esFeriadoNacional(fecha: string): boolean {
  const anio = Number(fecha.slice(0, 4))
  if (!Number.isInteger(anio)) return false
  return feriadosNacionales(anio).some((feriado) => feriado.fecha === fecha)
}

/**
 * Tipo de día para liquidar al cadete. `feriados` son los feriados propios del
 * local (puentes, feriados locales); los nacionales se suman acá.
 * Un feriado tiene prioridad sobre el fin de semana.
 */
export function tipoDeDia(fecha: string, feriados: ReadonlySet<string> = new Set()): TipoDia {
  if (feriados.has(fecha) || esFeriadoNacional(fecha)) return 'feriado'
  const dia = aFechaUTC(fecha).getUTCDay()
  return dia === 0 || dia === 6 ? 'fin_de_semana' : 'habil'
}

/** Año civil en Argentina (el servidor puede correr en UTC). */
export function anioArgentina(ahora: Date = new Date()): number {
  const formato = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_ARGENTINA, year: 'numeric' })
  return Number(formato.format(ahora))
}
