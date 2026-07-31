// src/lib/suscripciones.ts
// Cobro de la cuota mensual del plan mediante pagos ÚNICOS de Checkout Pro (NO las
// suscripciones recurrentes de MercadoPago). Cada pago aprobado extiende la
// suscripción un ciclo y le da acceso completo a las features del plan. La renovación
// es manual: el local vuelve a pagar cuando se acerca (o pasa) fechaProximoCobro.
//
// Regla dura del negocio: NUNCA cortar en seco. Un pago vencido pasa a período de
// gracia (pago_pendiente) y recién al agotarse la gracia se suspende — eso lo maneja
// el motor de estados (lazy, ver resolverEstadoVigente).
import { type MySql2Database } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import {
  plan as PlanTable,
  suscripcion as SuscripcionTable,
  pagoSuscripcion as PagoSuscripcionTable,
} from '../db/schema'
import { SUSCRIPCION_ESTADOS } from './planes'
import { acreditarCupoPlan } from './mensajes-wallet'

type Db = MySql2Database<Record<string, never>>

export type CicloPago = 'mensual' | 'anual'

/** Días de gracia tras vencer el cobro antes de suspender (nunca se corta en seco). */
export const DIAS_GRACIA = 7

/** Suma meses a una fecha respetando fin de mes (30 ene + 1 mes = 28/29 feb). */
function addMonths(fecha: Date, meses: number): Date {
  const d = new Date(fecha)
  const diaOriginal = d.getDate()
  d.setMonth(d.getMonth() + meses)
  // Si el mes destino no tiene ese día, JS lo "desborda"; lo corregimos al último día.
  if (d.getDate() < diaOriginal) d.setDate(0)
  return d
}

function largoCicloMeses(ciclo: CicloPago): number {
  return ciclo === 'anual' ? 12 : 1
}

/** Precio a cobrar por un plan/ciclo (autoritativo del servidor). Anual = 12 × mensual. */
export function montoPorCiclo(precioMensual: number, ciclo: CicloPago): number {
  return ciclo === 'anual' ? precioMensual * 12 : precioMensual
}

/**
 * Crea un pago de suscripción en estado 'pending' (aún NO da acceso; se activa en el
 * webhook al aprobarse). El monto SIEMPRE sale del precio del plan en la DB.
 */
export async function crearPagoSuscripcionPendiente(
  db: Db,
  restauranteId: number,
  opts: { planId: number; ciclo: CicloPago; monto: number },
): Promise<number> {
  const insert = await db.insert(PagoSuscripcionTable).values({
    restauranteId,
    planId: opts.planId,
    ciclo: opts.ciclo,
    monto: opts.monto.toFixed(2),
    estado: 'pending',
  })
  return Number((insert as any)[0].insertId)
}

/** Guarda el preference_id de MercadoPago sobre un pago pendiente. */
export async function setPagoSuscripcionPreferencia(
  db: Db,
  pagoId: number,
  mpPreferenceId: string,
): Promise<void> {
  await db
    .update(PagoSuscripcionTable)
    .set({ mpPreferenceId })
    .where(eq(PagoSuscripcionTable.id, pagoId))
}

/**
 * Confirma un pago de suscripción tras el pago aprobado en MercadoPago. Idempotente:
 * si el pago ya estaba 'paid' no vuelve a acreditar. Efecto:
 *  - marca el pago 'paid' + guarda periodo de cobertura
 *  - upsert de la suscripción: plan del pago, estado 'activa', extiende fechaProximoCobro
 *  - acredita el cupo utility del nuevo plan de inmediato
 */
export async function confirmarPagoSuscripcion(
  db: Db,
  pagoId: number,
  opts: { mpPaymentId: string },
): Promise<{
  yaProcesado: boolean
  restauranteId: number
  planId: number
  periodoHasta: Date | null
} | null> {
  const [pago] = await db
    .select()
    .from(PagoSuscripcionTable)
    .where(eq(PagoSuscripcionTable.id, pagoId))
    .limit(1)
  if (!pago) return null

  if (pago.estado === 'paid') {
    return {
      yaProcesado: true,
      restauranteId: pago.restauranteId,
      planId: pago.planId,
      periodoHasta: pago.periodoHasta ? new Date(pago.periodoHasta) : null,
    }
  }

  const ciclo = pago.ciclo as CicloPago
  const meses = largoCicloMeses(ciclo)
  const ahora = new Date()

  // Plan pagado (para cupo de mensajes y precio congelado).
  const [planRow] = await db
    .select()
    .from(PlanTable)
    .where(eq(PlanTable.id, pago.planId))
    .limit(1)

  // Suscripción vigente (si existe) para decidir si extendemos o arrancamos de cero.
  const [subActual] = await db
    .select()
    .from(SuscripcionTable)
    .where(eq(SuscripcionTable.restauranteId, pago.restauranteId))
    .limit(1)

  // Base de extensión: si sigue vigente el MISMO plan y su próximo cobro es futuro,
  // se acumula (renovación anticipada); si no, arranca desde ahora (alta o cambio de plan).
  const proximoCobroActual = subActual?.fechaProximoCobro ? new Date(subActual.fechaProximoCobro) : null
  const mismoPlan = subActual?.planId === pago.planId
  const base =
    mismoPlan && proximoCobroActual && proximoCobroActual > ahora ? proximoCobroActual : ahora
  const periodoHasta = addMonths(base, meses)

  // 1. Marcar el pago como acreditado.
  await db
    .update(PagoSuscripcionTable)
    .set({
      estado: 'paid',
      mpPaymentId: opts.mpPaymentId,
      periodoDesde: base,
      periodoHasta,
    })
    .where(eq(PagoSuscripcionTable.id, pagoId))

  // 2. Upsert de la suscripción → activa, extendida.
  const precioMensual = planRow ? String(planRow.precioMensual) : pago.monto
  if (subActual) {
    await db
      .update(SuscripcionTable)
      .set({
        planId: pago.planId,
        estado: SUSCRIPCION_ESTADOS.ACTIVA,
        ciclo,
        fechaProximoCobro: periodoHasta,
        graciaHasta: null,
        fechaCancelacion: null,
        precioMensual,
        updatedAt: ahora,
      })
      .where(eq(SuscripcionTable.restauranteId, pago.restauranteId))
  } else {
    await db.insert(SuscripcionTable).values({
      restauranteId: pago.restauranteId,
      planId: pago.planId,
      estado: SUSCRIPCION_ESTADOS.ACTIVA,
      ciclo,
      fechaInicio: ahora,
      fechaProximoCobro: periodoHasta,
      precioMensual,
    })
  }

  // 3. Acreditar el cupo utility del nuevo plan de inmediato (solo si cambió el plan
  //    o es alta; en una renovación del mismo plan el cupo ya se resetea por ciclo).
  if (planRow && (!subActual || !mismoPlan)) {
    try {
      await acreditarCupoPlan(db, pago.restauranteId, {
        mensajesIncluidos: planRow.mensajesIncluidos ?? 0,
        ilimitado: !!planRow.mensajesIlimitados,
      })
    } catch (err) {
      // El wallet es best-effort: nunca debe tumbar la activación de la suscripción.
      console.error('acreditarCupoPlan falló tras pago de suscripción:', err)
    }
  }

  return {
    yaProcesado: false,
    restauranteId: pago.restauranteId,
    planId: pago.planId,
    periodoHasta,
  }
}

/**
 * Alta/cambio de plan A MANO, sin pasar por MercadoPago (outreach: el fundador cierra
 * al cliente y lo da de alta desde el panel interno). Reusa la lógica de
 * confirmarPagoSuscripcion pero sin comprobante de pago (no hay `pago_suscripcion`):
 *  - upsert de la suscripción → activa, plan del arg, extiende fechaProximoCobro un ciclo
 *  - acredita el cupo utility del plan de inmediato (si es alta o cambió de plan)
 * Devuelve la suscripción resultante o null si el plan no existe / no está activo.
 */
export async function asignarPlanManual(
  db: Db,
  restauranteId: number,
  planId: number,
  ciclo: CicloPago = 'mensual',
): Promise<{ planId: number; periodoHasta: Date } | null> {
  const [planRow] = await db
    .select()
    .from(PlanTable)
    .where(eq(PlanTable.id, planId))
    .limit(1)
  if (!planRow) return null

  const meses = largoCicloMeses(ciclo)
  const ahora = new Date()

  const [subActual] = await db
    .select()
    .from(SuscripcionTable)
    .where(eq(SuscripcionTable.restauranteId, restauranteId))
    .limit(1)

  // Si sigue vigente el MISMO plan con próximo cobro futuro, se acumula (renovación
  // anticipada); si no, arranca desde ahora (alta o cambio de plan).
  const proximoCobroActual = subActual?.fechaProximoCobro ? new Date(subActual.fechaProximoCobro) : null
  const mismoPlan = subActual?.planId === planId
  const base =
    mismoPlan && proximoCobroActual && proximoCobroActual > ahora ? proximoCobroActual : ahora
  const periodoHasta = addMonths(base, meses)
  const precioMensual = String(planRow.precioMensual)

  if (subActual) {
    await db
      .update(SuscripcionTable)
      .set({
        planId,
        estado: SUSCRIPCION_ESTADOS.ACTIVA,
        ciclo,
        fechaProximoCobro: periodoHasta,
        graciaHasta: null,
        fechaCancelacion: null,
        precioMensual,
        updatedAt: ahora,
      })
      .where(eq(SuscripcionTable.restauranteId, restauranteId))
  } else {
    await db.insert(SuscripcionTable).values({
      restauranteId,
      planId,
      estado: SUSCRIPCION_ESTADOS.ACTIVA,
      ciclo,
      fechaInicio: ahora,
      fechaProximoCobro: periodoHasta,
      precioMensual,
    })
  }

  // Acreditar el cupo utility del plan de inmediato (solo alta o cambio de plan).
  if (!subActual || !mismoPlan) {
    try {
      await acreditarCupoPlan(db, restauranteId, {
        mensajesIncluidos: planRow.mensajesIncluidos ?? 0,
        ilimitado: !!planRow.mensajesIlimitados,
      })
    } catch (err) {
      console.error('acreditarCupoPlan falló tras asignación manual de plan:', err)
    }
  }

  return { planId, periodoHasta }
}

/**
 * Estado "vigente" de la suscripción teniendo en cuenta el paso del tiempo, sin cron:
 * si venció el cobro entra en gracia (pago_pendiente) y, agotada la gracia, se suspende.
 * Persiste la transición si cambió (para que quede reflejada en la próxima lectura).
 * Devuelve la fila (posiblemente actualizada) o null si no hay suscripción.
 */
export async function resolverEstadoVigente(db: Db, restauranteId: number) {
  const [sub] = await db
    .select()
    .from(SuscripcionTable)
    .where(eq(SuscripcionTable.restauranteId, restauranteId))
    .limit(1)
  if (!sub) return null

  const ahora = new Date()
  const estado = sub.estado as string
  // Cancelada/suspendida no vuelven solas: sólo un pago las reactiva.
  if (estado === SUSCRIPCION_ESTADOS.CANCELADA || estado === SUSCRIPCION_ESTADOS.SUSPENDIDA) {
    return sub
  }

  const proximoCobro = sub.fechaProximoCobro ? new Date(sub.fechaProximoCobro) : null
  if (!proximoCobro || ahora <= proximoCobro) return sub

  // Venció el cobro. ¿Sigue en gracia o ya se agotó?
  const graciaHasta = sub.graciaHasta ? new Date(sub.graciaHasta) : addMonthsGracia(proximoCobro)
  if (ahora <= graciaHasta) {
    if (estado !== SUSCRIPCION_ESTADOS.PAGO_PENDIENTE) {
      await db
        .update(SuscripcionTable)
        .set({ estado: SUSCRIPCION_ESTADOS.PAGO_PENDIENTE, graciaHasta, updatedAt: ahora })
        .where(eq(SuscripcionTable.restauranteId, restauranteId))
      return { ...sub, estado: SUSCRIPCION_ESTADOS.PAGO_PENDIENTE, graciaHasta }
    }
    return sub
  }

  // Gracia agotada → suspendida (features de pago bloqueadas; pedidos en curso no se cortan).
  await db
    .update(SuscripcionTable)
    .set({ estado: SUSCRIPCION_ESTADOS.SUSPENDIDA, updatedAt: ahora })
    .where(eq(SuscripcionTable.restauranteId, restauranteId))
  return { ...sub, estado: SUSCRIPCION_ESTADOS.SUSPENDIDA }
}

function addMonthsGracia(desde: Date): Date {
  return new Date(desde.getTime() + DIAS_GRACIA * 24 * 60 * 60 * 1000)
}

/** Baja voluntaria. No corta nada en el acto: los pedidos/avisos en curso siguen. */
export async function cancelarSuscripcion(db: Db, restauranteId: number): Promise<boolean> {
  const [sub] = await db
    .select()
    .from(SuscripcionTable)
    .where(eq(SuscripcionTable.restauranteId, restauranteId))
    .limit(1)
  if (!sub) return false

  await db
    .update(SuscripcionTable)
    .set({
      estado: SUSCRIPCION_ESTADOS.CANCELADA,
      fechaCancelacion: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(SuscripcionTable.restauranteId, restauranteId))
  return true
}

/** Historial de pagos de suscripción (auditoría / comprobantes). */
export async function listarPagosSuscripcion(db: Db, restauranteId: number, limit = 24) {
  return db
    .select()
    .from(PagoSuscripcionTable)
    .where(eq(PagoSuscripcionTable.restauranteId, restauranteId))
    .orderBy(PagoSuscripcionTable.id)
    .limit(limit)
}
