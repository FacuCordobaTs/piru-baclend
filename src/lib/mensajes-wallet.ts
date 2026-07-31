// src/lib/mensajes-wallet.ts
// Wallet de mensajes de WhatsApp al cliente: el corazón del modelo de recargas.
// Dos saldos (utility / marketing) porque Meta cobra distinto. Toda la mecánica
// de consumo, recarga, renovación de ciclo y alertas vive acá. Regla dura: NUNCA
// se corta un mensaje por falta de saldo — el saldo puede quedar negativo.
import { type MySql2Database } from 'drizzle-orm/mysql2'
import { and, eq, desc } from 'drizzle-orm'
import {
  saldoMensajes as SaldoMensajesTable,
  transaccionMensajes as TransaccionMensajesTable,
  recargaMensajes as RecargaMensajesTable,
  packRecarga as PackRecargaTable,
} from '../db/schema'
import { resolverSuscripcion, type SuscripcionResuelta } from './planes'

type Db = MySql2Database<Record<string, never>>

export type CategoriaMensaje = 'utility' | 'marketing'

/** Defaults de auto-recarga cuando el local la activa sin fijar valores propios. */
export const AUTO_RECARGA_UMBRAL_DEFAULT = 50
export const RECARGA_PACK_DEFAULT = 500

/** Umbrales de aviso de consumo del cupo utility del plan. */
export const UMBRAL_AVISO_80 = 0.8
export const UMBRAL_AVISO_95 = 0.95

const MS_UN_CICLO = 30 * 24 * 60 * 60 * 1000 // ~1 mes

function proximaRenovacion(desde: Date = new Date()): Date {
  return new Date(desde.getTime() + MS_UN_CICLO)
}

type SaldoRow = typeof SaldoMensajesTable.$inferSelect

/** Devuelve (creándola si hace falta) la fila de saldo del restaurante. */
export async function getOrCreateSaldo(
  db: Db,
  restauranteId: number,
  seed?: { mensajesIncluidos: number },
): Promise<SaldoRow> {
  const [existente] = await db
    .select()
    .from(SaldoMensajesTable)
    .where(eq(SaldoMensajesTable.restauranteId, restauranteId))
    .limit(1)
  if (existente) return existente

  await db.insert(SaldoMensajesTable).values({
    restauranteId,
    cicloInicio: new Date(),
    cicloRenuevaEn: proximaRenovacion(),
    utilityIncluidosRestantes: seed?.mensajesIncluidos ?? 0,
  })

  const [creado] = await db
    .select()
    .from(SaldoMensajesTable)
    .where(eq(SaldoMensajesTable.restauranteId, restauranteId))
    .limit(1)
  return creado
}

/** Saldo utility disponible = cupo del plan restante + saldo de recargas (puede ser negativo). */
export function utilityDisponible(saldo: Pick<SaldoRow, 'utilityIncluidosRestantes' | 'utilityRecargaSaldo'>): number {
  return saldo.utilityIncluidosRestantes + saldo.utilityRecargaSaldo
}

/**
 * Renueva el ciclo: el sobrante del cupo del plan SE PIERDE (se asienta como
 * 'expiracion') y se acredita el cupo nuevo ('renovacion_plan'). Resetea las alertas.
 * Idempotente por ciclo: sólo corre si ya pasó cicloRenuevaEn.
 */
export async function renovarCicloSiCorresponde(
  db: Db,
  restauranteId: number,
  suscripcion: SuscripcionResuelta,
  saldo: SaldoRow,
): Promise<SaldoRow> {
  const ahora = new Date()
  const renuevaEn = saldo.cicloRenuevaEn ? new Date(saldo.cicloRenuevaEn) : null
  if (renuevaEn && ahora < renuevaEn) return saldo

  const incluidos = suscripcion.mensajesIlimitados ? 0 : suscripcion.mensajesIncluidos

  // Sobrante del cupo que se pierde.
  if (saldo.utilityIncluidosRestantes > 0) {
    await registrarTransaccion(db, {
      restauranteId,
      tipo: 'expiracion',
      categoria: 'utility',
      cantidad: -saldo.utilityIncluidosRestantes,
      saldoResultante: saldo.utilityRecargaSaldo, // el cupo queda en 0; sobrevive el recarga
      motivo: 'expiracion_sobrante_ciclo',
    })
  }

  // Acreditación del cupo del nuevo ciclo.
  if (incluidos > 0) {
    await registrarTransaccion(db, {
      restauranteId,
      tipo: 'renovacion_plan',
      categoria: 'utility',
      cantidad: incluidos,
      saldoResultante: incluidos + saldo.utilityRecargaSaldo,
      motivo: 'renovacion_mensual',
    })
  }

  await db
    .update(SaldoMensajesTable)
    .set({
      cicloInicio: ahora,
      cicloRenuevaEn: proximaRenovacion(ahora),
      utilityIncluidosRestantes: incluidos,
      aviso80Enviado: false,
      aviso95Enviado: false,
      updatedAt: ahora,
    })
    .where(eq(SaldoMensajesTable.restauranteId, restauranteId))

  return getOrCreateSaldo(db, restauranteId)
}

export interface ResultadoConsumo {
  /** false sólo si el plan es ilimitado (no se descuenta nada). */
  descontado: boolean
  ilimitado: boolean
  categoria: CategoriaMensaje
  saldoUtilityDisponible: number
  saldoMarketingDisponible: number
  /** Alerta de consumo del cupo utility recién cruzada, para que el caller la dispare. */
  alerta: '80' | '95' | null
  /** true si conviene disparar auto-recarga (config activa y saldo bajo el umbral). */
  autoRecargaSugerida: boolean
}

/**
 * Descuenta un mensaje del wallet. NUNCA bloquea: si no hay saldo, igual descuenta y
 * el saldo queda negativo. Best-effort para el caller (envolver en try/catch: un fallo
 * de contabilidad jamás debe impedir que salga el aviso al comensal).
 *
 * Para utility consume primero el cupo del plan y luego el saldo de recarga.
 */
export async function consumirMensaje(
  db: Db,
  restauranteId: number,
  opts: {
    categoria?: CategoriaMensaje
    cantidad?: number
    tipoMensaje?: string
    motivo?: string
    pedidoUnificadoId?: number | null
  } = {},
): Promise<ResultadoConsumo> {
  const categoria: CategoriaMensaje = opts.categoria ?? 'utility'
  const cantidad = opts.cantidad ?? 1
  const suscripcion = await resolverSuscripcion(db, restauranteId)
  let saldo = await getOrCreateSaldo(db, restauranteId, { mensajesIncluidos: suscripcion.mensajesIncluidos })
  saldo = await renovarCicloSiCorresponde(db, restauranteId, suscripcion, saldo)

  const ilimitadoUtility = categoria === 'utility' && suscripcion.mensajesIlimitados

  // Ilimitado (utility en plan Avanzado / cuenta pre-planes): se registra para stats/auditoría
  // pero no se toca ningún saldo ni se dispara alerta.
  if (ilimitadoUtility) {
    await registrarTransaccion(db, {
      restauranteId,
      tipo: 'consumo',
      categoria,
      cantidad: -cantidad,
      saldoResultante: null,
      motivo: opts.motivo ?? 'consumo_ilimitado',
      tipoMensaje: opts.tipoMensaje ?? null,
      pedidoUnificadoId: opts.pedidoUnificadoId ?? null,
    })
    return {
      descontado: false,
      ilimitado: true,
      categoria,
      saldoUtilityDisponible: utilityDisponible(saldo),
      saldoMarketingDisponible: saldo.marketingRecargaSaldo,
      alerta: null,
      autoRecargaSugerida: false,
    }
  }

  let alerta: '80' | '95' | null = null
  const update: Partial<SaldoRow> = { updatedAt: new Date() }
  let saldoResultante: number

  if (categoria === 'utility') {
    // Consumir cupo del plan primero, luego recarga (que puede quedar negativa).
    const desdeIncluidos = Math.min(cantidad, Math.max(0, saldo.utilityIncluidosRestantes))
    const resto = cantidad - desdeIncluidos
    const nuevoIncluidos = saldo.utilityIncluidosRestantes - desdeIncluidos
    const nuevoRecarga = saldo.utilityRecargaSaldo - resto
    update.utilityIncluidosRestantes = nuevoIncluidos
    update.utilityRecargaSaldo = nuevoRecarga
    saldoResultante = nuevoIncluidos + nuevoRecarga

    // Alertas sobre el consumo del cupo del plan (una vez por ciclo).
    if (suscripcion.mensajesIncluidos > 0) {
      const consumidoCupo = suscripcion.mensajesIncluidos - nuevoIncluidos
      const pct = consumidoCupo / suscripcion.mensajesIncluidos
      if (pct >= UMBRAL_AVISO_95 && !saldo.aviso95Enviado) {
        alerta = '95'
        update.aviso95Enviado = true
      } else if (pct >= UMBRAL_AVISO_80 && !saldo.aviso80Enviado) {
        alerta = '80'
        update.aviso80Enviado = true
      }
    }
  } else {
    const nuevoMarketing = saldo.marketingRecargaSaldo - cantidad
    update.marketingRecargaSaldo = nuevoMarketing
    saldoResultante = nuevoMarketing
  }

  await db
    .update(SaldoMensajesTable)
    .set(update)
    .where(eq(SaldoMensajesTable.restauranteId, restauranteId))

  await registrarTransaccion(db, {
    restauranteId,
    tipo: 'consumo',
    categoria,
    cantidad: -cantidad,
    saldoResultante,
    motivo: opts.motivo ?? `consumo_${categoria}`,
    tipoMensaje: opts.tipoMensaje ?? null,
    pedidoUnificadoId: opts.pedidoUnificadoId ?? null,
  })

  const utilDisp = categoria === 'utility' ? saldoResultante : utilityDisponible(saldo)
  const mktDisp = categoria === 'marketing' ? saldoResultante : saldo.marketingRecargaSaldo

  // Auto-recarga: la evalúa el caller sobre el saldo utility (que es el driver del plan).
  const umbral = saldo.autoRecargaUmbral ?? AUTO_RECARGA_UMBRAL_DEFAULT
  const autoRecargaSugerida = saldo.autoRecargaHabilitada && categoria === 'utility' && utilDisp <= umbral

  return {
    descontado: true,
    ilimitado: false,
    categoria,
    saldoUtilityDisponible: utilDisp,
    saldoMarketingDisponible: mktDisp,
    alerta,
    autoRecargaSugerida,
  }
}

/**
 * Suma crédito al bucket (absorbiendo saldo negativo) y deja el asiento en el ledger.
 * Uso interno: lo llaman acreditarRecarga (crédito directo) y confirmarRecarga (post-pago MP).
 */
async function aplicarCreditoRecarga(
  db: Db,
  restauranteId: number,
  categoria: CategoriaMensaje,
  cantidad: number,
  recargaId: number | null,
): Promise<{ saldoDisponible: number }> {
  const saldo = await getOrCreateSaldo(db, restauranteId)

  let saldoResultante: number
  if (categoria === 'utility') {
    saldoResultante = saldo.utilityRecargaSaldo + cantidad
    await db
      .update(SaldoMensajesTable)
      .set({ utilityRecargaSaldo: saldoResultante, updatedAt: new Date() })
      .where(eq(SaldoMensajesTable.restauranteId, restauranteId))
  } else {
    saldoResultante = saldo.marketingRecargaSaldo + cantidad
    await db
      .update(SaldoMensajesTable)
      .set({ marketingRecargaSaldo: saldoResultante, updatedAt: new Date() })
      .where(eq(SaldoMensajesTable.restauranteId, restauranteId))
  }

  await registrarTransaccion(db, {
    restauranteId,
    tipo: 'recarga',
    categoria,
    cantidad,
    saldoResultante:
      categoria === 'utility'
        ? utilityDisponible({ ...saldo, utilityRecargaSaldo: saldoResultante })
        : saldoResultante,
    motivo: `pack_${cantidad}`,
    recargaMensajesId: recargaId,
  })

  return { saldoDisponible: saldoResultante }
}

/**
 * Acredita una recarga de forma DIRECTA (sin pasar por MercadoPago): ajustes de
 * soporte o auto-recarga con medio propio. Deja el comprobante ya en estado 'paid'.
 */
export async function acreditarRecarga(
  db: Db,
  restauranteId: number,
  opts: {
    categoria?: CategoriaMensaje
    cantidad: number
    monto: number | string
    origen?: 'manual' | 'auto'
    packRecargaId?: number | null
  },
): Promise<{ recargaId: number; saldoDisponible: number }> {
  const categoria: CategoriaMensaje = opts.categoria ?? 'utility'

  const insert = await db.insert(RecargaMensajesTable).values({
    restauranteId,
    categoria,
    packRecargaId: opts.packRecargaId ?? null,
    cantidad: opts.cantidad,
    monto: typeof opts.monto === 'string' ? opts.monto : opts.monto.toFixed(2),
    origen: opts.origen ?? 'manual',
    estado: 'paid',
  })
  const recargaId = Number((insert as any)[0].insertId)

  const { saldoDisponible } = await aplicarCreditoRecarga(db, restauranteId, categoria, opts.cantidad, recargaId)
  return { recargaId, saldoDisponible }
}

/**
 * Inicia un ciclo de wallet al confirmarse el pago de un plan: acredita el cupo
 * utility del nuevo plan de inmediato (no espera a la renovación lazy) y reinicia
 * la ventana del ciclo + las alertas. El sobrante del cupo anterior se pierde
 * (mismo criterio que renovarCicloSiCorresponde). El saldo de recarga NO se toca.
 */
export async function acreditarCupoPlan(
  db: Db,
  restauranteId: number,
  opts: { mensajesIncluidos: number; ilimitado: boolean },
): Promise<void> {
  const ahora = new Date()
  const saldo = await getOrCreateSaldo(db, restauranteId, { mensajesIncluidos: 0 })
  const incluidos = opts.ilimitado ? 0 : opts.mensajesIncluidos

  // El sobrante del cupo anterior se pierde.
  if (saldo.utilityIncluidosRestantes > 0) {
    await registrarTransaccion(db, {
      restauranteId,
      tipo: 'expiracion',
      categoria: 'utility',
      cantidad: -saldo.utilityIncluidosRestantes,
      saldoResultante: saldo.utilityRecargaSaldo,
      motivo: 'expiracion_por_cambio_plan',
    })
  }

  if (incluidos > 0) {
    await registrarTransaccion(db, {
      restauranteId,
      tipo: 'renovacion_plan',
      categoria: 'utility',
      cantidad: incluidos,
      saldoResultante: incluidos + saldo.utilityRecargaSaldo,
      motivo: 'acreditacion_cupo_plan',
    })
  }

  await db
    .update(SaldoMensajesTable)
    .set({
      cicloInicio: ahora,
      cicloRenuevaEn: proximaRenovacion(ahora),
      utilityIncluidosRestantes: incluidos,
      aviso80Enviado: false,
      aviso95Enviado: false,
      updatedAt: ahora,
    })
    .where(eq(SaldoMensajesTable.restauranteId, restauranteId))
}

// ─── Packs de recarga (producto comprable) ───────────────────────────────────

/** Packs activos, ordenados. Para renderizar las opciones de recarga en la UI. */
export async function listarPacks(db: Db, categoria?: CategoriaMensaje) {
  const cond = categoria
    ? and(eq(PackRecargaTable.activo, true), eq(PackRecargaTable.categoria, categoria))
    : eq(PackRecargaTable.activo, true)
  return db.select().from(PackRecargaTable).where(cond).orderBy(PackRecargaTable.orden)
}

/** Un pack activo por id (precio autoritativo del servidor). */
export async function getPack(db: Db, packId: number) {
  const [pack] = await db
    .select()
    .from(PackRecargaTable)
    .where(and(eq(PackRecargaTable.id, packId), eq(PackRecargaTable.activo, true)))
    .limit(1)
  return pack ?? null
}

/**
 * Crea una compra de recarga en estado 'pending' (aún NO acredita saldo). Se usa al
 * iniciar el checkout de MercadoPago; el crédito se aplica recién en confirmarRecarga.
 */
export async function crearRecargaPendiente(
  db: Db,
  restauranteId: number,
  opts: {
    categoria: CategoriaMensaje
    cantidad: number
    monto: number | string
    packRecargaId?: number | null
    origen?: 'manual' | 'auto'
  },
): Promise<number> {
  const insert = await db.insert(RecargaMensajesTable).values({
    restauranteId,
    categoria: opts.categoria,
    packRecargaId: opts.packRecargaId ?? null,
    cantidad: opts.cantidad,
    monto: typeof opts.monto === 'string' ? opts.monto : opts.monto.toFixed(2),
    origen: opts.origen ?? 'manual',
    estado: 'pending',
  })
  return Number((insert as any)[0].insertId)
}

/** Guarda el preference_id de MercadoPago sobre una recarga pendiente. */
export async function setRecargaPreferencia(db: Db, recargaId: number, mpPreferenceId: string) {
  await db
    .update(RecargaMensajesTable)
    .set({ mpPreferenceId })
    .where(eq(RecargaMensajesTable.id, recargaId))
}

/**
 * Confirma una recarga tras el pago aprobado en MercadoPago. Idempotente: si ya
 * estaba 'paid' no vuelve a acreditar. Devuelve null si la recarga no existe.
 */
export async function confirmarRecarga(
  db: Db,
  recargaId: number,
  opts: { mpPaymentId: string },
): Promise<{
  yaProcesada: boolean
  restauranteId: number
  categoria: CategoriaMensaje
  cantidad: number
  saldoDisponible: number | null
} | null> {
  const [recarga] = await db
    .select()
    .from(RecargaMensajesTable)
    .where(eq(RecargaMensajesTable.id, recargaId))
    .limit(1)
  if (!recarga) return null

  if (recarga.estado === 'paid') {
    return {
      yaProcesada: true,
      restauranteId: recarga.restauranteId,
      categoria: recarga.categoria as CategoriaMensaje,
      cantidad: recarga.cantidad,
      saldoDisponible: null,
    }
  }

  await db
    .update(RecargaMensajesTable)
    .set({ estado: 'paid', mpPaymentId: opts.mpPaymentId })
    .where(eq(RecargaMensajesTable.id, recargaId))

  const { saldoDisponible } = await aplicarCreditoRecarga(
    db,
    recarga.restauranteId,
    recarga.categoria as CategoriaMensaje,
    recarga.cantidad,
    recargaId,
  )

  return {
    yaProcesada: false,
    restauranteId: recarga.restauranteId,
    categoria: recarga.categoria as CategoriaMensaje,
    cantidad: recarga.cantidad,
    saldoDisponible,
  }
}

/** Inserta una fila en el ledger. Uso interno del wallet. */
async function registrarTransaccion(
  db: Db,
  mov: {
    restauranteId: number
    tipo: 'consumo' | 'recarga' | 'renovacion_plan' | 'expiracion' | 'ajuste'
    categoria: CategoriaMensaje
    cantidad: number
    saldoResultante: number | null
    motivo?: string | null
    tipoMensaje?: string | null
    pedidoUnificadoId?: number | null
    recargaMensajesId?: number | null
  },
): Promise<void> {
  await db.insert(TransaccionMensajesTable).values({
    restauranteId: mov.restauranteId,
    tipo: mov.tipo,
    categoria: mov.categoria,
    cantidad: mov.cantidad,
    saldoResultante: mov.saldoResultante ?? null,
    motivo: mov.motivo ?? null,
    tipoMensaje: mov.tipoMensaje ?? null,
    pedidoUnificadoId: mov.pedidoUnificadoId ?? null,
    recargaMensajesId: mov.recargaMensajesId ?? null,
  })
}

/** Resumen del wallet para la UI (saldos, % consumido del cupo, alerta y config). */
export async function resumenWallet(db: Db, restauranteId: number) {
  const suscripcion = await resolverSuscripcion(db, restauranteId)
  let saldo = await getOrCreateSaldo(db, restauranteId, { mensajesIncluidos: suscripcion.mensajesIncluidos })
  saldo = await renovarCicloSiCorresponde(db, restauranteId, suscripcion, saldo)

  const utilDisp = utilityDisponible(saldo)
  const cupo = suscripcion.mensajesIncluidos
  const consumidoCupo = cupo > 0 ? cupo - saldo.utilityIncluidosRestantes : 0
  const pctConsumido = cupo > 0 ? Math.min(1, consumidoCupo / cupo) : 0

  let alerta: '80' | '95' | null = null
  if (!suscripcion.mensajesIlimitados && cupo > 0) {
    if (pctConsumido >= UMBRAL_AVISO_95) alerta = '95'
    else if (pctConsumido >= UMBRAL_AVISO_80) alerta = '80'
  }

  return {
    ilimitado: suscripcion.mensajesIlimitados,
    cicloRenuevaEn: saldo.cicloRenuevaEn,
    utility: {
      incluidosRestantes: saldo.utilityIncluidosRestantes,
      recargaSaldo: saldo.utilityRecargaSaldo,
      disponible: utilDisp,
      cupoPlan: cupo,
      consumidoCupo,
      pctConsumido,
      negativo: utilDisp < 0,
    },
    marketing: {
      recargaSaldo: saldo.marketingRecargaSaldo,
      disponible: saldo.marketingRecargaSaldo,
      negativo: saldo.marketingRecargaSaldo < 0,
    },
    alerta,
    autoRecarga: {
      habilitada: saldo.autoRecargaHabilitada,
      umbral: saldo.autoRecargaUmbral ?? AUTO_RECARGA_UMBRAL_DEFAULT,
      cantidad: saldo.autoRecargaCantidad ?? RECARGA_PACK_DEFAULT,
    },
  }
}

/** Historial de movimientos (ledger) para auditoría / resolución de reclamos. */
export async function listarTransacciones(
  db: Db,
  restauranteId: number,
  opts?: { limit?: number; offset?: number },
) {
  let q: any = db
    .select()
    .from(TransaccionMensajesTable)
    .where(eq(TransaccionMensajesTable.restauranteId, restauranteId))
    .orderBy(desc(TransaccionMensajesTable.createdAt))
  if (opts?.limit != null) q = q.limit(opts.limit)
  if (opts?.offset != null) q = q.offset(opts.offset)
  return q
}

/** Actualiza la configuración de auto-recarga. */
export async function setAutoRecarga(
  db: Db,
  restauranteId: number,
  cfg: { habilitada: boolean; umbral?: number | null; cantidad?: number | null },
): Promise<void> {
  await getOrCreateSaldo(db, restauranteId)
  await db
    .update(SaldoMensajesTable)
    .set({
      autoRecargaHabilitada: cfg.habilitada,
      ...(cfg.umbral !== undefined ? { autoRecargaUmbral: cfg.umbral } : {}),
      ...(cfg.cantidad !== undefined ? { autoRecargaCantidad: cfg.cantidad } : {}),
      updatedAt: new Date(),
    })
    .where(eq(SaldoMensajesTable.restauranteId, restauranteId))
}
