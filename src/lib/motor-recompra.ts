// src/lib/motor-recompra.ts
//
// Motor de Recompra · GOTEO (piloto automático).
//
// Rediseño del 4.4: el motor deja de ser un "batch masivo por click" y pasa a ser una CAMPAÑA
// PERSISTENTE que gotea al ritmo de cada cliente. Tres piezas separadas:
//   1) DECISIÓN — humana, UNA vez: el dueño enciende la campaña (`activarMotor`).
//   2) EJECUCIÓN — automática, goteada: un job diario (`procesarColaDiaria`) drena la cola al cupo.
//   3) RENDICIÓN — visible siempre: consumo junto a retorno (`estadoMotor` → dashboard).
//
// Dos poblaciones (ver `cola_recompra`):
//   - FLUJO  → clientes que cruzan HOY su umbral personal. Máxima prioridad, nunca se posponen.
//   - STOCK  → el backlog de ya-fríos al encender. Se drena por prioridad (segmento × ticket).
//
// Anti-patrones prohibidos que este módulo respeta:
//   ❌ batch masivo (se gotea al cupo diario, tope duro de sistema para proteger el número ante Meta)
//   ❌ botón diario de "avanzar" (el goteo es automático; el dueño es espectador, no operador)
//   ❌ mendigar recarga / cortar en silencio (marketing en 0 → pausada_sin_saldo con aviso único)
//
// Reusa el mismo cerebro (RFM), escalera, cupón, deep link, protección de la base y consumo del
// wallet que el envío individual (4.2): `enviarRecuperoDormido` es el único camino de envío.

import { type MySql2Database } from 'drizzle-orm/mysql2'
import { and, eq, inArray, notInArray, lte, desc, sql } from 'drizzle-orm'
import {
  cliente as ClienteTable,
  restaurante as RestauranteTable,
  pedidoUnificado as PedidoUnificadoTable,
  campanaRecompra as CampanaRecompraTable,
  colaRecompra as ColaRecompraTable,
} from '../db/schema'
import {
  cargarCohorteRecompra,
  separarControl,
  enviarRecuperoDormido,
  SEGMENTOS_RECUPERABLES,
  PORCENTAJE_CONTROL,
  type ClienteCohorte,
} from './recupero'
import { enHorarioSilencio, horaArgentina } from './proteccion-base'
import { getOrCreateSaldo, marketingDisponible } from './mensajes-wallet'
import type { SegmentoCliente } from './clientes-rfm'

type Db = MySql2Database<Record<string, never>>

// ── Config del goteo ─────────────────────────────────────────────────────────
/** Cupo diario por defecto: warm-up del número + cocina sin picos. Se comunica como feature. */
export const CUPO_DIARIO_DEFAULT = 30
/** Mínimo razonable (un motor que gotea 2/día no drena nunca). */
export const CUPO_DIARIO_MIN = 5
/** Tope DURO de sistema: aunque el dueño ansioso lo suba, nunca se pasa de acá (protege el número). */
export const CUPO_DIARIO_MAX = 60
/** Hora de Argentina objetivo del goteo diario (antes del pico de pedidos; default si no hay dato). */
export const HORA_ENVIO_DEFAULT = 11
/** Días entre recordatorios cuando la campaña está pausada por saldo (1/semana, nunca súplica diaria). */
export const RECORDATORIO_SIN_SALDO_DIAS = 7

/** Peso del segmento para drenar el stock: en_riesgo primero (mejor tasa de retorno), perdido al final. */
const PESO_SEGMENTO_STOCK: Record<string, number> = { en_riesgo: 3, dormido: 2, perdido: 1 }

export type EstadoCampana = 'activa' | 'pausada_sin_saldo' | 'pausada_manual' | 'completada'

const MS_POR_DIA = 1000 * 60 * 60 * 24

/** Día de Argentina (UTC-3) como "YYYY-MM-DD" — clave estable para el contador diario del cupo. */
function diaArgentina(ahora: number = Date.now()): string {
  return new Date(ahora - 3 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** true si la campaña procesa envíos hoy (activa = flujo+stock; completada = solo flujo permanente). */
function esProcesable(estado: string | null): boolean {
  return estado === 'activa' || estado === 'completada'
}

/**
 * Prioridad para drenar el stock: el segmento manda (en_riesgo > dormido > perdido) y dentro de cada
 * segmento, el ticket histórico descendente. Se codifica en un solo número: peso × 10M + ticket capado.
 */
function calcularPrioridad(segmento: string, ticket: number): number {
  const peso = PESO_SEGMENTO_STOCK[segmento] ?? 1
  return peso * 10_000_000 + Math.min(Math.round(ticket), 9_999_999)
}

// Contexto mínimo para `env()` de Hono cuando el envío corre fuera de un request (job/scheduler).
const fakeCtx = { env: process.env } as any

// ── Campaña vigente ──────────────────────────────────────────────────────────
export type CampanaRow = typeof CampanaRecompraTable.$inferSelect

/** La campaña "viva" del local: la última fila con estado no-null (ignora los batch legacy). */
export async function getCampanaActual(db: Db, restauranteId: number): Promise<CampanaRow | null> {
  const [row] = await db
    .select()
    .from(CampanaRecompraTable)
    .where(
      and(
        eq(CampanaRecompraTable.restauranteId, restauranteId),
        inArray(CampanaRecompraTable.estado, [
          'activa',
          'pausada_sin_saldo',
          'pausada_manual',
          'completada',
        ]),
      ),
    )
    .orderBy(desc(CampanaRecompraTable.id))
    .limit(1)
  return row ?? null
}

// ── Encendido (la DECISIÓN humana, una sola vez) ─────────────────────────────
export interface ResultadoActivar {
  ok: boolean
  yaActiva?: boolean
  vacio?: boolean
  campanaId?: number
  totalDetectados: number
  totalContactar: number
  totalControl: number
  cupoDiario: number
  /** Resultado del primer goteo disparado al encender (si no era horario de silencio). */
  primerGoteo?: ResultadoGoteo
}

/**
 * Enciende el motor: detecta la cohorte de ya-fríos (stock), aparta el 10% de control por segmento y
 * carga TODO en la cola de envíos con su prioridad. No manda todo de una: dispara el primer goteo
 * (respeta cupo/silencio) y deja el resto pendiente para el job diario.
 */
export async function activarMotor(
  db: Db,
  restauranteId: number,
  cupoDiario?: number,
): Promise<ResultadoActivar> {
  const actual = await getCampanaActual(db, restauranteId)
  if (actual) {
    // Ya hay una campaña viva (activa/completada/pausada). No se re-enciende: se reanuda/gestiona.
    return {
      ok: true,
      yaActiva: true,
      campanaId: actual.id,
      totalDetectados: 0,
      totalContactar: 0,
      totalControl: 0,
      cupoDiario: actual.cupoDiario,
    }
  }

  const cupo = clampCupo(cupoDiario ?? CUPO_DIARIO_DEFAULT)

  const cohorte = await cargarCohorteRecompra(db, restauranteId)
  if (cohorte.length === 0) {
    return { ok: true, vacio: true, totalDetectados: 0, totalContactar: 0, totalControl: 0, cupoDiario: cupo }
  }

  const { contactar, control } = separarControl(cohorte)

  const [ins] = await db.insert(CampanaRecompraTable).values({
    restauranteId,
    estado: 'activa',
    cupoDiario: cupo,
    diaContador: diaArgentina(),
    enviadosHoy: 0,
    totalEnviados: 0,
    totalDetectados: cohorte.length,
    totalControl: control.length,
    totalContactados: 0,
    totalFallidos: 0,
    activadaAt: new Date(),
  })
  const campanaId = Number((ins as any).insertId)

  // Grupo de control → a la cola como 'control' (no se contacta; sirve para la atribución honesta).
  for (const cl of control) {
    await db.insert(ColaRecompraTable).values({
      restauranteId,
      campanaId,
      clienteId: cl.clienteId,
      telefono: cl.telefono,
      segmento: cl.segmento,
      prioridad: '0.00',
      poblacion: 'stock',
      rol: 'control',
      dueDate: null,
      estado: 'control',
      ...snapshot(cl),
    })
  }

  // Stock a contactar → cola 'pendiente', ordenado por prioridad. dueDate = ahora (drenar lo antes posible).
  for (const cl of contactar) {
    const ticket = cl.cantidadPedidos > 0 ? cl.totalGastado / cl.cantidadPedidos : cl.totalGastado
    await db.insert(ColaRecompraTable).values({
      restauranteId,
      campanaId,
      clienteId: cl.clienteId,
      telefono: cl.telefono,
      segmento: cl.segmento,
      prioridad: calcularPrioridad(cl.segmento, ticket).toFixed(2),
      poblacion: 'stock',
      rol: 'contactado',
      dueDate: new Date(),
      estado: 'pendiente',
      ...snapshot(cl),
    })
  }

  // Primer goteo (si no es horario de silencio): que el dueño vea el motor arrancar.
  const primerGoteo = await procesarColaDiaria(db, restauranteId)

  return {
    ok: true,
    campanaId,
    totalDetectados: cohorte.length,
    totalContactar: contactar.length,
    totalControl: control.length,
    cupoDiario: cupo,
    primerGoteo,
  }
}

function snapshot(cl: ClienteCohorte) {
  return {
    totalGastadoSnapshot: cl.totalGastado.toFixed(2),
    ultimoPedidoAtSnapshot: cl.ultimoPedidoMs != null ? new Date(cl.ultimoPedidoMs) : null,
  }
}

function clampCupo(n: number): number {
  if (!Number.isFinite(n)) return CUPO_DIARIO_DEFAULT
  return Math.max(CUPO_DIARIO_MIN, Math.min(CUPO_DIARIO_MAX, Math.round(n)))
}

// ── Goteo diario (la EJECUCIÓN automática) ───────────────────────────────────
export interface ResultadoGoteo {
  ok: boolean
  motivo?: 'sin_campana' | 'pausada' | 'silencio' | 'cupo_agotado' | 'sin_saldo' | 'nada_que_enviar'
  flujoEnviados: number
  stockEnviados: number
  enviados: number
  fallidos: number
  pausadaSinSaldo?: boolean
  completada?: boolean
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

/**
 * Drena la cola de UN local respetando el cupo diario, el horario de silencio y el saldo marketing.
 * Orden: (1) FLUJO — todos los que cruzan hoy su umbral (aunque excedan un poco el cupo); (2) STOCK —
 * con la capacidad restante, por prioridad. Cada envío descuenta 1 marketing; si el saldo llega a 0,
 * la campaña pasa a `pausada_sin_saldo` (ninguna campaña genera deuda). Idempotente por día (contador).
 */
export async function procesarColaDiaria(
  db: Db,
  restauranteId: number,
  ahora: number = Date.now(),
): Promise<ResultadoGoteo> {
  const campana = await getCampanaActual(db, restauranteId)
  if (!campana) return goteoVacio('sin_campana')
  if (!esProcesable(campana.estado)) return goteoVacio('pausada')

  // Protección de la base: nunca marketing de madrugada. El job reintenta en el próximo tick del día.
  if (enHorarioSilencio(ahora)) return goteoVacio('silencio')

  // Contador diario del cupo (se resetea al cambiar de día de Argentina).
  const hoy = diaArgentina(ahora)
  let enviadosHoy = campana.diaContador === hoy ? campana.enviadosHoy : 0
  const cupo = clampCupo(campana.cupoDiario)
  let cupoRestante = cupo - enviadosHoy
  if (cupoRestante <= 0) {
    if (campana.diaContador !== hoy) {
      await db.update(CampanaRecompraTable).set({ diaContador: hoy, enviadosHoy: 0 }).where(eq(CampanaRecompraTable.id, campana.id))
    }
    return goteoVacio('cupo_agotado')
  }

  // Saldo marketing: los mensajes de campaña SÍ se pausan en 0 (a diferencia de los utility de pedido).
  const saldo = await getOrCreateSaldo(db, restauranteId)
  let marketing = marketingDisponible(saldo)
  if (marketing <= 0) {
    await pausarPorSaldo(db, campana, ahora)
    return { ...goteoVacio('sin_saldo'), pausadaSinSaldo: true }
  }

  let flujoEnviados = 0
  let stockEnviados = 0
  let fallidos = 0

  // (1) FLUJO — detectar y encolar a los que cruzan HOY su umbral, y mandarles ya (máxima prioridad).
  if (campana.estado === 'activa' || campana.estado === 'completada') {
    const nuevosFlujo = await detectarFlujo(db, restauranteId, campana.id)
    for (const cl of nuevosFlujo) {
      if (marketing <= 0) break
      const ticket = cl.cantidadPedidos > 0 ? cl.totalGastado / cl.cantidadPedidos : cl.totalGastado
      const [ins] = await db.insert(ColaRecompraTable).values({
        restauranteId,
        campanaId: campana.id,
        clienteId: cl.clienteId,
        telefono: cl.telefono,
        segmento: cl.segmento,
        prioridad: calcularPrioridad(cl.segmento, ticket).toFixed(2),
        poblacion: 'flujo',
        rol: 'contactado',
        dueDate: new Date(ahora),
        estado: 'pendiente',
        ...snapshot(cl),
      })
      const filaId = Number((ins as any).insertId)
      const r = await enviarFila(db, restauranteId, filaId, cl.clienteId)
      if (r.enviado) { flujoEnviados++; enviadosHoy++; marketing--; if (marketing <= 0) { break } }
      else if (r.fallido) fallidos++
    }
  }

  // (2) STOCK — con la capacidad restante del cupo, por prioridad descendente. Incluye también los
  //     eventuales pendientes de flujo de días anteriores (quedaron por saldo): su prioridad los ordena.
  cupoRestante = cupo - enviadosHoy
  if (marketing > 0 && cupoRestante > 0) {
    const pendientes = await db
      .select()
      .from(ColaRecompraTable)
      .where(
        and(
          eq(ColaRecompraTable.restauranteId, restauranteId),
          eq(ColaRecompraTable.campanaId, campana.id),
          eq(ColaRecompraTable.estado, 'pendiente'),
          lte(ColaRecompraTable.dueDate, new Date(ahora)),
        ),
      )
      .orderBy(desc(ColaRecompraTable.prioridad))
      .limit(cupoRestante)

    for (const fila of pendientes) {
      if (marketing <= 0) break
      const r = await enviarFila(db, restauranteId, fila.id, fila.clienteId)
      if (r.enviado) { stockEnviados++; enviadosHoy++; marketing-- }
      else if (r.fallido) fallidos++
    }
  }

  // Persistir contadores del día.
  const enviados = flujoEnviados + stockEnviados
  await db
    .update(CampanaRecompraTable)
    .set({
      diaContador: hoy,
      enviadosHoy,
      totalEnviados: sql`${CampanaRecompraTable.totalEnviados} + ${enviados}`,
      totalContactados: sql`${CampanaRecompraTable.totalContactados} + ${enviados}`,
      totalFallidos: sql`${CampanaRecompraTable.totalFallidos} + ${fallidos}`,
    })
    .where(eq(CampanaRecompraTable.id, campana.id))

  // ¿Quedó stock pendiente? Si se drenó y la campaña estaba 'activa', pasa a 'completada'
  // (modo flujo permanente: sigue atendiendo a los que cruzan su umbral, ya sin backlog).
  const [{ pendientesRestantes } = { pendientesRestantes: 0 }] = await db
    .select({ pendientesRestantes: sql<number>`count(*)` })
    .from(ColaRecompraTable)
    .where(
      and(
        eq(ColaRecompraTable.campanaId, campana.id),
        eq(ColaRecompraTable.estado, 'pendiente'),
        eq(ColaRecompraTable.poblacion, 'stock'),
      ),
    )

  let completada = false
  if (Number(pendientesRestantes) === 0 && campana.estado === 'activa') {
    await db.update(CampanaRecompraTable).set({ estado: 'completada' }).where(eq(CampanaRecompraTable.id, campana.id))
    completada = true
  }

  // Si el saldo se agotó a mitad del goteo, pausar (con aviso único).
  if (marketing <= 0) {
    const refresco = await getCampanaActual(db, restauranteId)
    if (refresco && esProcesable(refresco.estado)) await pausarPorSaldo(db, refresco, ahora)
  }

  return {
    ok: true,
    motivo: enviados === 0 ? 'nada_que_enviar' : undefined,
    flujoEnviados,
    stockEnviados,
    enviados,
    fallidos,
    completada,
    pausadaSinSaldo: marketing <= 0,
    enColaRestante: Number(pendientesRestantes),
  }
}

/** Envía el toque de una fila de la cola y actualiza su estado. */
async function enviarFila(
  db: Db,
  restauranteId: number,
  filaId: number,
  clienteId: number,
): Promise<{ enviado: boolean; fallido: boolean }> {
  // Regla sagrada / protección: si el cliente ya no es contactable (pidió, opt-out, tope, cooldown),
  // `enviarRecuperoDormido` lo rechaza sin mandar nada; marcamos la fila como salida/fallida.
  let res
  try {
    res = await enviarRecuperoDormido(fakeCtx, db, restauranteId, clienteId)
  } catch (err) {
    console.error(`❌ [Motor goteo] Error enviando a cliente ${clienteId}:`, err)
    await db.update(ColaRecompraTable).set({ estado: 'fallido' }).where(eq(ColaRecompraTable.id, filaId))
    return { enviado: false, fallido: true }
  }

  if (res.ok) {
    await db
      .update(ColaRecompraTable)
      .set({ estado: 'enviado', enviadoAt: new Date(), nivel: res.nivel ?? null, codigoDescuento: res.codigoDescuento ?? null })
      .where(eq(ColaRecompraTable.id, filaId))
    return { enviado: true, fallido: false }
  }

  // Bloqueos "no ahora" (cooldown/tope/silencio/opt-out) → dejamos la fila pendiente salvo opt-out.
  if (res.motivo === 'opt_out') {
    await db.update(ColaRecompraTable).set({ estado: 'salido' }).where(eq(ColaRecompraTable.id, filaId))
    return { enviado: false, fallido: false }
  }
  if (res.motivo === 'cooldown' || res.motivo === 'tope_mensual' || res.motivo === 'horario_silencio') {
    return { enviado: false, fallido: false } // se reintenta otro día
  }
  // sin_telefono / envio_fallido / cliente_no_encontrado → fallido.
  await db.update(ColaRecompraTable).set({ estado: 'fallido' }).where(eq(ColaRecompraTable.id, filaId))
  return { enviado: false, fallido: true }
}

/**
 * Detecta la población de FLUJO: clientes recuperables (hoy en `en_riesgo`, la transición más fresca)
 * que todavía NO están en la cola de esta campaña. Son los que "cruzan hoy" su umbral personal: su día
 * justo es hoy. Se reusa la cohorte del cerebro RFM (que ya excluye opt-out, tope y cooldown).
 */
async function detectarFlujo(
  db: Db,
  restauranteId: number,
  campanaId: number,
): Promise<ClienteCohorte[]> {
  const cohorte = await cargarCohorteRecompra(db, restauranteId)
  const enRiesgo = cohorte.filter((c) => c.segmento === 'en_riesgo')
  if (enRiesgo.length === 0) return []

  // Excluir a los que ya están en la cola de esta campaña (cualquier estado / rol).
  const yaEnCola = await db
    .select({ clienteId: ColaRecompraTable.clienteId })
    .from(ColaRecompraTable)
    .where(and(eq(ColaRecompraTable.campanaId, campanaId), inArray(ColaRecompraTable.clienteId, enRiesgo.map((c) => c.clienteId))))
  const set = new Set(yaEnCola.map((r) => r.clienteId))
  return enRiesgo.filter((c) => !set.has(c.clienteId))
}

/** Pausa la campaña por saldo agotado. Aviso ÚNICO (o 1/semana): nunca súplica, nunca deuda. */
async function pausarPorSaldo(db: Db, campana: CampanaRow, ahora: number): Promise<void> {
  const ultimo = campana.avisoSinSaldoAt ? new Date(campana.avisoSinSaldoAt).getTime() : 0
  const avisar = ahora - ultimo >= RECORDATORIO_SIN_SALDO_DIAS * MS_POR_DIA
  await db
    .update(CampanaRecompraTable)
    .set({
      estado: 'pausada_sin_saldo',
      pausadaAt: new Date(ahora),
      ...(avisar ? { avisoSinSaldoAt: new Date(ahora) } : {}),
    })
    .where(eq(CampanaRecompraTable.id, campana.id))
}

// ── Regla sagrada: el cliente pidió → sale de la cola INMEDIATAMENTE ─────────
/**
 * Nada peor que un "te extrañamos" a quien pidió ayer. Cuando entra un pedido de un cliente, sus filas
 * pendientes salen de la cola en tiempo real (no se espera al job diario). Best-effort: nunca frena el
 * alta del pedido. Cablear en el alta de pedidos (público).
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
          eq(ColaRecompraTable.estado, 'pendiente'),
        ),
      )
  } catch (err) {
    console.error('❌ [Motor goteo] Error sacando cliente de la cola tras pedido:', err)
  }
}

// ── Contacto manual (la válvula del dueño) vs. grupo de control ──────────────
/**
 * El botón "Recuperar" per-cliente (4.2) es la válvula del dueño: puede escribirle a mano a quien quiera.
 * PERO si ese cliente estaba en el GRUPO DE CONTROL de la campaña activa, contactarlo a mano rompe la
 * atribución honesta: si después vuelve, se contaría como "volvió solo" (control), inflando la tasa del
 * control y subestimando el uplift del Motor (justo el número que vende los packs). La regla: un envío
 * manual RECLASIFICA al cliente como CONTACTADO en el mismo momento (sale del control), y marca su
 * eventual fila pendiente como enviada (fue contactado ya). Best-effort: nunca frena el envío al comensal.
 */
export async function registrarContactoManual(
  db: Db,
  restauranteId: number,
  clienteId: number,
  datos: { nivel?: number | null; codigoDescuento?: string | null } = {},
): Promise<void> {
  try {
    const campana = await getCampanaActual(db, restauranteId)
    if (!campana) return // sin campaña viva no hay control que contaminar

    const filas = await db
      .select({ id: ColaRecompraTable.id, rol: ColaRecompraTable.rol, estado: ColaRecompraTable.estado })
      .from(ColaRecompraTable)
      .where(
        and(
          eq(ColaRecompraTable.campanaId, campana.id),
          eq(ColaRecompraTable.clienteId, clienteId),
        ),
      )

    for (const fila of filas) {
      // Control o pendiente → pasa a contactado/enviado (fue contactado, aunque a mano).
      if (fila.rol === 'control' || fila.estado === 'pendiente' || fila.estado === 'control') {
        await db
          .update(ColaRecompraTable)
          .set({
            rol: 'contactado',
            estado: 'enviado',
            enviadoAt: new Date(),
            nivel: datos.nivel ?? null,
            codigoDescuento: datos.codigoDescuento ?? null,
          })
          .where(eq(ColaRecompraTable.id, fila.id))
      }
    }
  } catch (err) {
    console.error('❌ [Motor goteo] Error reclasificando contacto manual:', err)
  }
}

// ── Controles humanos (baja frecuencia, siempre disponibles) ─────────────────
export async function pausarMotorManual(db: Db, restauranteId: number): Promise<boolean> {
  const campana = await getCampanaActual(db, restauranteId)
  if (!campana) return false
  await db
    .update(CampanaRecompraTable)
    .set({ estado: 'pausada_manual', pausadaAt: new Date() })
    .where(eq(CampanaRecompraTable.id, campana.id))
  return true
}

export async function reanudarMotor(db: Db, restauranteId: number): Promise<boolean> {
  const campana = await getCampanaActual(db, restauranteId)
  if (!campana) return false
  // Al reanudar: si aún queda stock pendiente vuelve a 'activa'; si no, a 'completada' (modo flujo).
  const [{ pend } = { pend: 0 }] = await db
    .select({ pend: sql<number>`count(*)` })
    .from(ColaRecompraTable)
    .where(
      and(
        eq(ColaRecompraTable.campanaId, campana.id),
        eq(ColaRecompraTable.estado, 'pendiente'),
        eq(ColaRecompraTable.poblacion, 'stock'),
      ),
    )
  const estado: EstadoCampana = Number(pend) > 0 ? 'activa' : 'completada'
  await db.update(CampanaRecompraTable).set({ estado, pausadaAt: null }).where(eq(CampanaRecompraTable.id, campana.id))
  return true
}

export async function setCupoDiario(db: Db, restauranteId: number, cupoDiario: number): Promise<number | null> {
  const campana = await getCampanaActual(db, restauranteId)
  if (!campana) return null
  const cupo = clampCupo(cupoDiario)
  await db.update(CampanaRecompraTable).set({ cupoDiario: cupo }).where(eq(CampanaRecompraTable.id, campana.id))
  return cupo
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
}

export interface DashboardCampana {
  estado: EstadoCampana
  cupoDiario: number
  enviadosHoy: number
  totalEnviados: number
  enCola: number
  contactados: number
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
  activa: boolean
  campana: DashboardCampana | null
  plan: PlanActivacion | null
  saldoMarketing: number
}

/** Arma la pantalla del motor: un PLAN si está apagado, o el marcador (dashboard) si está encendido. */
export async function estadoMotor(db: Db, restauranteId: number): Promise<EstadoMotor> {
  const saldo = await getOrCreateSaldo(db, restauranteId)
  const saldoMarketing = marketingDisponible(saldo)
  const campana = await getCampanaActual(db, restauranteId)

  if (!campana) {
    const plan = await construirPlan(db, restauranteId, saldoMarketing)
    return { activa: false, campana: null, plan, saldoMarketing }
  }

  const dashboard = await construirDashboard(db, restauranteId, campana, saldoMarketing)
  return { activa: true, campana: dashboard, plan: null, saldoMarketing }
}

async function construirPlan(db: Db, restauranteId: number, saldoMarketing: number): Promise<PlanActivacion> {
  const cohorte = await cargarCohorteRecompra(db, restauranteId)
  const porSegMap: Record<string, ClienteCohorte[]> = {}
  for (const cl of cohorte) (porSegMap[cl.segmento] ??= []).push(cl)

  const porSegmento = SEGMENTOS_RECUPERABLES.filter((s) => (porSegMap[s]?.length ?? 0) > 0).map((s) => {
    const arr = porSegMap[s] ?? []
    return {
      segmento: s,
      detectados: arr.length,
      facturacionEnJuego: arr.reduce((acc, c) => acc + c.totalGastado, 0),
    }
  })

  const totalControl = Object.values(porSegMap).reduce((acc, arr) => acc + Math.round(arr.length * PORCENTAJE_CONTROL), 0)
  // Propuesta: arrancar por el mejor segmento presente (en_riesgo primero: mejor tasa de retorno).
  const primerSegmento = (SEGMENTOS_RECUPERABLES.find((s) => (porSegMap[s]?.length ?? 0) > 0) ?? null) as SegmentoCliente | null
  const cupoSugerido = CUPO_DIARIO_DEFAULT
  const diasCubiertos = saldoMarketing > 0 ? Math.max(1, Math.floor(saldoMarketing / cupoSugerido)) : 0

  return {
    totalDetectados: cohorte.length,
    totalContactar: cohorte.length - totalControl,
    totalControl,
    porSegmento,
    primerSegmento,
    cupoSugerido,
    saldoMarketing,
    diasCubiertos,
  }
}

async function construirDashboard(
  db: Db,
  restauranteId: number,
  campana: CampanaRow,
  saldoMarketing: number,
): Promise<DashboardCampana> {
  // Miembros de la campaña por rol/estado.
  const filas = await db
    .select({
      clienteId: ColaRecompraTable.clienteId,
      rol: ColaRecompraTable.rol,
      estado: ColaRecompraTable.estado,
      enviadoAt: ColaRecompraTable.enviadoAt,
    })
    .from(ColaRecompraTable)
    .where(eq(ColaRecompraTable.campanaId, campana.id))

  const contactadosEnviados = filas.filter((f) => f.rol === 'contactado' && f.estado === 'enviado')
  const control = filas.filter((f) => f.rol === 'control')
  const enCola = filas.filter((f) => f.estado === 'pendiente').length

  // Atribución: ¿volvió a pedir DESPUÉS del toque? (contactados) / después de encender (control).
  const referencia = campana.activadaAt ? new Date(campana.activadaAt) : new Date(campana.createdAt)
  const clientesRelevantes = [...contactadosEnviados.map((f) => f.clienteId), ...control.map((f) => f.clienteId)]

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

    // Índice: primer pedido de cada cliente después de su fecha de referencia.
    const enviadoPorCliente = new Map<number, number>()
    for (const f of contactadosEnviados) if (f.enviadoAt) enviadoPorCliente.set(f.clienteId, new Date(f.enviadoAt).getTime())
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

  const tasaContactados = contactadosEnviados.length > 0 ? volvieron / contactadosEnviados.length : 0
  const tasaControl = control.length > 0 ? controlVolvieron / control.length : 0

  return {
    estado: (campana.estado ?? 'activa') as EstadoCampana,
    cupoDiario: clampCupo(campana.cupoDiario),
    enviadosHoy: campana.diaContador === diaArgentina() ? campana.enviadosHoy : 0,
    totalEnviados: campana.totalEnviados,
    enCola,
    contactados: contactadosEnviados.length,
    volvieron,
    plataRecuperada,
    control: control.length,
    controlVolvieron,
    tasaContactados,
    tasaControl,
    saldoMarketing,
    activadaAt: campana.activadaAt ? new Date(campana.activadaAt).toISOString() : null,
    pausadaAt: campana.pausadaAt ? new Date(campana.pausadaAt).toISOString() : null,
  }
}

// ── Scheduler: tick del motor (para todos los locales con campaña procesable) ─
/**
 * Corre el goteo de todos los locales que tengan campaña procesable y cuya hora objetivo ya llegó,
 * una vez por día. Pensado para un `setInterval` cada ~15 min. La hora objetivo se apunta antes del
 * pico de pedidos del local (aprox. de sus datos); default `HORA_ENVIO_DEFAULT`. Idempotente: si el
 * contador diario ya es de hoy, no vuelve a drenar (el goteo del día ya salió).
 */
export async function tickMotorRecompra(db: Db, ahora: number = Date.now()): Promise<void> {
  if (enHorarioSilencio(ahora)) return
  const hora = horaArgentina(ahora)
  const hoy = diaArgentina(ahora)

  const campanas = await db
    .select({
      id: CampanaRecompraTable.id,
      restauranteId: CampanaRecompraTable.restauranteId,
      diaContador: CampanaRecompraTable.diaContador,
    })
    .from(CampanaRecompraTable)
    .where(inArray(CampanaRecompraTable.estado, ['activa', 'completada']))

  for (const camp of campanas) {
    if (camp.diaContador === hoy) continue // ya goteó hoy
    // Hora objetivo del local (antes del pico). Si todavía no llegó, esperamos al próximo tick.
    const horaObjetivo = await horaObjetivoLocal(db, camp.restauranteId)
    if (hora < horaObjetivo) continue
    try {
      await procesarColaDiaria(db, camp.restauranteId, ahora)
    } catch (err) {
      console.error(`❌ [Motor goteo] tick falló para restaurante ${camp.restauranteId}:`, err)
    }
  }
}

/** Hora de Argentina en la que conviene gotear: ~2 hs antes del pico de pedidos del local. */
async function horaObjetivoLocal(db: Db, restauranteId: number): Promise<number> {
  try {
    const pedidos = await db
      .select({ createdAt: PedidoUnificadoTable.createdAt })
      .from(PedidoUnificadoTable)
      .where(eq(PedidoUnificadoTable.restauranteId, restauranteId))
      .orderBy(desc(PedidoUnificadoTable.createdAt))
      .limit(500)
    if (pedidos.length < 20) return HORA_ENVIO_DEFAULT
    const conteo = new Array(24).fill(0)
    for (const p of pedidos) conteo[horaArgentina(new Date(p.createdAt).getTime())]++
    let horaPico = HORA_ENVIO_DEFAULT
    let max = -1
    for (let h = 0; h < 24; h++) if (conteo[h] > max) { max = conteo[h]; horaPico = h }
    // ~2 hs antes del pico, acotado a una franja diurna razonable [9, 20].
    return Math.max(9, Math.min(20, horaPico - 2))
  } catch {
    return HORA_ENVIO_DEFAULT
  }
}
