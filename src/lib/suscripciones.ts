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
import { and, eq } from 'drizzle-orm'
import {
  configuracionSuscripcion as ConfiguracionSuscripcionTable,
  pagoSuscripcionItem as PagoSuscripcionItemTable,
  plan as PlanTable,
  restauranteModulo as RestauranteModuloTable,
  suscripcion as SuscripcionTable,
  pagoSuscripcion as PagoSuscripcionTable,
} from '../db/schema'
import { SUSCRIPCION_ESTADOS } from './planes'
import { acreditarCupoPlan, acreditarCuposPorModulos, confirmarRecarga, type CategoriaMensaje } from './mensajes-wallet'
import { SUSCRIPCION_UNICA_CODIGO } from './suscripcion'
export { resolverEstadoPorTiempo, type EstadoSuscripcionTemporal } from './suscripcion-estado'
import { resolverEstadoPorTiempo, type EstadoSuscripcionTemporal } from './suscripcion-estado'

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

/** Tope de descuento anual permitido por el negocio (20%). */
export const MAX_DESCUENTO_ANUAL = 20

/** Descuento anual efectivo de un plan, clampeado a [0, MAX_DESCUENTO_ANUAL]. */
export function descuentoAnualEfectivo(descuentoAnual: number | null | undefined): number {
  const pct = Number(descuentoAnual ?? 0)
  if (!Number.isFinite(pct)) return 0
  return Math.max(0, Math.min(MAX_DESCUENTO_ANUAL, Math.round(pct)))
}

/**
 * Precio a cobrar por un plan/ciclo (autoritativo del servidor). Anual = 12 × mensual
 * con el descuento anual del plan aplicado (topeado a MAX_DESCUENTO_ANUAL). Redondea al
 * peso. El descuento SIEMPRE sale del plan en la DB, nunca del cliente.
 */
export function montoPorCiclo(
  precioMensual: number,
  ciclo: CicloPago,
  descuentoAnual: number | null | undefined = 0,
): number {
  if (ciclo !== 'anual') return precioMensual
  const pct = descuentoAnualEfectivo(descuentoAnual)
  return Math.round(precioMensual * 12 * (1 - pct / 100))
}

/**
 * Crea un pago de suscripción en estado 'pending' (aún NO da acceso; se activa en el
 * webhook al aprobarse). El monto SIEMPRE sale del precio del plan en la DB.
 */
export async function crearPagoSuscripcionPendiente(
  db: Db,
  restauranteId: number,
  opts: { planId: number; ciclo: CicloPago; monto: number; token?: string; tokenExpiraEn?: Date },
): Promise<number> {
  const insert = await db.insert(PagoSuscripcionTable).values({
    restauranteId,
    planId: opts.planId,
    ciclo: opts.ciclo,
    monto: opts.monto.toFixed(2),
    estado: 'pending',
    token: opts.token ?? null,
    tokenExpiraEn: opts.tokenExpiraEn ?? null,
  })
  return Number((insert as any)[0].insertId)
}

/** Busca un pago de suscripción por su token de pago (para la página pública `/pago/:token`). */
export async function getPagoSuscripcionPorToken(db: Db, token: string) {
  const [pago] = await db
    .select()
    .from(PagoSuscripcionTable)
    .where(eq(PagoSuscripcionTable.token, token))
    .limit(1)
  return pago ?? null
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
  opts: { mpPaymentId: string; montoPagado?: number },
): Promise<{
  yaProcesado: boolean
  restauranteId: number
  planId: number
  periodoHasta: Date | null
  acreditoBase: boolean
  modulosActivados: number[]
  recargaAcreditada: boolean
} | null> {
  const [pago] = await db
    .select()
    .from(PagoSuscripcionTable)
    .where(eq(PagoSuscripcionTable.id, pagoId))
    .limit(1)
  if (!pago) return null

  const montoEsperado = Number(pago.montoTotal ?? pago.monto)
  if (opts.montoPagado != null && (!Number.isFinite(opts.montoPagado) || Math.abs(montoEsperado - opts.montoPagado) > 0.01)) {
    throw new Error(`Monto de suscripción inválido: esperado=${montoEsperado} recibido=${opts.montoPagado}`)
  }

  if (pago.estado === 'paid') {
    const recarga = pago.recargaMensajesId
      ? await confirmarRecarga(db, pago.recargaMensajesId, { mpPaymentId: pago.mpPaymentId ?? opts.mpPaymentId })
      : null
    return {
      yaProcesado: true,
      restauranteId: pago.restauranteId,
      planId: pago.planId,
      periodoHasta: pago.periodoHasta ? new Date(pago.periodoHasta) : null,
      acreditoBase: false,
      modulosActivados: [],
      recargaAcreditada: Boolean(recarga && !recarga.yaProcesada),
    }
  }

  // Las facturas creadas desde T07 se resuelven exclusivamente desde los ítems
  // congelados. La ausencia de ítems identifica un comprobante legacy que debe
  // conservar su acreditación histórica mientras existan admins instalados.
  const items = await db
    .select()
    .from(PagoSuscripcionItemTable)
    .where(eq(PagoSuscripcionItemTable.pagoSuscripcionId, pagoId))
  if (items.length) {
    return confirmarFacturaCompuesta(db, pago, items, opts)
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
        mensajesMarketingIncluidos: planRow.mensajesMarketingIncluidos ?? 0,
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
    acreditoBase: true,
    modulosActivados: [],
    recargaAcreditada: false,
  }
}

/**
 * Acredita una factura compuesta ya aprobada. La fuente de verdad son los
 * snapshots de `pago_suscripcion_item`, nunca el catálogo actual ni el body
 * del cliente. Un módulo pendiente sólo se vuelve activo en este punto.
 */
async function confirmarFacturaCompuesta(
  db: Db,
  pago: typeof PagoSuscripcionTable.$inferSelect,
  items: Array<typeof PagoSuscripcionItemTable.$inferSelect>,
  opts: { mpPaymentId: string; montoPagado?: number },
): Promise<{
  yaProcesado: boolean
  restauranteId: number
  planId: number
  periodoHasta: Date | null
  acreditoBase: boolean
  modulosActivados: number[]
  recargaAcreditada: boolean
}> {
  const ahora = new Date()
  const itemBase = items.find((item) => item.tipo === 'base') ?? null
  const itemsModulo = items.filter((item) => item.tipo === 'modulo' && item.moduloId != null)
  const periodoHasta = itemBase?.hasta ?? itemsModulo.reduce<Date | null>((maximo, item) => {
    const hasta = item.hasta ? new Date(item.hasta) : null
    return hasta && (!maximo || hasta > maximo) ? hasta : maximo
  }, null)

  // Claim condicional: dos webhooks simultáneos no pueden acreditar el mismo
  // comprobante. Si otro ya lo hizo, releemos y devolvemos idempotencia.
  const claim = await db
    .update(PagoSuscripcionTable)
    .set({
      estado: 'paid',
      mpPaymentId: opts.mpPaymentId,
      periodoDesde: itemBase?.desde ?? null,
      periodoHasta,
    })
    .where(and(eq(PagoSuscripcionTable.id, pago.id), eq(PagoSuscripcionTable.estado, 'pending')))
  if (Number((claim as any)[0]?.affectedRows ?? 0) === 0) {
    return {
      yaProcesado: true,
      restauranteId: pago.restauranteId,
      planId: pago.planId,
      periodoHasta: pago.periodoHasta ? new Date(pago.periodoHasta) : periodoHasta,
      acreditoBase: false,
      modulosActivados: [],
      recargaAcreditada: false,
    }
  }

  if (itemBase) {
    const [subActual] = await db
      .select()
      .from(SuscripcionTable)
      .where(eq(SuscripcionTable.restauranteId, pago.restauranteId))
      .limit(1)
    const precioBaseMensual = String(itemBase.precioUnitario)
    const montoModulosMensual = itemsModulo.reduce((total, item) => total + Number(item.precioUnitario), 0)
    const montoTotalMensual = Number(precioBaseMensual) + montoModulosMensual
    const valores = {
      planId: pago.planId,
      configuracionSuscripcionId: pago.configuracionSuscripcionId,
      estado: SUSCRIPCION_ESTADOS.ACTIVA,
      ciclo: pago.ciclo,
      fechaProximoCobro: itemBase.hasta,
      graciaHasta: null,
      fechaCancelacion: null,
      precioMensual: precioBaseMensual,
      precioBaseMensual,
      montoModulosMensual: montoModulosMensual.toFixed(2),
      montoTotalMensual: montoTotalMensual.toFixed(2),
      updatedAt: ahora,
    }
    if (subActual) {
      await db.update(SuscripcionTable).set(valores).where(eq(SuscripcionTable.restauranteId, pago.restauranteId))
    } else {
      await db.insert(SuscripcionTable).values({
        restauranteId: pago.restauranteId,
        ...valores,
        fechaInicio: itemBase.desde ?? ahora,
      })
    }
  }

  const modulosActivados = itemsModulo.map((item) => item.moduloId!).filter((id): id is number => id != null)
  if (modulosActivados.length) {
    // Sólo tocamos entitlements que pertenecen a los ítems pagados. Esto impide
    // que una factura de un módulo habilite cualquier otro por fallback.
    for (const item of itemsModulo) {
      const precio = String(item.precioUnitario)
      await db.insert(RestauranteModuloTable).values({
        restauranteId: pago.restauranteId,
        moduloId: item.moduloId!,
        estado: 'activo',
        activadoAt: ahora,
        desactivadoAt: null,
        vigenteHasta: item.hasta,
        precioMensualCongelado: precio,
        origen: 'usuario',
        cancelarAlFinPeriodo: false,
        updatedAt: ahora,
      }).onDuplicateKeyUpdate({
        set: {
          estado: 'activo',
          activadoAt: ahora,
          desactivadoAt: null,
          vigenteHasta: item.hasta,
          precioMensualCongelado: precio,
          origen: 'usuario',
          cancelarAlFinPeriodo: false,
          updatedAt: ahora,
        },
      })
    }
  }

  // El cupo incluido es propiedad de los módulos activos, no del plan ni de
  // los snapshots de la factura. Se acredita sólo después del claim de pago.
  // Una factura de base reinicia ambos buckets; un alta prorrateada toca sólo
  // la categoría que aporta el módulo recién activado.
  try {
    const categorias = Array.from(new Set(itemsModulo.flatMap((item): CategoriaMensaje[] => {
      if (item.codigo === 'avisos_automaticos_whatsapp') return ['utility']
      if (item.codigo === 'motor_recompra') return ['marketing']
      return []
    })))
    if (itemBase || categorias.length) {
      await acreditarCuposPorModulos(db, pago.restauranteId, {
        reiniciarCiclo: Boolean(itemBase),
        categorias: itemBase ? undefined : categorias,
      })
    }
  } catch (err) {
    // Igual que las recargas, el asiento de wallet es best-effort y nunca
    // revierte una factura MP ya aprobada.
    console.error('acreditarCuposPorModulos falló tras factura aprobada:', err)
  }

  // La recarga vinculada usa el mismo payment_id y es idempotente. Si su
  // asiento fallara, un reintento del webhook entra por la rama `paid` y vuelve
  // a intentar únicamente la recarga, sin extender otra vez la suscripción.
  let recargaAcreditada = false
  if (pago.recargaMensajesId) {
    const recarga = await confirmarRecarga(db, pago.recargaMensajesId, { mpPaymentId: opts.mpPaymentId })
    if (!recarga) throw new Error(`Recarga vinculada ${pago.recargaMensajesId} no encontrada`)
    recargaAcreditada = !recarga.yaProcesada
  }

  return {
    yaProcesado: false,
    restauranteId: pago.restauranteId,
    planId: pago.planId,
    periodoHasta,
    acreditoBase: Boolean(itemBase),
    modulosActivados,
    recargaAcreditada,
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
        mensajesMarketingIncluidos: planRow.mensajesMarketingIncluidos ?? 0,
        ilimitado: !!planRow.mensajesIlimitados,
      })
    } catch (err) {
      console.error('acreditarCupoPlan falló tras asignación manual de plan:', err)
    }
  }

  return { planId, periodoHasta }
}

/** Duración comercial por defecto del trial outbound. */
export const DIAS_TRIAL_DEFAULT = 5

/**
 * Arranca el TRIAL de un local (onboarding outbound). A diferencia de una alta paga, acá el local
 * entra en `estado='trial'` con la suscripción base SIN pagar, por `dias` días. ⚠️ Se llama cuando
 * el fundador lo decide desde el panel interno,
 * no en el claim ni en el registro (el reloj de los 5 días arranca acá).
 *
 * Efecto:
 *  - upsert de la suscripción → estado 'trial', trialFin = fechaProximoCobro = ahora + dias.
 *    Poner fechaProximoCobro = trialFin hace que, al vencer, `resolverEstadoVigente` transicione
 *    solo a pago_pendiente (gracia) y luego suspendida ("pausada") — sin cron.
 *  - no activa módulos ni acredita cupos: el trial incluye únicamente la base.
 *
 * `planId` persiste sólo como alias técnico obligatorio hasta T43. La decisión
 * comercial y el precio se toman de `configuracion_suscripcion.codigo='piru'`.
 */
export async function iniciarTrial(
  db: Db,
  restauranteId: number,
  dias: number = DIAS_TRIAL_DEFAULT,
): Promise<{ planId: number; configuracionSuscripcionId: number; trialFin: Date } | null> {
  const [configuracion, planCompatible] = await Promise.all([
    db
      .select()
      .from(ConfiguracionSuscripcionTable)
      .where(eq(ConfiguracionSuscripcionTable.codigo, SUSCRIPCION_UNICA_CODIGO))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    // `plan_id` sigue siendo NOT NULL durante la compatibilidad con admins
    // instalados. Nunca se expone como selector ni define el trial.
    db
      .select({ id: PlanTable.id })
      .from(PlanTable)
      .where(and(eq(PlanTable.codigo, 'basico'), eq(PlanTable.activo, true)))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ])
  if (!configuracion || !configuracion.activo || !planCompatible) return null

  const ahora = new Date()
  const trialFin = new Date(ahora.getTime() + dias * 24 * 60 * 60 * 1000)
  const precioMensual = String(configuracion.precioMensual)

  const [subActual] = await db
    .select()
    .from(SuscripcionTable)
    .where(eq(SuscripcionTable.restauranteId, restauranteId))
    .limit(1)

  if (subActual) {
    await db
      .update(SuscripcionTable)
      .set({
        planId: planCompatible.id,
        configuracionSuscripcionId: configuracion.id,
        estado: SUSCRIPCION_ESTADOS.TRIAL,
        ciclo: 'mensual',
        fechaInicio: ahora,
        trialFin,
        fechaProximoCobro: trialFin,
        graciaHasta: null,
        fechaCancelacion: null,
        // Reset del flag anti-reenvío: un trial nuevo debe poder avisar su vencimiento de nuevo.
        avisoTrialVencimientoAt: null,
        precioMensual,
        precioBaseMensual: precioMensual,
        montoModulosMensual: '0.00',
        montoTotalMensual: precioMensual,
        updatedAt: ahora,
      })
      .where(eq(SuscripcionTable.restauranteId, restauranteId))
  } else {
    await db.insert(SuscripcionTable).values({
      restauranteId,
      planId: planCompatible.id,
      configuracionSuscripcionId: configuracion.id,
      estado: SUSCRIPCION_ESTADOS.TRIAL,
      ciclo: 'mensual',
      fechaInicio: ahora,
      trialFin,
      fechaProximoCobro: trialFin,
      precioMensual,
      precioBaseMensual: precioMensual,
      montoModulosMensual: '0.00',
      montoTotalMensual: precioMensual,
    })
  }

  return { planId: planCompatible.id, configuracionSuscripcionId: configuracion.id, trialFin }
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
  const resuelto = resolverEstadoPorTiempo({
    estado: sub.estado as EstadoSuscripcionTemporal,
    fechaProximoCobro: sub.fechaProximoCobro,
    graciaHasta: sub.graciaHasta,
    fechaCancelacion: sub.fechaCancelacion,
  }, ahora, DIAS_GRACIA)
  if (resuelto.estado === sub.estado && resuelto.graciaHasta?.getTime() === sub.graciaHasta?.getTime()) return sub

  await db.update(SuscripcionTable).set({
    estado: resuelto.estado,
    graciaHasta: resuelto.graciaHasta,
    updatedAt: ahora,
  }).where(eq(SuscripcionTable.restauranteId, restauranteId))
  return { ...sub, estado: resuelto.estado, graciaHasta: resuelto.graciaHasta }
}

/**
 * ¿El local está "pausado" por su suscripción? (Claim Flow · Tarea 8 — degradación, no apagón.)
 * True cuando TENÍA un plan y lo perdió: `suspendida` (trial/pago vencido tras agotarse la gracia)
 * o `cancelada` (baja voluntaria). En ese estado la tienda pública se muestra "cerrada
 * temporalmente" y no toma pedidos nuevos, y el panel queda de sólo lectura / reactivación por pago.
 * NO aplica a cuentas sin suscripción (pre-planes: null) ni a trial/activa/pago_pendiente (gracia):
 * esas siguen operando con normalidad. Resuelve el estado lazy antes de decidir (sin cron).
 */
export async function estaPausadoPorSuscripcion(db: Db, restauranteId: number): Promise<boolean> {
  const vigente = await resolverEstadoVigente(db, restauranteId)
  if (!vigente) return false
  return (
    vigente.estado === SUSCRIPCION_ESTADOS.SUSPENDIDA ||
    vigente.estado === SUSCRIPCION_ESTADOS.CANCELADA
  )
}

/** Baja voluntaria. No corta nada en el acto: los pedidos/avisos en curso siguen. */
export async function cancelarSuscripcion(db: Db, restauranteId: number): Promise<boolean> {
  const [sub] = await db
    .select()
    .from(SuscripcionTable)
    .where(eq(SuscripcionTable.restauranteId, restauranteId))
    .limit(1)
  if (!sub) return false

  const ahora = new Date()
  const hasta = sub.fechaProximoCobro && new Date(sub.fechaProximoCobro) > ahora
    ? new Date(sub.fechaProximoCobro)
    : ahora
  await db.update(SuscripcionTable).set({
    // Si queda período pago, la baja se programa sin cortar el servicio.
    estado: hasta > ahora ? sub.estado : SUSCRIPCION_ESTADOS.CANCELADA,
    fechaCancelacion: hasta,
    updatedAt: ahora,
  }).where(eq(SuscripcionTable.restauranteId, restauranteId))
  return true
}

/** Revierte una baja programada mientras el período vigente todavía no terminó. */
export async function reactivarSuscripcionProgramada(db: Db, restauranteId: number): Promise<boolean> {
  const [sub] = await db
    .select()
    .from(SuscripcionTable)
    .where(eq(SuscripcionTable.restauranteId, restauranteId))
    .limit(1)
  if (!sub?.fechaCancelacion || new Date(sub.fechaCancelacion) <= new Date()) return false

  await db.update(SuscripcionTable).set({
    fechaCancelacion: null,
    updatedAt: new Date(),
  }).where(eq(SuscripcionTable.restauranteId, restauranteId))
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
