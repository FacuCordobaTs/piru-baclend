// src/lib/motor-recompra.ts
//
// Motor de Recompra · PROGRAMACIONES (el dueño decide; el motor ejecuta lo programado).
//
// Rediseño: el motor deja de ser un goteo permanente que se agenda solo y pasa a ser un EJECUTOR de
// tandas que el dueño programa. Tres piezas separadas:
//   1) DECISIÓN — humana, cada vez: el dueño programa una tanda desde la pantalla (`programarEnvios`).
//   2) EJECUCIÓN — automática: el tick drena lo que ya está agendado (`procesarColaDelLocal`).
//   3) RENDICIÓN — visible siempre: consumo junto a retorno (`estadoMotor` → dashboard).
//
// La consecuencia central: **sin una programación no hay NADA agendado**. El motor ya no detecta
// clientes nuevos por su cuenta; lo único que puede agregar filas a la cola es `programarEnvios`
// (el toque 1 de una tanda) y `programarToqueSiguiente` (los toques 2 y 3 de esa misma tanda).
//
// Anti-patrones prohibidos que este módulo respeta:
//   ❌ batch masivo (se gotea al cupo diario, tope duro de sistema para proteger el número ante Meta)
//   ❌ botón diario de "avanzar" (el drenaje es automático; el dueño programa, no despacha fila por fila)
//   ❌ mendigar recarga / cortar en silencio (marketing en 0 → pausada_sin_saldo con aviso único)
//   ❌ agendar sin que nadie lo haya pedido (el goteo permanente ya no existe)
//
// Reusa el mismo cerebro (RFM), escalera, cupón, deep link, protección de la base y consumo del
// wallet que el envío individual (4.2): `enviarRecuperoDormido` es el único camino de envío.

import { type MySql2Database } from 'drizzle-orm/mysql2'
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, notInArray, or, sql } from 'drizzle-orm'
import {
  cliente as ClienteTable,
  restaurante as RestauranteTable,
  pedidoUnificado as PedidoUnificadoTable,
  campanaRecompra as CampanaRecompraTable,
  colaRecompra as ColaRecompraTable,
  configMotorRecompra as ConfigMotorRecompraTable,
  recuperoCliente as RecuperoClienteTable,
} from '../db/schema'
import {
  cargarCohorteRecompra,
  cargarToquesPorCliente,
  COOLDOWN_HORAS,
  estadoRecupero,
  enviarRecuperoDormido,
  esSegmentoRecompra,
  normalizarToque,
  prepararMensajeRecupero,
  PLANTILLA_RECUPERO_WHATSAPP,
  SEGMENTOS_RECUPERABLES,
  type ClienteCohorte,
  type DatosMensajeRecupero,
  type OpcionesEnvioRecupero,
  type SegmentoRecompra,
  type ToqueRecompra,
} from './recupero'
import {
  arranqueDeRecontactoConIntervalo,
  diasEntreToques,
  DIAS_ENTRE_TOQUES_MIN,
  dueDateDeRecontactoConIntervalo,
} from './recompra-goteo'
import {
  CANTIDAD_MAX,
  CANTIDAD_MIN,
  filtrarPorSegmento,
  normalizarEspecificacion,
  ordenarPorPrioridad,
  PORCENTAJE_CONTROL_DEFAULT,
  PORCENTAJE_CONTROL_MAX,
  PORCENTAJE_CONTROL_MIN,
  programarToqueSiguiente,
  seleccionarCandidatos,
  ticketDeCliente,
  type EspecificacionNormalizada,
  type EspecificacionProgramacion,
} from './recompra-programacion'
import { enHorarioSilencio, horaArgentina, TOPE_MARKETING_POR_CLIENTE } from './proteccion-base'
import { crearRecargaPendiente, resumenWallet } from './mensajes-wallet'
import { MODULE_KEYS, tieneModuloActivo } from './modulos'
import type { SegmentoCliente } from './clientes-rfm'
import { calcularPrioridadStock } from './motor-recompra-prioridad'
import { calcularPatronEnvio } from './motor-recompra-patron'
import { sendSaldoBajoWhatsApp } from '../services/whatsapp'

type Db = MySql2Database<Record<string, never>>

// ── Config del goteo ─────────────────────────────────────────────────────────
/** Cupo diario por defecto: warm-up del número + cocina sin picos. Se comunica como feature. */
export const CUPO_DIARIO_DEFAULT = 30
/** Mínimo razonable (un motor que gotea 2/día no drena nunca). */
export const CUPO_DIARIO_MIN = 5
/** Tope DURO de sistema: aunque el dueño ansioso lo suba, nunca se pasa de acá (protege el número). */
export const CUPO_DIARIO_MAX = 60
/** Días entre recordatorios cuando el motor está pausado por saldo (1/semana, nunca súplica diaria). */
export const RECORDATORIO_SIN_SALDO_DIAS = 7

/** Estado del motor para el local entero. La pausa es del local: pausa todo su goteo. */
export type EstadoMotorLocal = 'activa' | 'pausada_sin_saldo' | 'pausada_manual'
/** Estado de una tanda. `cancelada` no es procesable y sus pendientes ya salieron de la cola. */
export type EstadoCampana = 'activa' | 'completada' | 'pausada_sin_saldo' | 'pausada_manual' | 'cancelada'
export type ModoCampana = 'automatico' | 'manual'
export type OrigenCampana = 'goteo' | 'programada'

const MS_POR_DIA = 1000 * 60 * 60 * 24
const ART_OFFSET_MS = 3 * 60 * 60 * 1000

// Contexto mínimo para `env()` de Hono cuando el envío corre fuera de un request (job/scheduler).
const fakeCtx = { env: process.env } as any

/** Día de Argentina (UTC-3) como "YYYY-MM-DD" — clave estable para el cupo diario. */
function diaArgentina(ahora: number = Date.now()): string {
  return new Date(ahora - ART_OFFSET_MS).toISOString().slice(0, 10)
}

/** Instante (ms) en que empezó el día de Argentina en curso: el piso del cupo diario. */
function inicioDiaArgentina(ahora: number): number {
  return Date.parse(`${diaArgentina(ahora)}T00:00:00.000Z`) + ART_OFFSET_MS
}

function clampCupo(n: number): number {
  if (!Number.isFinite(n)) return CUPO_DIARIO_DEFAULT
  return Math.max(CUPO_DIARIO_MIN, Math.min(CUPO_DIARIO_MAX, Math.round(n)))
}

function clampPorcentajeControl(n: number): number {
  if (!Number.isFinite(n)) return PORCENTAJE_CONTROL_DEFAULT
  return Math.max(PORCENTAJE_CONTROL_MIN, Math.min(PORCENTAJE_CONTROL_MAX, Math.round(n)))
}

/** true si la tanda procesa envíos (una tanda `completada` sigue drenando lo que le quede). */
function esProcesable(estado: string | null): boolean {
  return estado === 'activa' || estado === 'completada'
}

function esDuplicado(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.code === 'ER_DUP_ENTRY' || e?.cause?.code === 'ER_DUP_ENTRY'
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null
}

// ── Configuración del local ──────────────────────────────────────────────────
export interface ConfigMotorData {
  id?: number
  restauranteId: number
  estado: EstadoMotorLocal
  modo: ModoCampana
  cupoDiario: number
  diasToque2: number
  diasToque3: number
  porcentajeControl: number
  ultimoDrenajeDia: string | null
  avisoSinSaldoAt: Date | null
}

/** Sin fila en la base se devuelven estos: ningún local necesita backfill para funcionar. */
export const CONFIG_MOTOR_DEFAULT: Omit<ConfigMotorData, 'restauranteId'> = {
  estado: 'activa',
  modo: 'automatico',
  cupoDiario: CUPO_DIARIO_DEFAULT,
  diasToque2: DIAS_ENTRE_TOQUES_MIN,
  diasToque3: DIAS_ENTRE_TOQUES_MIN,
  porcentajeControl: PORCENTAJE_CONTROL_DEFAULT,
  ultimoDrenajeDia: null,
  avisoSinSaldoAt: null,
}

function normalizarEstadoLocal(estado: string | null): EstadoMotorLocal {
  return estado === 'pausada_manual' || estado === 'pausada_sin_saldo' ? estado : 'activa'
}

/** Lee la config del motor del local. Nunca escribe: leer no muta. */
export async function obtenerConfigMotor(db: Db, restauranteId: number): Promise<ConfigMotorData> {
  const [row] = await db
    .select()
    .from(ConfigMotorRecompraTable)
    .where(eq(ConfigMotorRecompraTable.restauranteId, restauranteId))
    .limit(1)
  if (!row) return { ...CONFIG_MOTOR_DEFAULT, restauranteId }
  return {
    id: row.id,
    restauranteId: row.restauranteId,
    estado: normalizarEstadoLocal(row.estado),
    modo: row.modo === 'manual' ? 'manual' : 'automatico',
    cupoDiario: clampCupo(row.cupoDiario),
    // Los días guardados pasan por el piso anti-spam al leerse: aunque alguien edite la base a mano,
    // el motor nunca va a espaciar dos toques menos de 48 hs.
    diasToque2: diasEntreToques(row.diasToque2),
    diasToque3: diasEntreToques(row.diasToque3),
    porcentajeControl: clampPorcentajeControl(row.porcentajeControl),
    ultimoDrenajeDia: row.ultimoDrenajeDia ?? null,
    avisoSinSaldoAt: row.avisoSinSaldoAt ? new Date(row.avisoSinSaldoAt) : null,
  }
}

/** Merge parcial + upsert. Mismo contrato que `guardarConfiguracionPuntos`. */
export async function guardarConfigMotor(
  db: Db,
  restauranteId: number,
  partial: Partial<Omit<ConfigMotorData, 'id' | 'restauranteId'>>,
): Promise<ConfigMotorData> {
  const limpio: Record<string, unknown> = {}
  if (partial.estado !== undefined) limpio.estado = normalizarEstadoLocal(partial.estado)
  if (partial.modo !== undefined) limpio.modo = partial.modo === 'manual' ? 'manual' : 'automatico'
  if (partial.cupoDiario !== undefined) limpio.cupoDiario = clampCupo(partial.cupoDiario)
  if (partial.diasToque2 !== undefined) limpio.diasToque2 = diasEntreToques(partial.diasToque2)
  if (partial.diasToque3 !== undefined) limpio.diasToque3 = diasEntreToques(partial.diasToque3)
  if (partial.porcentajeControl !== undefined) limpio.porcentajeControl = clampPorcentajeControl(partial.porcentajeControl)
  if (partial.ultimoDrenajeDia !== undefined) limpio.ultimoDrenajeDia = partial.ultimoDrenajeDia
  if (partial.avisoSinSaldoAt !== undefined) limpio.avisoSinSaldoAt = partial.avisoSinSaldoAt

  const [existente] = await db
    .select({ id: ConfigMotorRecompraTable.id })
    .from(ConfigMotorRecompraTable)
    .where(eq(ConfigMotorRecompraTable.restauranteId, restauranteId))
    .limit(1)

  if (existente) {
    if (Object.keys(limpio).length > 0) {
      await db
        .update(ConfigMotorRecompraTable)
        .set(limpio as any)
        .where(eq(ConfigMotorRecompraTable.restauranteId, restauranteId))
    }
  } else {
    await db
      .insert(ConfigMotorRecompraTable)
      .values({ ...CONFIG_MOTOR_DEFAULT, ...limpio, restauranteId } as any)
  }
  return obtenerConfigMotor(db, restauranteId)
}

// ── Programaciones del local ─────────────────────────────────────────────────
export type CampanaRow = typeof CampanaRecompraTable.$inferSelect

/** Las tandas que todavía pueden drenar filas (incluye las que están terminando de vaciarse). */
export async function getProgramacionesVivas(db: Db, restauranteId: number): Promise<CampanaRow[]> {
  return db
    .select()
    .from(CampanaRecompraTable)
    .where(
      and(
        eq(CampanaRecompraTable.restauranteId, restauranteId),
        inArray(CampanaRecompraTable.estado, ['activa', 'completada']),
      ),
    )
    .orderBy(asc(CampanaRecompraTable.id))
}

/** Todas las tandas del local, vivas o cerradas, de la más nueva a la más vieja. */
export async function getProgramaciones(db: Db, restauranteId: number, limite = 20): Promise<CampanaRow[]> {
  return db
    .select()
    .from(CampanaRecompraTable)
    .where(
      and(
        eq(CampanaRecompraTable.restauranteId, restauranteId),
        inArray(CampanaRecompraTable.estado, ['activa', 'completada', 'cancelada']),
      ),
    )
    .orderBy(desc(CampanaRecompraTable.id))
    .limit(Math.max(1, Math.min(50, limite)))
}

/**
 * Clientes que ya están COMPROMETIDOS en alguna tanda viva del local.
 *
 * Es la protección que el índice único no puede dar: `uq_cola_recompra_toque` es (campaña, cliente,
 * toque), así que dos tandas distintas podrían programar al mismo cliente y mandarle el mismo toque
 * dos veces. Como ahora el dueño puede programar varias tandas seguidas sobre la misma base, la
 * exclusión tiene que ser explícita.
 *
 * Bloquean las filas `pendiente` (va a salir), `enviado` (está en el goteo de esa tanda) y `control`
 * (está en el experimento: contactarlo rompería la atribución honesta). `salido` y `fallido` NO
 * bloquean: en esos casos el cliente quedó libre.
 */
export async function clientesYaEnTanda(db: Db, restauranteId: number): Promise<Set<number>> {
  const filas = await db
    .select({ clienteId: ColaRecompraTable.clienteId })
    .from(ColaRecompraTable)
    .innerJoin(CampanaRecompraTable, eq(CampanaRecompraTable.id, ColaRecompraTable.campanaId))
    .where(
      and(
        eq(ColaRecompraTable.restauranteId, restauranteId),
        inArray(ColaRecompraTable.estado, ['pendiente', 'enviado', 'control']),
        inArray(CampanaRecompraTable.estado, ['activa', 'completada']),
      ),
    )
  return new Set(filas.map((f) => f.clienteId))
}

function snapshot(cl: ClienteCohorte) {
  return {
    totalGastadoSnapshot: cl.totalGastado.toFixed(2),
    ultimoPedidoMs: cl.ultimoPedidoMs != null ? new Date(cl.ultimoPedidoMs) : null,
  }
}

/** Fila de `cola_recompra` lista para insertar. Centraliza el mapeo cohorte → cola. */
function filaDeCola(
  restauranteId: number,
  campanaId: number,
  cl: ClienteCohorte,
  extra: {
    poblacion: 'flujo' | 'stock'
    rol: 'contactado' | 'control'
    estado: string
    toque: number | null
    dueDate: Date | null
    horarioSugerido?: string | null
  },
) {
  return {
    restauranteId,
    campanaId,
    clienteId: cl.clienteId,
    telefono: cl.telefono,
    segmento: cl.segmento,
    prioridad: calcularPrioridadStock(cl.segmento, ticketDeCliente(cl)).toFixed(2),
    poblacion: extra.poblacion,
    rol: extra.rol,
    estado: extra.estado,
    toque: extra.toque,
    dueDate: extra.dueDate,
    horarioSugerido: extra.horarioSugerido ?? null,
    totalGastadoSnapshot: cl.totalGastado.toFixed(2),
    ultimoPedidoAtSnapshot: cl.ultimoPedidoMs != null ? new Date(cl.ultimoPedidoMs) : null,
  }
}

// ── PREVIEW: el universo del asistente de programación ───────────────────────
export interface CandidatoLote {
  clienteId: number
  nombre: string
  telefono: string
  segmento: SegmentoRecompra
  diasDesdeUltimo: number | null
  totalGastado: number
  ticketPromedio: number
  /** Toques que ya recibió DESPUÉS de su último pedido (el avance de su escalera). */
  toquesDesdeUltimoPedido: number
  proximoNivel: number
  /** El día y la hora en que le tocaría salir si se lo programa ahora. */
  horarioSugerido: string
  dueDate: string
  /** false = ya está comprometido en otra tanda viva; la UI lo muestra y no lo deja elegir. */
  elegible: boolean
}

export interface PreviewProgramacion {
  segmento: SegmentoRecompra | null
  /** Los mejores candidatos en orden de prioridad (el universo del paso 2 del asistente). */
  candidatos: CandidatoLote[]
  /** Ids que se apartarían como grupo de control si se programara así. */
  controlSugerido: number[]
  /** Coincidencias de `buscar` en TODA la cohorte, para poder agregar a alguien puntual. */
  busqueda: CandidatoLote[]
  resumen: {
    porSegmento: { segmento: SegmentoRecompra; elegibles: number; facturacionEnJuego: number }[]
    totalElegibles: number
    totalEnTanda: number
    cantidad: number
    cantidadMin: number
    cantidadMax: number
    cupoDiario: number
    enviadosHoy: number
    cupoRestanteHoy: number
    saldoMarketing: number
    modo: ModoCampana
    diasToque2: number
    diasToque3: number
    diasMinEntreToques: number
    porcentajeControl: number
    horarioSilencio: boolean
  }
}

function candidatoDeCohorte(cl: ClienteCohorte, elegible: boolean, ahora: number): CandidatoLote {
  const patron = calcularPatronEnvio(cl.fechasPedidosMs ?? [], cl.segmento, ahora, cl.clienteId)
  return {
    clienteId: cl.clienteId,
    nombre: cl.nombre,
    telefono: cl.telefono,
    segmento: cl.segmento,
    diasDesdeUltimo: cl.diasDesdeUltimo,
    totalGastado: cl.totalGastado,
    ticketPromedio: ticketDeCliente(cl),
    toquesDesdeUltimoPedido: cl.toquesDesdeUltimoPedido,
    proximoNivel: cl.proximoNivel,
    horarioSugerido: patron.horarioSugerido,
    dueDate: patron.dueDate.toISOString(),
    elegible,
  }
}

/**
 * Arma el universo del asistente: quiénes pueden entrar a una tanda nueva, en el orden en que el
 * motor los elegiría, con el día y la hora que les tocaría. NO escribe nada.
 */
export async function previewProgramacion(
  db: Db,
  restauranteId: number,
  filtros: EspecificacionProgramacion & { buscar?: string | null; limite?: number | null } = {},
): Promise<PreviewProgramacion> {
  const config = await obtenerConfigMotor(db, restauranteId)
  const spec = normalizarEspecificacion(filtros, {
    diasToque2: config.diasToque2,
    diasToque3: config.diasToque3,
    porcentajeControl: config.porcentajeControl,
  })

  const [cohorte, comprometidos, wallet] = await Promise.all([
    cargarCohorteRecompra(db, restauranteId),
    clientesYaEnTanda(db, restauranteId),
    resumenWallet(db, restauranteId),
  ])

  const ahora = Date.now()
  const disponibles = cohorte.filter((cl) => !comprometidos.has(cl.clienteId))
  const ordenados = ordenarPorPrioridad(filtrarPorSegmento(disponibles, spec.segmento))

  // Se devuelven suficientes candidatos para que el paso 2 muestre la lista elegida y, además, de
  // dónde saldría el control. El `limite` nunca baja de 50 para que el asistente tenga con qué jugar.
  const limite = Math.max(50, Math.min(CANTIDAD_MAX, Math.floor(filtros.limite ?? 0) || 0) || spec.cantidad * 2 + 20)
  const candidatos = ordenados.slice(0, limite).map((cl) => candidatoDeCohorte(cl, true, ahora))

  const { control } = seleccionarCandidatos(disponibles, spec)

  const porSegMap: Record<string, { elegibles: number; facturacionEnJuego: number }> = {}
  for (const cl of disponibles) {
    const acc = (porSegMap[cl.segmento] ??= { elegibles: 0, facturacionEnJuego: 0 })
    acc.elegibles++
    acc.facturacionEnJuego += cl.totalGastado
  }

  const enviadosHoy = await contarEnviadosDelDia(db, restauranteId, ahora)

  const busqueda = (filtros.buscar ?? '').trim()
  const coincidencias = busqueda.length >= 2
    ? buscarEnCohorte(cohorte, comprometidos, busqueda, ahora)
    : []

  return {
    segmento: spec.segmento,
    candidatos,
    controlSugerido: control.map((cl) => cl.clienteId),
    busqueda: coincidencias,
    resumen: {
      porSegmento: SEGMENTOS_RECUPERABLES
        .filter((s) => (porSegMap[s]?.elegibles ?? 0) > 0)
        .map((s) => ({ segmento: s, ...porSegMap[s] })),
      totalElegibles: disponibles.length,
      totalEnTanda: comprometidos.size,
      cantidad: spec.cantidad,
      cantidadMin: CANTIDAD_MIN,
      cantidadMax: CANTIDAD_MAX,
      cupoDiario: config.cupoDiario,
      enviadosHoy,
      cupoRestanteHoy: Math.max(0, config.cupoDiario - enviadosHoy),
      saldoMarketing: wallet.marketing.disponible,
      modo: config.modo,
      diasToque2: spec.diasToque2 ?? config.diasToque2,
      diasToque3: spec.diasToque3 ?? config.diasToque3,
      diasMinEntreToques: DIAS_ENTRE_TOQUES_MIN,
      porcentajeControl: spec.porcentajeControl ?? config.porcentajeControl,
      horarioSilencio: enHorarioSilencio(ahora),
    },
  }
}

/** Búsqueda por nombre o teléfono, sobre TODA la cohorte (no sólo los primeros N de la lista). */
function buscarEnCohorte(
  cohorte: ClienteCohorte[],
  comprometidos: Set<number>,
  termino: string,
  ahora: number,
): CandidatoLote[] {
  const t = termino.toLowerCase()
  const digitos = termino.replace(/\D/g, '')
  return cohorte
    .filter((cl) => {
      if (cl.nombre.toLowerCase().includes(t)) return true
      return digitos.length >= 3 && cl.telefono.replace(/\D/g, '').includes(digitos)
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .slice(0, 20)
    .map((cl) => candidatoDeCohorte(cl, !comprometidos.has(cl.clienteId), ahora))
}

// ── PROGRAMAR: la decisión del dueño convertida en filas agendadas ───────────
export interface ResultadoProgramacion {
  ok: boolean
  moduloNoDisponible?: boolean
  vacio?: boolean
  campanaId?: number
  /** Clientes que van a recibir los toques (= N, salvo que la base no alcanzara). */
  cantidad: number
  /** Clientes apartados como grupo de control (no gastan cupo ni reciben toques). */
  control: number
  /** Filas de cola creadas (contactados + control). */
  filasCreadas: number
  /** Ids pedidos a mano que no entraron, con el motivo. */
  omitidos: { clienteId: number; motivo: 'no_elegible' | 'ya_en_tanda' | 'excluido' }[]
  porSegmento: { segmento: SegmentoRecompra; contactar: number; control: number }[]
  /** Primer día/hora en que sale algo de esta tanda. */
  primerDespachoAt: string | null
  cupoDiario: number
  diasToque2: number
  diasToque3: number
  porcentajeControl: number
  toqueHasta: number
}

/**
 * Crea una tanda: selecciona a quiénes, aparta el control y **deja las filas agendadas**.
 *
 * No manda nada. El envío lo hace el tick cuando cada fila cumple su `dueDate`, respetando el cupo
 * del local y el horario de silencio. Que programar no envíe es lo que hace que el dueño pueda
 * programar tranquilo y siga siendo él quien decide cuándo arranca el goteo.
 */
export async function programarEnvios(
  db: Db,
  restauranteId: number,
  input: EspecificacionProgramacion,
): Promise<ResultadoProgramacion> {
  const config = await obtenerConfigMotor(db, restauranteId)
  const spec = normalizarEspecificacion(input, {
    diasToque2: config.diasToque2,
    diasToque3: config.diasToque3,
    porcentajeControl: config.porcentajeControl,
  })

  const base: Omit<ResultadoProgramacion, 'ok' | 'moduloNoDisponible' | 'vacio'> = {
    cantidad: 0,
    control: 0,
    filasCreadas: 0,
    omitidos: [],
    porSegmento: [],
    primerDespachoAt: null,
    cupoDiario: config.cupoDiario,
    diasToque2: spec.diasToque2 ?? config.diasToque2,
    diasToque3: spec.diasToque3 ?? config.diasToque3,
    porcentajeControl: spec.porcentajeControl ?? config.porcentajeControl,
    toqueHasta: spec.toqueHasta,
  }

  // El scheduler también valida el entitlement porque corre fuera del middleware HTTP. Acá el gate
  // ya lo puso `requireModulo`, pero programar crea compromisos de envío: se revalida igual.
  if (!await tieneModuloActivo(db, restauranteId, MODULE_KEYS.MOTOR_RECOMPRA)) {
    return { ok: false, moduloNoDisponible: true, ...base }
  }

  const [cohorte, comprometidos] = await Promise.all([
    cargarCohorteRecompra(db, restauranteId),
    clientesYaEnTanda(db, restauranteId),
  ])

  const omitidos: ResultadoProgramacion['omitidos'] = []
  const excluidos = new Set(spec.excluirIds)
  for (const id of input.incluirIds ?? []) {
    const n = Math.trunc(Number(id))
    if (!Number.isFinite(n) || n <= 0) continue
    if (excluidos.has(n)) omitidos.push({ clienteId: n, motivo: 'excluido' })
    else if (comprometidos.has(n)) omitidos.push({ clienteId: n, motivo: 'ya_en_tanda' })
    else if (!cohorte.some((cl) => cl.clienteId === n)) omitidos.push({ clienteId: n, motivo: 'no_elegible' })
  }

  const disponibles = cohorte.filter((cl) => !comprometidos.has(cl.clienteId))
  const { contactar, control } = seleccionarCandidatos(disponibles, spec)

  if (contactar.length === 0) {
    return { ok: true, vacio: true, ...base, omitidos }
  }

  const ahora = Date.now()
  const [ins] = await db.insert(CampanaRecompraTable).values({
    restauranteId,
    estado: 'activa',
    origen: 'programada',
    modo: config.modo,
    cupoDiario: config.cupoDiario,
    segmento: spec.segmento,
    cantidadObjetivo: contactar.length,
    toqueHasta: spec.toqueHasta,
    diasToque2: spec.diasToque2,
    diasToque3: spec.diasToque3,
    porcentajeControl: spec.porcentajeControl,
    diaContador: diaArgentina(ahora),
    enviadosHoy: 0,
    totalEnviados: 0,
    totalDetectados: contactar.length + control.length,
    totalControl: control.length,
    totalContactados: 0,
    totalFallidos: 0,
    activadaAt: new Date(ahora),
    programadaAt: new Date(ahora),
  })
  const campanaId = Number((ins as any).insertId)

  // Grupo de control: a la cola como 'control' (nunca se contacta; sostiene la atribución honesta).
  for (const cl of control) {
    await db.insert(ColaRecompraTable).values(
      filaDeCola(restauranteId, campanaId, cl, {
        poblacion: 'stock',
        rol: 'control',
        estado: 'control',
        toque: null,
        dueDate: null,
      }),
    )
  }

  // Contactados: el toque 1, agendado en el día y la hora habituales de cada cliente. Nunca antes
  // de ahora, porque `calcularPatronEnvio` proyecta hacia adelante.
  let primerDespachoMs: number | null = null
  for (const cl of contactar) {
    const patron = calcularPatronEnvio(cl.fechasPedidosMs ?? [], cl.segmento, ahora, cl.clienteId)
    const t = patron.dueDate.getTime()
    if (primerDespachoMs == null || t < primerDespachoMs) primerDespachoMs = t
    await db.insert(ColaRecompraTable).values(
      filaDeCola(restauranteId, campanaId, cl, {
        poblacion: 'stock',
        rol: 'contactado',
        estado: 'pendiente',
        toque: 1,
        dueDate: patron.dueDate,
        horarioSugerido: patron.horarioSugerido,
      }),
    )
  }

  const porSegMap: Record<string, { contactar: number; control: number }> = {}
  for (const cl of contactar) (porSegMap[cl.segmento] ??= { contactar: 0, control: 0 }).contactar++
  for (const cl of control) (porSegMap[cl.segmento] ??= { contactar: 0, control: 0 }).control++

  return {
    ok: true,
    campanaId,
    ...base,
    cantidad: contactar.length,
    control: control.length,
    filasCreadas: contactar.length + control.length,
    omitidos,
    porSegmento: SEGMENTOS_RECUPERABLES
      .filter((s) => porSegMap[s])
      .map((s) => ({ segmento: s, ...porSegMap[s] })),
    primerDespachoAt: primerDespachoMs != null ? new Date(primerDespachoMs).toISOString() : null,
  }
}

export interface ProgramacionResumen {
  id: number
  origen: OrigenCampana
  estado: EstadoCampana
  segmento: SegmentoRecompra | null
  cantidadObjetivo: number | null
  toqueHasta: number
  diasToque2: number
  diasToque3: number
  porcentajeControl: number
  programadaAt: string | null
  /** Clientes distintos que recibieron al menos un toque de esta tanda. */
  contactados: number
  control: number
  /** Toques enviados (una tanda de N con 3 toques puede llegar a 3N). */
  enviados: number
  pendientes: number
  fallidos: number
  /** Próximo `dueDate` pendiente: cuándo vuelve a salir algo de esta tanda. */
  proximoDespachoAt: string | null
  /** Techo de mensajes de la tanda: `cantidadObjetivo × toqueHasta`. */
  mensajesObjetivo: number
}

/** Lista las tandas del local con su progreso. */
export async function listarProgramaciones(
  db: Db,
  restauranteId: number,
  limite = 20,
): Promise<ProgramacionResumen[]> {
  const campanas = await getProgramaciones(db, restauranteId, limite)
  if (campanas.length === 0) return []

  const config = await obtenerConfigMotor(db, restauranteId)
  const ids = campanas.map((c) => c.id)
  const filas = await db
    .select({
      campanaId: ColaRecompraTable.campanaId,
      clienteId: ColaRecompraTable.clienteId,
      rol: ColaRecompraTable.rol,
      estado: ColaRecompraTable.estado,
      dueDate: ColaRecompraTable.dueDate,
      enviadoAt: ColaRecompraTable.enviadoAt,
    })
    .from(ColaRecompraTable)
    .where(and(eq(ColaRecompraTable.restauranteId, restauranteId), inArray(ColaRecompraTable.campanaId, ids)))

  const acc = new Map<number, {
    contactados: Set<number>
    control: Set<number>
    enviados: number
    pendientes: number
    fallidos: number
    proximo: number | null
  }>()
  for (const f of filas) {
    const a = acc.get(f.campanaId) ?? {
      contactados: new Set<number>(), control: new Set<number>(), enviados: 0, pendientes: 0, fallidos: 0, proximo: null,
    }
    if (f.rol === 'control') a.control.add(f.clienteId)
    if (f.estado === 'pendiente') {
      a.pendientes++
      const t = f.dueDate ? new Date(f.dueDate).getTime() : null
      if (t != null && (a.proximo == null || t < a.proximo)) a.proximo = t
    }
    if (f.estado === 'fallido') a.fallidos++
    if (f.rol === 'contactado' && f.enviadoAt) {
      a.enviados++
      a.contactados.add(f.clienteId)
    }
    acc.set(f.campanaId, a)
  }

  return campanas.map((c) => {
    const a = acc.get(c.id)
    const toqueHasta = normalizarToque(c.toqueHasta ?? 1)
    return {
      id: c.id,
      origen: (c.origen === 'programada' ? 'programada' : 'goteo') as OrigenCampana,
      estado: (c.estado ?? 'activa') as EstadoCampana,
      segmento: esSegmentoRecompra(c.segmento) ? c.segmento : null,
      cantidadObjetivo: c.cantidadObjetivo ?? null,
      toqueHasta,
      diasToque2: diasEntreToques(c.diasToque2 ?? config.diasToque2),
      diasToque3: diasEntreToques(c.diasToque3 ?? config.diasToque3),
      porcentajeControl: clampPorcentajeControl(c.porcentajeControl ?? config.porcentajeControl),
      programadaAt: iso(c.programadaAt ?? c.activadaAt),
      contactados: a?.contactados.size ?? 0,
      control: a?.control.size ?? 0,
      enviados: a?.enviados ?? 0,
      pendientes: a?.pendientes ?? 0,
      fallidos: a?.fallidos ?? 0,
      proximoDespachoAt: a?.proximo != null ? new Date(a.proximo).toISOString() : null,
      mensajesObjetivo: (c.cantidadObjetivo ?? 0) * toqueHasta,
    }
  })
}

/**
 * Cancela una tanda: lo que todavía no salió, no sale.
 *
 * Las filas ya enviadas y las de control no se tocan: son la evidencia de atribución (si se
 * borraran, el dashboard mentiría sobre lo que el motor hizo). Las pendientes pasan a `salido`
 * —el mismo estado que usa la regla sagrada cuando el cliente pide— para que no vuelvan a drenarse.
 */
export async function cancelarProgramacion(
  db: Db,
  restauranteId: number,
  campanaId: number,
): Promise<{ ok: boolean; canceladas: number; mensaje?: string }> {
  const [campana] = await db
    .select()
    .from(CampanaRecompraTable)
    .where(and(eq(CampanaRecompraTable.id, campanaId), eq(CampanaRecompraTable.restauranteId, restauranteId)))
    .limit(1)
  if (!campana) return { ok: false, canceladas: 0, mensaje: 'Programación no encontrada' }
  if (!esProcesable(campana.estado)) {
    return { ok: true, canceladas: 0, mensaje: 'La programación ya estaba cerrada' }
  }

  const res = await db
    .update(ColaRecompraTable)
    .set({ estado: 'salido', errorEnvio: 'programacion_cancelada' })
    .where(
      and(
        eq(ColaRecompraTable.campanaId, campanaId),
        eq(ColaRecompraTable.estado, 'pendiente'),
      ),
    )
  await db
    .update(CampanaRecompraTable)
    .set({ estado: 'cancelada', pausadaAt: new Date() })
    .where(eq(CampanaRecompraTable.id, campanaId))

  return { ok: true, canceladas: Number((res as any).affectedRows ?? 0) }
}

// ── Goteo diario (la EJECUCIÓN automática) ───────────────────────────────────
export interface ResultadoGoteo {
  ok: boolean
  motivo?: 'sin_campana' | 'pausada' | 'silencio' | 'cupo_agotado' | 'sin_saldo' | 'nada_que_enviar' | 'modo_manual' | 'modulo_inactivo'
  flujoEnviados: number
  stockEnviados: number
  enviados: number
  fallidos: number
  pausadaSinSaldo?: boolean
  completadas?: number[]
  enColaRestante?: number
}

const goteoVacio = (motivo: ResultadoGoteo['motivo']): ResultadoGoteo => ({
  ok: false,
  motivo,
  flujoEnviados: 0,
  stockEnviados: 0,
  enviados: 0,
  fallidos: 0,
})

/** Envíos que REALMENTE salieron hoy (día de Argentina) en este local: la fuente de verdad del cupo. */
async function contarEnviadosDelDia(db: Db, restauranteId: number, ahora: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)` })
    .from(ColaRecompraTable)
    .where(
      and(
        eq(ColaRecompraTable.restauranteId, restauranteId),
        gte(ColaRecompraTable.enviadoAt, new Date(inicioDiaArgentina(ahora))),
      ),
    )
  return Number(row?.total ?? 0)
}

/**
 * Drena la cola de UN local: todas sus tandas vivas comparten el cupo diario y el saldo marketing.
 *
 * El cupo se cuenta desde `cola_recompra.enviado_at` (lo que salió de verdad) y no desde un contador
 * de campaña, porque con varias tandas a la vez los contadores por campaña driftgean. El orden es por
 * `dueDate` —es la promesa que el dueño vio en pantalla: cada cliente tiene su día y su hora— y dentro
 * del mismo vencimiento manda la prioridad del segmento.
 */
export async function procesarColaDelLocal(
  db: Db,
  restauranteId: number,
  ahora: number = Date.now(),
): Promise<ResultadoGoteo> {
  // El scheduler no atraviesa middleware HTTP: debe respetar el mismo
  // entitlement que las acciones manuales antes de enviar marketing.
  if (!await tieneModuloActivo(db, restauranteId, MODULE_KEYS.MOTOR_RECOMPRA)) {
    return goteoVacio('modulo_inactivo')
  }

  const config = await obtenerConfigMotor(db, restauranteId)
  if (config.estado === 'pausada_manual') return goteoVacio('pausada')

  const campanas = await getProgramacionesVivas(db, restauranteId)
  if (campanas.length === 0) return goteoVacio('sin_campana')

  // Protección de la base: nunca marketing de madrugada. El tick reintenta en el próximo cuarto de hora.
  if (enHorarioSilencio(ahora)) return goteoVacio('silencio')

  // En modo manual no se envían mensajes automáticos de WhatsApp ni se consume saldo: el admin ve la
  // cola y la despacha él mismo (los toques 2 y 3 se encolan igual, al marcar el envío como hecho).
  if (config.modo === 'manual') {
    return { ok: true, motivo: 'modo_manual', flujoEnviados: 0, stockEnviados: 0, enviados: 0, fallidos: 0 }
  }

  const cupo = clampCupo(config.cupoDiario)
  let enviadosHoy = await contarEnviadosDelDia(db, restauranteId, ahora)
  if (cupo - enviadosHoy <= 0) return goteoVacio('cupo_agotado')

  // Saldo marketing: los mensajes de campaña SÍ se pausan en 0 (a diferencia de los utility de pedido).
  const wallet = await resumenWallet(db, restauranteId)
  let marketing = wallet.marketing.disponible
  if (marketing <= 0) {
    await pausarPorSaldo(db, restauranteId, config, ahora)
    return { ...goteoVacio('sin_saldo'), pausadaSinSaldo: true }
  }

  const campanasPorId = new Map(campanas.map((c) => [c.id, c]))
  const pendientes = await db
    .select()
    .from(ColaRecompraTable)
    .where(
      and(
        eq(ColaRecompraTable.restauranteId, restauranteId),
        eq(ColaRecompraTable.estado, 'pendiente'),
        eq(ColaRecompraTable.rol, 'contactado'),
        inArray(ColaRecompraTable.campanaId, [...campanasPorId.keys()]),
        lte(ColaRecompraTable.dueDate, new Date(ahora)),
      ),
    )
    .orderBy(asc(ColaRecompraTable.dueDate), desc(ColaRecompraTable.prioridad), asc(ColaRecompraTable.id))
    .limit(cupo - enviadosHoy)

  let flujoEnviados = 0
  let stockEnviados = 0
  let fallidos = 0

  for (const fila of pendientes) {
    if (marketing <= 0) break
    const r = await enviarFila(db, restauranteId, fila.id, fila.clienteId, fila.segmento, fila.toque)
    if (r.enviado) {
      if (fila.poblacion === 'flujo') flujoEnviados++
      else stockEnviados++
      enviadosHoy++
      marketing--
      // El toque siguiente de ESTA tanda nace con el envío, no de un barrido posterior. Es lo que
      // permite que "sin filas pendientes" signifique de verdad "tanda terminada".
      await programarToqueSiguienteDeFila(db, restauranteId, fila.campanaId, fila.clienteId, fila.toque, ahora)
    } else if (r.fallido) fallidos++
    else if (r.sinSaldo) { marketing = 0; break }
  }

  const enviados = flujoEnviados + stockEnviados

  // Cierre por tanda: la que se quedó sin pendientes está terminada (sus seguimientos ya salieron o
  // ya se encolaron). Se hace acá y no en un job aparte para que el estado siga a la realidad.
  const completadas: number[] = []
  for (const campana of campanas) {
    const [{ pend } = { pend: 0 }] = await db
      .select({ pend: sql<number>`count(*)` })
      .from(ColaRecompraTable)
      .where(and(eq(ColaRecompraTable.campanaId, campana.id), eq(ColaRecompraTable.estado, 'pendiente')))
    if (Number(pend) === 0 && campana.estado === 'activa') {
      await db.update(CampanaRecompraTable).set({ estado: 'completada' }).where(eq(CampanaRecompraTable.id, campana.id))
      completadas.push(campana.id)
    }
  }

  await guardarConfigMotor(db, restauranteId, { ultimoDrenajeDia: diaArgentina(ahora) })

  // Si el saldo se agotó a mitad del goteo, pausar TODAS las tandas del local (con aviso único).
  if (marketing <= 0) {
    await pausarPorSaldo(db, restauranteId, config, ahora)
  }

  const [{ restantes } = { restantes: 0 }] = await db
    .select({ restantes: sql<number>`count(*)` })
    .from(ColaRecompraTable)
    .where(
      and(
        eq(ColaRecompraTable.restauranteId, restauranteId),
        eq(ColaRecompraTable.estado, 'pendiente'),
        eq(ColaRecompraTable.rol, 'contactado'),
      ),
    )

  return {
    ok: true,
    motivo: enviados === 0 ? 'nada_que_enviar' : undefined,
    flujoEnviados,
    stockEnviados,
    enviados,
    fallidos,
    completadas,
    pausadaSinSaldo: marketing <= 0,
    enColaRestante: Number(restantes),
  }
}

/**
 * Encola el toque siguiente de una fila que acaba de salir, si la tanda llega hasta ahí.
 *
 * Se llama desde los DOS caminos de envío (automático y manual). Antes el reencolado lo hacía un
 * barrido perezoso al leer la cola; ahora que leer no escribe, tiene que nacer acá o el modo manual
 * se quedaría sin toques 2 y 3.
 */
async function programarToqueSiguienteDeFila(
  db: Db,
  restauranteId: number,
  campanaId: number,
  clienteId: number,
  toqueEnviado: number | null,
  ahora: number,
): Promise<void> {
  try {
    const [campana] = await db
      .select()
      .from(CampanaRecompraTable)
      .where(and(eq(CampanaRecompraTable.id, campanaId), eq(CampanaRecompraTable.restauranteId, restauranteId)))
      .limit(1)
    // Sólo las tandas programadas generan seguimiento. Las campañas legacy ya tenían lo suyo agendado
    // y su `toque_hasta` es 1: no se les agrega nada nuevo.
    if (!campana || campana.origen !== 'programada' || !esProcesable(campana.estado)) return

    const siguiente = programarToqueSiguiente(toqueEnviado ?? 0, campana.toqueHasta ?? 1)
    if (siguiente == null) return

    const config = await obtenerConfigMotor(db, restauranteId)
    const dias = siguiente === 2
      ? campana.diasToque2 ?? config.diasToque2
      : campana.diasToque3 ?? config.diasToque3

    const [fila] = await db
      .select()
      .from(ColaRecompraTable)
      .where(and(
        eq(ColaRecompraTable.campanaId, campanaId),
        eq(ColaRecompraTable.clienteId, clienteId),
        eq(ColaRecompraTable.toque, toqueEnviado ?? 1),
      ))
      .limit(1)

    const fechasPedidosMs = await fechasPedidosDeCliente(db, restauranteId, clienteId)
    const segmento = esSegmentoRecompra(fila?.segmento) ? fila!.segmento as SegmentoRecompra : 'dormido'
    // El fin de la espera configurada se le pasa al patrón (para que devuelva el primer hueco habitual
    // DESPUÉS de eso) y además se aplica como piso: el `max` lo hace estructural, no una ventana.
    const arranque = arranqueDeRecontactoConIntervalo(ahora, dias, ahora)
    const patron = calcularPatronEnvio(fechasPedidosMs, segmento, arranque, clienteId)
    const dueDate = dueDateDeRecontactoConIntervalo(patron.dueDate, ahora, dias, ahora)

    await db.insert(ColaRecompraTable).values({
      restauranteId,
      campanaId,
      clienteId,
      telefono: fila?.telefono ?? null,
      segmento: fila?.segmento ?? null,
      prioridad: fila?.prioridad ?? '0.00',
      // `flujo` (y no `stock`) porque madura en su `dueDate`: como `stock` iría al fondo por prioridad
      // y un 3º toque con vencimiento de 48 hs saldría tarde.
      poblacion: 'flujo',
      rol: 'contactado',
      toque: siguiente,
      dueDate,
      horarioSugerido: patron.horarioSugerido,
      estado: 'pendiente',
      totalGastadoSnapshot: fila?.totalGastadoSnapshot ?? '0.00',
      ultimoPedidoAtSnapshot: fila?.ultimoPedidoAtSnapshot ?? null,
    })
  } catch (err) {
    // Idempotencia: el índice único (campaña, cliente, toque) es la garantía anti-bucle.
    if (!esDuplicado(err)) {
      console.error(`❌ [Motor recompra] No se pudo programar el toque siguiente del cliente ${clienteId}:`, err)
    }
  }
}

/** Fechas de los pedidos de UN cliente: insumo del patrón de envío al encolar un seguimiento. */
async function fechasPedidosDeCliente(db: Db, restauranteId: number, clienteId: number): Promise<number[]> {
  const pedidos = await db
    .select({ createdAt: PedidoUnificadoTable.createdAt })
    .from(PedidoUnificadoTable)
    .where(
      and(
        eq(PedidoUnificadoTable.restauranteId, restauranteId),
        eq(PedidoUnificadoTable.clienteId, clienteId),
        notInArray(PedidoUnificadoTable.estado, ['cancelled']),
      ),
    )
  return pedidos.map((p) => new Date(p.createdAt).getTime())
}

/**
 * Barrido de reconciliación de seguimientos.
 *
 * El camino normal encola el toque siguiente en el momento del envío. Este barrido existe por si esa
 * inserción se perdió (proceso caído, índice único que rechazó un duplicado legítimo, filas enviadas
 * antes de este deploy). Sin él, esas filas quedarían mudas para siempre. Se limita a la última
 * semana: un toque de hace un mes cuyo seguimiento nunca salió ya no tiene nada que rescatar.
 */
export async function sincronizarRecontactos(
  db: Db,
  restauranteId: number,
  ahora: number = Date.now(),
): Promise<number> {
  const campanas = (await getProgramacionesVivas(db, restauranteId)).filter((c) => c.origen === 'programada')
  if (campanas.length === 0) return 0

  const porId = new Map(campanas.map((c) => [c.id, c]))
  const recientes = await db
    .select({
      campanaId: ColaRecompraTable.campanaId,
      clienteId: ColaRecompraTable.clienteId,
      toque: ColaRecompraTable.toque,
    })
    .from(ColaRecompraTable)
    .where(
      and(
        eq(ColaRecompraTable.restauranteId, restauranteId),
        inArray(ColaRecompraTable.campanaId, [...porId.keys()]),
        eq(ColaRecompraTable.rol, 'contactado'),
        eq(ColaRecompraTable.estado, 'enviado'),
        gte(ColaRecompraTable.enviadoAt, new Date(ahora - 7 * MS_POR_DIA)),
      ),
    )

  const yaTiene = new Set<string>()
  const todas = await db
    .select({ campanaId: ColaRecompraTable.campanaId, clienteId: ColaRecompraTable.clienteId, toque: ColaRecompraTable.toque })
    .from(ColaRecompraTable)
    .where(and(eq(ColaRecompraTable.restauranteId, restauranteId), inArray(ColaRecompraTable.campanaId, [...porId.keys()])))
  for (const f of todas) yaTiene.add(`${f.campanaId}:${f.clienteId}:${f.toque}`)

  let encolados = 0
  const vistos = new Set<string>()
  for (const f of recientes) {
    const campana = porId.get(f.campanaId)
    if (!campana) continue
    const siguiente = programarToqueSiguiente(f.toque ?? 0, campana.toqueHasta ?? 1)
    if (siguiente == null) continue
    const clave = `${f.campanaId}:${f.clienteId}:${siguiente}`
    if (yaTiene.has(clave) || vistos.has(clave)) continue
    vistos.add(clave)
    await programarToqueSiguienteDeFila(db, restauranteId, f.campanaId, f.clienteId, f.toque, ahora)
    encolados++
  }
  return encolados
}

/** Envía el toque de una fila de la cola y actualiza su estado. */
async function enviarFila(
  db: Db,
  restauranteId: number,
  filaId: number,
  clienteId: number,
  segmento: string | null = null,
  toque: number | null = null,
): Promise<{ enviado: boolean; fallido: boolean; sinSaldo?: boolean }> {
  // Regla sagrada / protección: si el cliente ya no es contactable (pidió, opt-out, tope, cooldown),
  // `enviarRecuperoDormido` lo rechaza sin mandar nada; marcamos la fila como salida/fallida.
  const toqueFila = toque != null ? normalizarToque(toque) : undefined
  let res
  try {
    res = await enviarRecuperoDormido(fakeCtx, db, restauranteId, clienteId, {
      operacionId: `motor-recompra:${restauranteId}:${filaId}`,
      // El segmento que clasificó la tanda elige la receta del mensaje. El link no cambia: lo
      // sigue resolviendo la escalera igual que antes.
      segmento: esSegmentoRecompra(segmento) ? segmento : undefined,
      // El toque de la fila decide el copy y la plantilla de Meta. El beneficio, en cambio, lo
      // sigue fijando la escalera en el momento del envío.
      toque: toqueFila,
    })
  } catch (err) {
    console.error(`❌ [Motor recompra] Error enviando a cliente ${clienteId}:`, err)
    await db.update(ColaRecompraTable).set({
      estado: 'fallido',
      plantillaWhatsapp: PLANTILLA_RECUPERO_WHATSAPP,
      ultimoIntentoAt: new Date(),
      errorEnvio: err instanceof Error ? err.message.slice(0, 500) : 'Error inesperado',
    }).where(eq(ColaRecompraTable.id, filaId))
    return { enviado: false, fallido: true }
  }

  if (res.ok) {
    await db
      .update(ColaRecompraTable)
      .set({
        estado: 'enviado',
        enviadoAt: new Date(),
        ultimoIntentoAt: new Date(),
        plantillaWhatsapp: res.plantillaWhatsapp ?? PLANTILLA_RECUPERO_WHATSAPP,
        origenContacto: 'automatico',
        errorEnvio: null,
        nivel: res.nivel ?? null,
        toque: res.toque ?? toqueFila ?? null,
        codigoDescuento: res.codigoDescuento ?? null,
      })
      .where(eq(ColaRecompraTable.id, filaId))
    return { enviado: true, fallido: false }
  }

  if (res.motivo === 'sin_saldo') {
    return { enviado: false, fallido: false, sinSaldo: true }
  }

  // Bloqueos "no ahora" (cooldown/tope/silencio/opt-out) → dejamos la fila pendiente salvo opt-out.
  if (res.motivo === 'opt_out') {
    await db.update(ColaRecompraTable).set({ estado: 'salido', errorEnvio: 'opt_out' }).where(eq(ColaRecompraTable.id, filaId))
    return { enviado: false, fallido: false }
  }
  if (res.motivo === 'cooldown' || res.motivo === 'horario_silencio') {
    // Reintento con dueDate NUEVA: sin esto la fila queda `pendiente` con el dueDate viejo y el
    // drenaje la vuelve a levantar en cada tick, todos los días, hasta que el cooldown se cumpla por
    // decantación. Se re-estampa un rato después del fin del cooldown (el `+5 min` garantiza progreso
    // aunque el reloj del proceso vaya atrasado) o en 1 h si fue el silencio.
    const reintento = res.motivo === 'cooldown'
      ? new Date(Date.now() + COOLDOWN_HORAS * 60 * 60 * 1000 + 5 * 60 * 1000)
      : new Date(Date.now() + 60 * 60 * 1000)
    await db.update(ColaRecompraTable).set({
      dueDate: reintento,
      ultimoIntentoAt: new Date(),
      errorEnvio: res.motivo,
    }).where(eq(ColaRecompraTable.id, filaId))
    return { enviado: false, fallido: false }
  }
  if (res.motivo === 'tope_mensual') {
    // Terminal a propósito: el tope es de 30 días y el goteo entero dura 3 toques, así que
    // reintentarlo sólo dejaría la fila girando para siempre sin poder salir nunca.
    await db.update(ColaRecompraTable).set({
      estado: 'fallido',
      ultimoIntentoAt: new Date(),
      errorEnvio: 'tope_mensual',
    }).where(eq(ColaRecompraTable.id, filaId))
    return { enviado: false, fallido: true }
  }
  // sin_telefono / envio_fallido / cliente_no_encontrado → fallido.
  await db.update(ColaRecompraTable).set({
    estado: 'fallido',
    plantillaWhatsapp: res.plantillaWhatsapp ?? PLANTILLA_RECUPERO_WEB_HOOK_FALLBACK(),
    ultimoIntentoAt: new Date(),
    errorEnvio: (res.errorEnvio ?? res.motivo ?? 'envio_fallido').slice(0, 500),
  }).where(eq(ColaRecompraTable.id, filaId))
  return { enviado: false, fallido: true }
}

/** La plantilla histórica, aislada para que un rename futuro no toque la lógica de envío. */
function PLANTILLA_RECUPERO_WEB_HOOK_FALLBACK(): string {
  return PLANTILLA_RECUPERO_WHATSAPP
}

// ── Pausa y reanudación (de TODO el goteo del local) ─────────────────────────
/**
 * Pausa el motor del local por saldo agotado. Aviso ÚNICO (o 1/semana): nunca súplica, nunca deuda.
 * La pausa es del local entero: con varias tandas vivas, dejar una corriendo y otra no sería
 * exactamente lo que el cupo y el saldo compartido no permiten.
 */
async function pausarPorSaldo(
  db: Db,
  restauranteId: number,
  config: ConfigMotorData,
  ahora: number,
): Promise<void> {
  await guardarConfigMotor(db, restauranteId, { estado: 'pausada_sin_saldo' })
  await avisarPausaSinSaldoSiCorresponde(db, restauranteId, config, ahora)
}

/** Aviso utility de cuenta al dueño, máximo uno cada siete días mientras siga pausado. */
async function avisarPausaSinSaldoSiCorresponde(
  db: Db,
  restauranteId: number,
  config: Pick<ConfigMotorData, 'avisoSinSaldoAt'>,
  ahora: number,
): Promise<void> {
  const ultimo = config.avisoSinSaldoAt ? new Date(config.avisoSinSaldoAt).getTime() : 0
  if (ahora - ultimo < RECORDATORIO_SIN_SALDO_DIAS * MS_POR_DIA) return

  const [rest] = await db.select({ telefono: RestauranteTable.telefono })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)
  const telefono = (rest?.telefono ?? '').replace(/\D/g, '')
  if (telefono.length < 8) {
    await guardarConfigMotor(db, restauranteId, { avisoSinSaldoAt: new Date(ahora) })
    return
  }

  try {
    const token = crypto.randomUUID()
    await crearRecargaPendiente(db, restauranteId, {
      categoria: 'marketing',
      cantidad: 0,
      monto: '0.00',
      origen: 'auto',
      seleccionPack: true,
      token,
      tokenExpiraEn: new Date(ahora + 30 * MS_POR_DIA),
    })
    const envio = await sendSaldoBajoWhatsApp(fakeCtx, {
      phone: telefono,
      estado: 'el Motor de Recompra quedó pausado porque tus mensajes de campaña llegaron a cero',
      token,
    })
    if (!envio.success) return
    await guardarConfigMotor(db, restauranteId, { avisoSinSaldoAt: new Date(ahora) })
  } catch (error) {
    console.error(`⚠️ [Motor recompra] No se pudo avisar la pausa por saldo del restaurante ${restauranteId}:`, error)
  }
}

export async function pausarMotorManual(db: Db, restauranteId: number): Promise<boolean> {
  const config = await obtenerConfigMotor(db, restauranteId)
  if (config.estado === 'pausada_manual') return true
  await guardarConfigMotor(db, restauranteId, { estado: 'pausada_manual' })
  return true
}

export async function reanudarMotor(db: Db, restauranteId: number): Promise<boolean> {
  const config = await obtenerConfigMotor(db, restauranteId)
  if (config.estado === 'activa') return true
  await guardarConfigMotor(db, restauranteId, { estado: 'activa' })
  return true
}

/** Wrapper de compatibilidad: el modo ahora es del local, no de la campaña. */
export async function setModoMotor(db: Db, restauranteId: number, modo: ModoCampana): Promise<ModoCampana> {
  const config = await guardarConfigMotor(db, restauranteId, { modo })
  return config.modo
}

// ── Regla sagrada: el cliente pidió → sale de la cola INMEDIATAMENTE ─────────
/**
 * Nada peor que un "te extrañamos" a quien pidió ayer. Cuando entra un pedido de un cliente, sus filas
 * de TODAS las tandas del local salen de la cola en tiempo real (no se espera al tick). `enviadoAt`
 * conserva la atribución y el historial aunque el estado operativo pase a `salido`.
 * Best-effort: nunca frena el alta.
 */
export async function salirDeColaPorPedido(db: Db, restauranteId: number, clienteId: number): Promise<void> {
  try {
    await db
      .update(ColaRecompraTable)
      .set({ estado: 'salido' })
      .where(
        and(
          eq(ColaRecompraTable.restauranteId, restauranteId),
          eq(ColaRecompraTable.clienteId, clienteId),
          inArray(ColaRecompraTable.estado, ['pendiente', 'enviado', 'control']),
        ),
      )
  } catch (err) {
    console.error('❌ [Motor recompra] Error sacando cliente de la cola tras pedido:', err)
  }
}

// ── Contacto manual (la válvula del dueño) vs. grupo de control ──────────────
/**
 * El botón "Recuperar" per-cliente (4.2) es la válvula del dueño: puede escribirle a mano a quien quiera.
 * PERO si ese cliente estaba en el GRUPO DE CONTROL de alguna tanda viva, contactarlo a mano rompe la
 * atribución honesta: si después vuelve, se contaría como "volvió solo" (control), inflando la tasa del
 * control y subestimando el uplift del Motor (justo el número que vende los packs). La regla: un envío
 * manual RECLASIFICA al cliente como CONTACTADO en el mismo momento (sale del control), y marca su
 * eventual fila pendiente como enviada (fue contactado ya). Best-effort: nunca frena el envío al comensal.
 */
export async function registrarContactoManual(
  db: Db,
  restauranteId: number,
  clienteId: number,
  datos: { nivel?: number | null; codigoDescuento?: string | null; plantillaWhatsapp?: string | null } = {},
): Promise<void> {
  try {
    const campanas = await getProgramacionesVivas(db, restauranteId)
    if (campanas.length === 0) return // sin tandas vivas no hay control que contaminar

    const filas = await db
      .select({ id: ColaRecompraTable.id, campanaId: ColaRecompraTable.campanaId, rol: ColaRecompraTable.rol, estado: ColaRecompraTable.estado })
      .from(ColaRecompraTable)
      .where(
        and(
          eq(ColaRecompraTable.restauranteId, restauranteId),
          eq(ColaRecompraTable.clienteId, clienteId),
          inArray(ColaRecompraTable.campanaId, campanas.map((c) => c.id)),
        ),
      )

    const porCampana = new Map<number, number>()
    for (const fila of filas) {
      // Control o pendiente → pasa a contactado/enviado (fue contactado, aunque a mano).
      if (fila.rol === 'control' || fila.estado === 'pendiente' || fila.estado === 'control') {
        await db
          .update(ColaRecompraTable)
          .set({
            rol: 'contactado',
            estado: 'enviado',
            enviadoAt: new Date(),
            ultimoIntentoAt: new Date(),
            origenContacto: 'manual',
            plantillaWhatsapp: datos.plantillaWhatsapp ?? PLANTILLA_RECUPERO_WHATSAPP,
            errorEnvio: null,
            nivel: datos.nivel ?? null,
            codigoDescuento: datos.codigoDescuento ?? null,
          })
          .where(eq(ColaRecompraTable.id, fila.id))
        porCampana.set(fila.campanaId, (porCampana.get(fila.campanaId) ?? 0) + 1)
      }
    }
    for (const [campanaId, cuantos] of porCampana) {
      await db.update(CampanaRecompraTable).set({
        totalEnviados: sql`${CampanaRecompraTable.totalEnviados} + ${cuantos}`,
        totalContactados: sql`${CampanaRecompraTable.totalContactados} + ${cuantos}`,
      }).where(eq(CampanaRecompraTable.id, campanaId))
    }
  } catch (err) {
    console.error('❌ [Motor recompra] Error reclasificando contacto manual:', err)
  }
}

/** Registra un intento manual fallido sin sacar al cliente de la cola automática. */
export async function registrarFalloContactoManual(
  db: Db,
  restauranteId: number,
  clienteId: number,
  datos: { plantillaWhatsapp?: string | null; errorEnvio?: string | null } = {},
): Promise<void> {
  const campanas = await getProgramacionesVivas(db, restauranteId)
  if (campanas.length === 0) return
  await db.update(ColaRecompraTable).set({
    origenContacto: 'manual',
    plantillaWhatsapp: datos.plantillaWhatsapp ?? PLANTILLA_RECUPERO_WHATSAPP,
    ultimoIntentoAt: new Date(),
    errorEnvio: (datos.errorEnvio ?? 'envio_fallido').slice(0, 500),
  }).where(and(
    eq(ColaRecompraTable.restauranteId, restauranteId),
    inArray(ColaRecompraTable.campanaId, campanas.map((c) => c.id)),
    eq(ColaRecompraTable.clienteId, clienteId),
    inArray(ColaRecompraTable.estado, ['pendiente', 'control']),
  ))
}

// ── Estado del motor (la RENDICIÓN de cuentas) ───────────────────────────────
export interface PlanActivacion {
  totalDetectados: number
  totalContactar: number
  totalControl: number
  porSegmento: { segmento: SegmentoCliente; detectados: number; facturacionEnJuego: number }[]
  primerSegmento: SegmentoCliente | null
  cupoSugerido: number
  saldoMarketing: number
  /** Cuántos días cubre el saldo actual al cupo sugerido (la "degustación" de la propuesta). */
  diasCubiertos: number
  /** Cuántos clientes ya están comprometidos en alguna tanda viva (no volverían a entrar). */
  enTanda: number
}

export interface DashboardCampana {
  estado: EstadoMotorLocal
  modo: ModoCampana
  cupoDiario: number
  enviadosHoy: number
  totalEnviados: number
  enCola: number
  /** Clientes ÚNICOS con al menos un toque enviado (el goteo manda hasta 3 por cliente). */
  contactados: number
  /** Total de toques enviados: `contactados` ≤ `toquesEnviados` ≤ 3 × `contactados`. */
  toquesEnviados: number
  volvieron: number
  plataRecuperada: number
  control: number
  controlVolvieron: number
  tasaContactados: number
  tasaControl: number
  saldoMarketing: number
  activadaAt: string | null
  pausadaAt: string | null
}

export interface EstadoMotor {
  /** true si hay al menos una tanda viva: es lo que decide si la pantalla muestra el marcador. */
  activa: boolean
  /** Config del motor del local (cupo, modo, pausa, intervalos, control). */
  config: ConfigMotorData
  /** Marcador AGREGADO de todas las tandas vivas. null si no hay ninguna. */
  campana: DashboardCampana | null
  programaciones: ProgramacionResumen[]
  /** El universo disponible para programar. Se devuelve SIEMPRE: es el insumo del asistente. */
  plan: PlanActivacion
  saldoMarketing: number
}

/** Arma la pantalla del motor: el marcador agregado + las tandas + el universo disponible. */
export async function estadoMotor(db: Db, restauranteId: number): Promise<EstadoMotor> {
  const [wallet, config, programaciones, campanas] = await Promise.all([
    resumenWallet(db, restauranteId),
    obtenerConfigMotor(db, restauranteId),
    listarProgramaciones(db, restauranteId),
    getProgramacionesVivas(db, restauranteId),
  ])
  const saldoMarketing = wallet.marketing.disponible
  const plan = await construirPlan(db, restauranteId, saldoMarketing, config.cupoDiario)

  if (campanas.length === 0) {
    return { activa: false, config, campana: null, programaciones, plan, saldoMarketing }
  }

  const dashboard = await construirDashboard(db, restauranteId, campanas, config, saldoMarketing)
  return { activa: true, config, campana: dashboard, programaciones, plan, saldoMarketing }
}

async function construirPlan(
  db: Db,
  restauranteId: number,
  saldoMarketing: number,
  cupoSugerido: number,
): Promise<PlanActivacion> {
  const [cohorte, comprometidos] = await Promise.all([
    cargarCohorteRecompra(db, restauranteId),
    clientesYaEnTanda(db, restauranteId),
  ])
  const disponibles = cohorte.filter((cl) => !comprometidos.has(cl.clienteId))
  const porSegMap: Record<string, ClienteCohorte[]> = {}
  for (const cl of disponibles) (porSegMap[cl.segmento] ??= []).push(cl)

  const porSegmento = SEGMENTOS_RECUPERABLES.filter((s) => (porSegMap[s]?.length ?? 0) > 0).map((s) => {
    const arr = porSegMap[s] ?? []
    return {
      segmento: s,
      detectados: arr.length,
      facturacionEnJuego: arr.reduce((acc, c) => acc + c.totalGastado, 0),
    }
  })

  const totalControl = Object.values(porSegMap).reduce(
    (acc, arr) => acc + Math.round(arr.length * (PORCENTAJE_CONTROL_DEFAULT / 100)),
    0,
  )
  // Propuesta: arrancar por el mejor segmento presente (en_riesgo primero: mejor tasa de retorno).
  const primerSegmento = (SEGMENTOS_RECUPERABLES.find((s) => (porSegMap[s]?.length ?? 0) > 0) ?? null) as SegmentoCliente | null
  const diasCubiertos = saldoMarketing > 0 ? Math.max(1, Math.floor(saldoMarketing / cupoSugerido)) : 0

  return {
    totalDetectados: disponibles.length,
    totalContactar: disponibles.length - totalControl,
    totalControl,
    porSegmento,
    primerSegmento,
    cupoSugerido,
    saldoMarketing,
    diasCubiertos,
    enTanda: comprometidos.size,
  }
}

async function construirDashboard(
  db: Db,
  restauranteId: number,
  campanas: CampanaRow[],
  config: ConfigMotorData,
  saldoMarketing: number,
): Promise<DashboardCampana> {
  const ids = campanas.map((c) => c.id)
  // Miembros de TODAS las tandas vivas por rol/estado.
  const filas = await db
    .select({
      campanaId: ColaRecompraTable.campanaId,
      clienteId: ColaRecompraTable.clienteId,
      rol: ColaRecompraTable.rol,
      estado: ColaRecompraTable.estado,
      enviadoAt: ColaRecompraTable.enviadoAt,
    })
    .from(ColaRecompraTable)
    .where(and(eq(ColaRecompraTable.restauranteId, restauranteId), inArray(ColaRecompraTable.campanaId, ids)))

  // El estado puede haber pasado a `salido` tras una recompra; `enviadoAt` es la evidencia
  // inmutable de que el cliente integró el grupo tratado.
  const contactadosEnviados = filas.filter((f) => f.rol === 'contactado' && f.enviadoAt != null)
  const control = filas.filter((f) => f.rol === 'control')
  const enCola = filas.filter((f) => f.estado === 'pendiente').length

  // La referencia del control es el instante en que se programó la tanda MÁS VIEJA viva: es la fecha
  // a partir de la cual el grupo de control "esperaba" sin ser contactado.
  const referencia = campanas.reduce<Date>((min, c) => {
    const t = new Date(c.programadaAt ?? c.activadaAt ?? c.createdAt)
    return t.getTime() < min.getTime() ? t : min
  }, new Date(campanas[0].programadaAt ?? campanas[0].activadaAt ?? campanas[0].createdAt))

  const clientesRelevantes = [...new Set([
    ...contactadosEnviados.map((f) => f.clienteId),
    ...control.map((f) => f.clienteId),
  ])]

  // Con el goteo hay hasta 3 filas `enviado` por cliente, así que el mapa se queda con el PRIMER
  // toque (`t < prev`): "volvió después de que lo contactamos" se mide contra el primer contacto, que
  // es la referencia comparable con el control (que tiene un único instante). Si se quedara con el
  // último, la tasa se derrumbaría a un tercio sin que nada haya empeorado.
  const enviadoPorCliente = new Map<number, number>()
  for (const f of contactadosEnviados) {
    if (!f.enviadoAt) continue
    const t = new Date(f.enviadoAt).getTime()
    const prev = enviadoPorCliente.get(f.clienteId)
    if (prev == null || t < prev) enviadoPorCliente.set(f.clienteId, t)
  }
  const contactados = enviadoPorCliente.size

  let volvieron = 0
  let plataRecuperada = 0
  let controlVolvieron = 0

  if (clientesRelevantes.length > 0) {
    const pedidos = await db
      .select({
        clienteId: PedidoUnificadoTable.clienteId,
        total: PedidoUnificadoTable.total,
        createdAt: PedidoUnificadoTable.createdAt,
      })
      .from(PedidoUnificadoTable)
      .where(
        and(
          eq(PedidoUnificadoTable.restauranteId, restauranteId),
          inArray(PedidoUnificadoTable.clienteId, clientesRelevantes),
          notInArray(PedidoUnificadoTable.estado, ['cancelled']),
        ),
      )

    const controlSet = new Set(control.map((f) => f.clienteId))
    const volvieronSet = new Set<number>()
    const controlVolvieronSet = new Set<number>()

    for (const p of pedidos) {
      const cid = p.clienteId as number
      const t = new Date(p.createdAt).getTime()
      const desdeContacto = enviadoPorCliente.get(cid)
      if (desdeContacto != null && t > desdeContacto) {
        if (!volvieronSet.has(cid)) volvieronSet.add(cid)
        plataRecuperada += parseFloat(p.total || '0')
      }
      if (controlSet.has(cid) && t > referencia.getTime()) controlVolvieronSet.add(cid)
    }
    volvieron = volvieronSet.size
    controlVolvieron = controlVolvieronSet.size
  }

  const tasaContactados = contactados > 0 ? volvieron / contactados : 0
  const tasaControl = control.length > 0 ? controlVolvieron / control.length : 0
  const enviadosHoy = await contarEnviadosDelDia(db, restauranteId, Date.now())

  return {
    estado: config.estado,
    modo: config.modo,
    cupoDiario: config.cupoDiario,
    enviadosHoy,
    totalEnviados: filas.filter((f) => f.enviadoAt != null).length,
    enCola,
    contactados,
    toquesEnviados: contactadosEnviados.length,
    volvieron,
    plataRecuperada,
    control: control.length,
    controlVolvieron,
    tasaContactados,
    tasaControl,
    saldoMarketing,
    activadaAt: iso(campanas[0].programadaAt ?? campanas[0].activadaAt),
    pausadaAt: config.estado === 'activa' ? null : iso(new Date()),
  }
}

// ── Observabilidad operativa ─────────────────────────────────────────────────
export interface FiltrosObservabilidadRecompra {
  pagina?: number
  limite?: number
  segmento?: string
  poblacion?: 'flujo' | 'stock'
  rol?: 'contactado' | 'control'
  estado?: 'pendiente' | 'enviado' | 'salido' | 'fallido' | 'control'
  /** Filtra por una tanda puntual. Sin él, la vista es la del local entero. */
  campanaId?: number
}

function paginacion(filtros: FiltrosObservabilidadRecompra) {
  const pagina = Math.max(1, Math.floor(filtros.pagina ?? 1))
  const limite = Math.max(5, Math.min(100, Math.floor(filtros.limite ?? 25)))
  return { pagina, limite, offset: (pagina - 1) * limite }
}

function estadoPublico(estado: string): string {
  return estado === 'salido' ? 'salido_por_pedido' : estado
}

/** Cola pendiente del local, en el mismo orden efectivo del scheduler (por vencimiento). */
export async function listarColaRecompra(
  db: Db,
  restauranteId: number,
  filtros: Omit<FiltrosObservabilidadRecompra, 'estado' | 'rol'> = {},
) {
  const { pagina, limite, offset } = paginacion(filtros)
  const condicionesBase = [
    eq(ColaRecompraTable.restauranteId, restauranteId),
    eq(ColaRecompraTable.estado, 'pendiente'),
    eq(ColaRecompraTable.rol, 'contactado'),
  ]
  const condiciones = [...condicionesBase]
  if (filtros.campanaId) condiciones.push(eq(ColaRecompraTable.campanaId, filtros.campanaId))
  if (filtros.segmento) condiciones.push(eq(ColaRecompraTable.segmento, filtros.segmento))
  if (filtros.poblacion) condiciones.push(eq(ColaRecompraTable.poblacion, filtros.poblacion))
  const where = and(...condiciones)

  const ahora = new Date()
  const [filas, [conteo], ordenGlobal, [config], [enviadosHoyRow]] = await Promise.all([
    db.select({
      id: ColaRecompraTable.id,
      campanaId: ColaRecompraTable.campanaId,
      clienteId: ColaRecompraTable.clienteId,
      clienteNombre: ClienteTable.nombre,
      telefono: ColaRecompraTable.telefono,
      segmento: ColaRecompraTable.segmento,
      poblacion: ColaRecompraTable.poblacion,
      rol: ColaRecompraTable.rol,
      toque: ColaRecompraTable.toque,
      prioridad: ColaRecompraTable.prioridad,
      dueDate: ColaRecompraTable.dueDate,
      horarioSugerido: ColaRecompraTable.horarioSugerido,
      totalGastado: ColaRecompraTable.totalGastadoSnapshot,
      ultimoPedidoAt: ColaRecompraTable.ultimoPedidoAtSnapshot,
      createdAt: ColaRecompraTable.createdAt,
    }).from(ColaRecompraTable)
      .innerJoin(ClienteTable, and(
        eq(ClienteTable.id, ColaRecompraTable.clienteId),
        eq(ClienteTable.restauranteId, restauranteId),
      ))
      .where(where)
      .orderBy(asc(ColaRecompraTable.dueDate), desc(ColaRecompraTable.prioridad), asc(ColaRecompraTable.id))
      .limit(limite)
      .offset(offset),
    db.select({ total: sql<number>`count(*)` }).from(ColaRecompraTable).where(where),
    db.select({ id: ColaRecompraTable.id }).from(ColaRecompraTable)
      .where(and(...condicionesBase))
      .orderBy(asc(ColaRecompraTable.dueDate), desc(ColaRecompraTable.prioridad), asc(ColaRecompraTable.id)),
    db.select({ cupoDiario: ConfigMotorRecompraTable.cupoDiario }).from(ConfigMotorRecompraTable)
      .where(eq(ConfigMotorRecompraTable.restauranteId, restauranteId)).limit(1),
    db.select({ total: sql<number>`count(*)` }).from(ColaRecompraTable).where(and(
      eq(ColaRecompraTable.restauranteId, restauranteId),
      gte(ColaRecompraTable.enviadoAt, new Date(inicioDiaArgentina(ahora.getTime()))),
    )),
  ])

  const total = Number(conteo?.total ?? 0)
  const cupo = clampCupo(config?.cupoDiario ?? CUPO_DIARIO_DEFAULT)
  const capacidadHoy = Math.max(0, cupo - Number(enviadosHoyRow?.total ?? 0))
  const fechaBase = ahora
  const posiciones = new Map(ordenGlobal.map((fila, indice) => [fila.id, indice]))
  const items = filas.map((fila, indicePagina) => {
    const posicion = posiciones.get(fila.id) ?? offset + indicePagina
    // La proyección nunca promete más despachos que el cupo diario configurado.
    const diasEspera = posicion < capacidadHoy
      ? 0
      : 1 + Math.floor((posicion - capacidadHoy) / cupo)
    const proyectada = new Date(fechaBase.getTime() + diasEspera * MS_POR_DIA)
    return {
      ...fila,
      prioridad: Number(fila.prioridad ?? 0),
      totalGastado: Number(fila.totalGastado ?? 0),
      dueDate: iso(fila.dueDate),
      ultimoPedidoAt: iso(fila.ultimoPedidoAt),
      createdAt: iso(fila.createdAt),
      posicionPrioridad: posicion + 1,
      fechaProyectada: diaArgentina(proyectada.getTime()),
    }
  })
  return { items, pagina, limite, total, paginas: Math.ceil(total / limite) }
}

/** Intentos ejecutados, incluidos los fallidos y los contactos manuales convergidos. */
export async function listarHistorialRecompra(
  db: Db,
  restauranteId: number,
  filtros: Pick<FiltrosObservabilidadRecompra, 'pagina' | 'limite' | 'segmento' | 'campanaId'> & { estadoDespacho?: 'entregado' | 'fallido' } = {},
) {
  const { pagina, limite, offset } = paginacion(filtros)
  const estadoCondicion = filtros.estadoDespacho === 'entregado'
    ? isNotNull(ColaRecompraTable.enviadoAt)
    : filtros.estadoDespacho === 'fallido'
      ? or(eq(ColaRecompraTable.estado, 'fallido'), isNotNull(ColaRecompraTable.errorEnvio))!
      : or(
          isNotNull(ColaRecompraTable.enviadoAt),
          eq(ColaRecompraTable.estado, 'fallido'),
          isNotNull(ColaRecompraTable.errorEnvio),
        )!
  const condiciones = [
    eq(ColaRecompraTable.restauranteId, restauranteId),
    estadoCondicion,
  ]
  if (filtros.campanaId) condiciones.push(eq(ColaRecompraTable.campanaId, filtros.campanaId))
  if (filtros.segmento) condiciones.push(eq(ColaRecompraTable.segmento, filtros.segmento))
  const where = and(...condiciones)
  const [filas, [conteo]] = await Promise.all([
    db.select({
      id: ColaRecompraTable.id,
      campanaId: ColaRecompraTable.campanaId,
      clienteId: ColaRecompraTable.clienteId,
      clienteNombre: ClienteTable.nombre,
      telefono: ColaRecompraTable.telefono,
      segmento: ColaRecompraTable.segmento,
      poblacion: ColaRecompraTable.poblacion,
      origenContacto: ColaRecompraTable.origenContacto,
      estado: ColaRecompraTable.estado,
      plantillaWhatsapp: ColaRecompraTable.plantillaWhatsapp,
      codigoDescuento: ColaRecompraTable.codigoDescuento,
      nivel: ColaRecompraTable.nivel,
      // Qué toque salió y con qué link/descuento: es la auditoría del invariante "lo_mismo nunca
      // lleva descuento" y de la diferencia entre el copy elegido (`toque`) y el escalón (`nivel`).
      toque: ColaRecompraTable.toque,
      linkModalidad: ColaRecompraTable.linkModalidad,
      descuentoEnviado: ColaRecompraTable.descuentoEnviado,
      enviadoAt: ColaRecompraTable.enviadoAt,
      ultimoIntentoAt: ColaRecompraTable.ultimoIntentoAt,
      errorEnvio: ColaRecompraTable.errorEnvio,
    }).from(ColaRecompraTable)
      .innerJoin(ClienteTable, and(
        eq(ClienteTable.id, ColaRecompraTable.clienteId),
        eq(ClienteTable.restauranteId, restauranteId),
      ))
      .where(where)
      .orderBy(desc(ColaRecompraTable.ultimoIntentoAt), desc(ColaRecompraTable.enviadoAt), desc(ColaRecompraTable.id))
      .limit(limite)
      .offset(offset),
    db.select({ total: sql<number>`count(*)` }).from(ColaRecompraTable).where(where),
  ])
  const total = Number(conteo?.total ?? 0)
  return {
    items: filas.map((fila) => ({
      ...fila,
      estadoDespacho: fila.enviadoAt && !fila.errorEnvio ? 'entregado' : 'fallido',
      plantillaWhatsapp: fila.plantillaWhatsapp ?? PLANTILLA_RECUPERO_WHATSAPP,
      fechaHora: iso(fila.ultimoIntentoAt ?? fila.enviadoAt),
    })),
    pagina, limite, total, paginas: Math.ceil(total / limite),
  }
}

/** Directorio consolidado de las tandas vivas y las protecciones vigentes por cliente. */
export async function listarClientesRecompra(
  db: Db,
  restauranteId: number,
  filtros: FiltrosObservabilidadRecompra = {},
) {
  const { pagina, limite, offset } = paginacion(filtros)
  const condiciones = [eq(ColaRecompraTable.restauranteId, restauranteId)]
  if (filtros.campanaId) condiciones.push(eq(ColaRecompraTable.campanaId, filtros.campanaId))
  if (filtros.segmento) condiciones.push(eq(ColaRecompraTable.segmento, filtros.segmento))
  if (filtros.poblacion) condiciones.push(eq(ColaRecompraTable.poblacion, filtros.poblacion))
  if (filtros.rol) condiciones.push(eq(ColaRecompraTable.rol, filtros.rol))
  if (filtros.estado) condiciones.push(eq(ColaRecompraTable.estado, filtros.estado))
  const where = and(...condiciones)
  const [filas, [conteo]] = await Promise.all([
    db.select({
      id: ColaRecompraTable.id,
      campanaId: ColaRecompraTable.campanaId,
      clienteId: ColaRecompraTable.clienteId,
      clienteNombre: ClienteTable.nombre,
      telefono: ColaRecompraTable.telefono,
      segmento: ColaRecompraTable.segmento,
      poblacion: ColaRecompraTable.poblacion,
      rol: ColaRecompraTable.rol,
      estado: ColaRecompraTable.estado,
      prioridad: ColaRecompraTable.prioridad,
      // El recorrido del goteo de este cliente: qué toque es esta fila y cuántos lleva ya enviados.
      toque: ColaRecompraTable.toque,
      nivel: ColaRecompraTable.nivel,
      totalGastadoSnapshot: ColaRecompraTable.totalGastadoSnapshot,
      ultimoPedidoAtSnapshot: ColaRecompraTable.ultimoPedidoAtSnapshot,
      dueDate: ColaRecompraTable.dueDate,
      enviadoAt: ColaRecompraTable.enviadoAt,
      marketingOptOut: ClienteTable.marketingOptOut,
    }).from(ColaRecompraTable)
      .innerJoin(ClienteTable, and(
        eq(ClienteTable.id, ColaRecompraTable.clienteId),
        eq(ClienteTable.restauranteId, restauranteId),
      ))
      .where(where)
      .orderBy(asc(ColaRecompraTable.dueDate), desc(ColaRecompraTable.prioridad), asc(ColaRecompraTable.id))
      .limit(limite)
      .offset(offset),
    db.select({ total: sql<number>`count(*)` }).from(ColaRecompraTable).where(where),
  ])

  const ids = filas.map((fila) => fila.clienteId)
  const [toques, pedidos] = await Promise.all([
    cargarToquesPorCliente(db, restauranteId, ids),
    ids.length === 0 ? Promise.resolve([]) : db.select({
      clienteId: PedidoUnificadoTable.clienteId,
      cantidadPedidos: sql<number>`count(*)`,
      totalGastado: sql<string>`coalesce(sum(${PedidoUnificadoTable.total}), 0)`,
      ultimoPedidoAt: sql<Date>`max(${PedidoUnificadoTable.createdAt})`,
    }).from(PedidoUnificadoTable).where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId),
      inArray(PedidoUnificadoTable.clienteId, ids),
      notInArray(PedidoUnificadoTable.estado, ['cancelled']),
    )).groupBy(PedidoUnificadoTable.clienteId),
  ])
  const pedidosPorCliente = new Map(pedidos.map((pedido) => [pedido.clienteId as number, pedido]))
  const ahora = Date.now()
  const inicioVentana = ahora - 30 * MS_POR_DIA
  const items = filas.map((fila) => {
    const resumenPedidos = pedidosPorCliente.get(fila.clienteId)
    const cantidadPedidos = Number(resumenPedidos?.cantidadPedidos ?? 0)
    const totalGastado = Number(resumenPedidos?.totalGastado ?? fila.totalGastadoSnapshot ?? 0)
    const historial = toques[fila.clienteId] ?? []
    const recupero = estadoRecupero(historial, fila.ultimoPedidoAtSnapshot ? new Date(fila.ultimoPedidoAtSnapshot).getTime() : null)
    const toques30Dias = historial.filter((toque) => new Date(toque.createdAt).getTime() >= inicioVentana).length
    const cooldownHasta = !recupero.puedeEnviar && recupero.ultimoEnvioAt
      ? new Date(new Date(recupero.ultimoEnvioAt).getTime() + COOLDOWN_HORAS * 60 * 60 * 1000).toISOString()
      : null
    return {
      ...fila,
      estado: estadoPublico(fila.estado),
      prioridad: Number(fila.prioridad ?? 0),
      // El recorrido del goteo: cuántos toques lleva desde su último pedido (0 = todavía ninguno,
      // 3 = ya se le mandaron los tres). El `toque` de la fila es el tramo de ESTA fila.
      toquesDesdeUltimoPedido: recupero.toquesDesdeUltimoPedido,
      ticketPromedio: cantidadPedidos > 0 ? totalGastado / cantidadPedidos : totalGastado,
      ultimoPedidoAt: iso(resumenPedidos?.ultimoPedidoAt ?? fila.ultimoPedidoAtSnapshot),
      dueDate: iso(fila.dueDate),
      enviadoAt: iso(fila.enviadoAt),
      protecciones: {
        horarioSilencioActivo: enHorarioSilencio(ahora),
        cooldownHasta,
        topeFrecuenciaAlcanzado: toques30Dias >= TOPE_MARKETING_POR_CLIENTE,
        toques30Dias,
        maximoToquesPor30Dias: TOPE_MARKETING_POR_CLIENTE,
        optOut: Boolean(fila.marketingOptOut),
      },
    }
  })
  const total = Number(conteo?.total ?? 0)
  return { items, pagina, limite, total, paginas: Math.ceil(total / limite) }
}

// ── Scheduler: tick del motor (para todos los locales con tandas vivas) ───────
/**
 * Corre el goteo de todos los locales que tengan tandas vivas. Pensado para un `setInterval` cada
 * ~15 min.
 *
 * Drena por VENCIMIENTO, no una vez por día: cada fila tiene su `dueDate` (el día y la hora
 * habituales del cliente, con el silencio 22–09 ya aplicado por el patrón), así que el tick levanta
 * lo que ya venció y el techo real es el cupo diario del local. Antes el local drenaba una sola vez
 * por día a una hora fija y el `horarioSugerido` que la pantalla prometía era decorativo.
 */
export async function tickMotorRecompra(db: Db, ahora: number = Date.now()): Promise<void> {
  if (enHorarioSilencio(ahora)) return

  const locales = await db
    .selectDistinct({ restauranteId: CampanaRecompraTable.restauranteId })
    .from(CampanaRecompraTable)
    .where(inArray(CampanaRecompraTable.estado, ['activa', 'completada']))

  for (const { restauranteId } of locales) {
    try {
      const config = await obtenerConfigMotor(db, restauranteId)

      if (config.estado === 'pausada_manual') continue
      if (config.estado === 'pausada_sin_saldo') {
        const wallet = await resumenWallet(db, restauranteId)
        if (wallet.marketing.disponible > 0) {
          await reanudarMotor(db, restauranteId)
        } else {
          await avisarPausaSinSaldoSiCorresponde(db, restauranteId, config, ahora)
          continue
        }
      }

      // Reconcilia seguimientos que hayan quedado sin encolar (proceso caído, filas previas a este
      // deploy). Es barato y corre antes del drenaje para que lo rescatado entre en este mismo tick.
      await sincronizarRecontactos(db, restauranteId, ahora)
      await procesarColaDelLocal(db, restauranteId, ahora)
    } catch (err) {
      console.error(`❌ [Motor recompra] tick falló para restaurante ${restauranteId}:`, err)
    }
  }
}

/** Hora de Argentina en la que conviene empezar el goteo del día (referencia operativa). */
export function horaArgentinaActual(ahora: number = Date.now()): number {
  return horaArgentina(ahora)
}

// ── Operación manual desde la cola ───────────────────────────────────────────

/** Las tres decisiones del operador sobre un envío puntual: mensaje, link y descuento. */
type OpcionesMensajeManual = Pick<OpcionesEnvioRecupero, 'receta' | 'segmento' | 'toque' | 'link' | 'descuento'>

/**
 * Obtiene los datos formateados del mensaje para una fila de la cola.
 *
 * El operador decide tres cosas: el MENSAJE (receta = segmento, más el toque), el LINK y el
 * DESCUENTO. Sin nada elegido se devuelve el default del motor: el segmento en vivo del cliente, el
 * toque que marca su escalera y el `%` de ese escalón. El toque de la fila se usa como default
 * cuando la fila ya lo trae (las que encola el goteo lo traen).
 */
export async function obtenerMensajeFilaCola(
  db: Db,
  restauranteId: number,
  filaId: number,
  opciones: OpcionesMensajeManual = {},
): Promise<{ ok: true; data: DatosMensajeRecupero } | { ok: false; mensaje: string }> {
  const [fila] = await db
    .select()
    .from(ColaRecompraTable)
    .where(and(eq(ColaRecompraTable.id, filaId), eq(ColaRecompraTable.restauranteId, restauranteId)))
    .limit(1)
  if (!fila) return { ok: false, mensaje: 'Elemento de cola no encontrado' }
  const prep = await prepararMensajeRecupero(db, restauranteId, fila.clienteId, {
    segmento: opciones.segmento ?? (esSegmentoRecompra(fila.segmento) ? fila.segmento : undefined),
    receta: opciones.receta,
    toque: opciones.toque ?? fila.toque ?? undefined,
    link: opciones.link,
    descuento: opciones.descuento,
  })
  if (!prep.ok) return { ok: false, mensaje: prep.mensaje }
  return {
    ok: true,
    data: {
      ...prep.data,
      horarioSugerido: fila.horarioSugerido ?? prep.data.horarioSugerido,
    },
  }
}

/** Marca una fila de la cola como enviada manualmente por el operador (sin consumir saldo marketing). */
export async function marcarFilaColaComoEnviadaManual(
  db: Db,
  restauranteId: number,
  filaId: number,
  opciones: OpcionesMensajeManual = {},
): Promise<{ ok: boolean; mensaje?: string; toque?: number; nivel?: number; descuento?: number; link?: string; codigoDescuento?: string | null }> {
  const [fila] = await db
    .select()
    .from(ColaRecompraTable)
    .where(and(eq(ColaRecompraTable.id, filaId), eq(ColaRecompraTable.restauranteId, restauranteId)))
    .limit(1)
  if (!fila) return { ok: false, mensaje: 'Elemento de la cola no encontrado' }
  if (fila.estado === 'enviado') return { ok: true, mensaje: 'Ya estaba marcado como enviado' }

  // Preparar cupón / escalón para asegurar consistencia del beneficio: acá es donde el cupón se
  // emite de verdad (el diálogo no toca la base). Se registra el beneficio que REALMENTE se mandó.
  const prep = await prepararMensajeRecupero(db, restauranteId, fila.clienteId, {
    segmento: opciones.segmento ?? (esSegmentoRecompra(fila.segmento) ? fila.segmento : undefined),
    receta: opciones.receta,
    toque: opciones.toque ?? fila.toque ?? undefined,
    link: opciones.link,
    descuento: opciones.descuento,
  })
  // El nivel sigue siendo el de la escalera: cambiar de receta, de link o de descuento no reinicia
  // el avance del cliente. El `toque` sí puede diferir del nivel: es el copy que el operador eligió.
  const nivel = prep.ok ? prep.data.nivel : (fila.nivel ?? 1)
  const toque = prep.ok ? prep.data.toque : (normalizarToque(fila.toque ?? 1))
  const link = prep.ok ? prep.data.link : 'lo-mismo'
  const codigoDescuento = prep.ok ? prep.data.codigoDescuento : (fila.codigoDescuento ?? null)
  const descuento = prep.ok ? prep.data.descuento : 0
  const plantillaWhatsapp = prep.ok ? prep.data.plantillaWhatsapp : PLANTILLA_RECUPERO_WHATSAPP

  await db
    .update(ColaRecompraTable)
    .set({
      rol: 'contactado',
      estado: 'enviado',
      enviadoAt: new Date(),
      ultimoIntentoAt: new Date(),
      origenContacto: 'manual',
      plantillaWhatsapp,
      errorEnvio: null,
      nivel,
      toque,
      linkModalidad: link,
      descuentoEnviado: descuento,
      codigoDescuento,
    })
    .where(eq(ColaRecompraTable.id, filaId))

  await db.insert(RecuperoClienteTable).values({
    restauranteId,
    clienteId: fila.clienteId,
    telefono: fila.telefono,
    nivel,
    toque,
    modalidad: link,
    descuentoPorcentaje: descuento,
    codigoDescuento,
    segmento: fila.segmento,
  })

  await db
    .update(CampanaRecompraTable)
    .set({
      totalEnviados: sql`${CampanaRecompraTable.totalEnviados} + 1`,
      totalContactados: sql`${CampanaRecompraTable.totalContactados} + 1`,
    })
    .where(eq(CampanaRecompraTable.id, fila.campanaId))

  // El toque siguiente se encola ACÁ: antes lo hacía el barrido perezoso al leer la cola, y ahora
  // que leer no escribe, el modo manual se quedaría sin 2º y 3º toque si no fuera por esta llamada.
  await programarToqueSiguienteDeFila(db, restauranteId, fila.campanaId, fila.clienteId, toque, Date.now())

  const [{ pendientesRestantes } = { pendientesRestantes: 0 }] = await db
    .select({ pendientesRestantes: sql<number>`count(*)` })
    .from(ColaRecompraTable)
    .where(
      and(
        eq(ColaRecompraTable.campanaId, fila.campanaId),
        eq(ColaRecompraTable.estado, 'pendiente'),
      ),
    )
  if (Number(pendientesRestantes) === 0) {
    await db.update(CampanaRecompraTable)
      .set({ estado: 'completada' })
      .where(and(eq(CampanaRecompraTable.id, fila.campanaId), eq(CampanaRecompraTable.estado, 'activa')))
  }

  return {
    ok: true,
    mensaje: 'Contacto manual registrado correctamente',
    toque,
    nivel,
    descuento,
    link,
    codigoDescuento,
  }
}

export { calcularPrioridadStock, ordenarPorPrioridad }
