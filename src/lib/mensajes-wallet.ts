// src/lib/mensajes-wallet.ts
// Wallet de mensajes de WhatsApp al cliente: el corazón del modelo de recargas.
// Dos saldos (utility / marketing) porque Meta cobra distinto. Toda la mecánica
// de consumo, recarga, renovación de ciclo y alertas vive acá. Regla dura: NUNCA
// se corta un mensaje por falta de saldo — el saldo puede quedar negativo.
import { type MySql2Database } from 'drizzle-orm/mysql2'
import { and, eq, desc, gte, sql } from 'drizzle-orm'
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

/**
 * Techo de deuda del "modo gracia" utility. Cuando el saldo utility disponible llega a 0
 * arranca la gracia: los avisos SIGUEN saliendo en negativo hasta acumular esta deuda.
 * El valor es MENOR que el pack más chico (250) a propósito: una sola recarga mínima
 * siempre devuelve el saldo a positivo (nunca "recargué y sigo en rojo"). Superado el
 * techo, los avisos utility dejan de salir por WhatsApp (degradación, NO apagón: la
 * página de estado del pedido sigue viva) hasta que el local recargue. Costo máximo
 * acotado por local (~100 mensajes utility).
 */
export const DEUDA_MAXIMA_UTILITY = 100

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
  seed?: { mensajesIncluidos: number; mensajesMarketingIncluidos?: number },
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
    marketingIncluidosRestantes: seed?.mensajesMarketingIncluidos ?? 0,
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

/** Saldo marketing disponible = cupo del plan restante + saldo de recargas (puede ser negativo). */
export function marketingDisponible(saldo: Pick<SaldoRow, 'marketingIncluidosRestantes' | 'marketingRecargaSaldo'>): number {
  return saldo.marketingIncluidosRestantes + saldo.marketingRecargaSaldo
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
  const marketingIncluidos = suscripcion.mensajesMarketingIncluidos

  // Sobrante del cupo utility que se pierde.
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

  // Acreditación del cupo utility del nuevo ciclo.
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

  // Sobrante del cupo marketing que se pierde (mismo criterio que utility).
  if (saldo.marketingIncluidosRestantes > 0) {
    await registrarTransaccion(db, {
      restauranteId,
      tipo: 'expiracion',
      categoria: 'marketing',
      cantidad: -saldo.marketingIncluidosRestantes,
      saldoResultante: saldo.marketingRecargaSaldo,
      motivo: 'expiracion_sobrante_ciclo',
    })
  }

  // Acreditación del cupo marketing del nuevo ciclo (Avanzado).
  if (marketingIncluidos > 0) {
    await registrarTransaccion(db, {
      restauranteId,
      tipo: 'renovacion_plan',
      categoria: 'marketing',
      cantidad: marketingIncluidos,
      saldoResultante: marketingIncluidos + saldo.marketingRecargaSaldo,
      motivo: 'renovacion_mensual',
    })
  }

  await db
    .update(SaldoMensajesTable)
    .set({
      cicloInicio: ahora,
      cicloRenuevaEn: proximaRenovacion(ahora),
      utilityIncluidosRestantes: incluidos,
      marketingIncluidosRestantes: marketingIncluidos,
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
      saldoMarketingDisponible: marketingDisponible(saldo),
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
    // Marketing: consumir el cupo del plan primero, luego la recarga (que puede quedar negativa).
    const desdeIncluidos = Math.min(cantidad, Math.max(0, saldo.marketingIncluidosRestantes))
    const resto = cantidad - desdeIncluidos
    const nuevoIncluidos = saldo.marketingIncluidosRestantes - desdeIncluidos
    const nuevoRecarga = saldo.marketingRecargaSaldo - resto
    update.marketingIncluidosRestantes = nuevoIncluidos
    update.marketingRecargaSaldo = nuevoRecarga
    saldoResultante = nuevoIncluidos + nuevoRecarga
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
  const mktDisp = categoria === 'marketing' ? saldoResultante : marketingDisponible(saldo)

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

export interface EstadoEnvioUtility {
  /** ¿Puede salir el aviso utility por WhatsApp? (dentro del techo de deuda o ilimitado). */
  permitido: boolean
  /** Saldo utility disponible ahora (puede ser negativo). */
  disponible: number
  /** Saldo agotado pero todavía dentro del techo de deuda (los avisos siguen saliendo). */
  enGracia: boolean
  /** Superado el techo: el aviso NO sale por WhatsApp (degradación). */
  graciaAgotada: boolean
  deudaMaxima: number
  ilimitado: boolean
}

/**
 * Decide si un aviso utility puede salir por WhatsApp. NO descuenta nada (de eso se
 * encarga consumirMensaje): sólo evalúa el techo de deuda del modo gracia. El caller lo
 * consulta ANTES de enviar; si `permitido` es false, no manda el WhatsApp (el estado del
 * pedido en la web del comensal sigue funcionando igual).
 *
 * Cuentas ilimitadas / pre-planes nunca se cortan ni entran en gracia (fail-open).
 */
export async function estadoEnvioUtility(db: Db, restauranteId: number): Promise<EstadoEnvioUtility> {
  const suscripcion = await resolverSuscripcion(db, restauranteId)
  let saldo = await getOrCreateSaldo(db, restauranteId, { mensajesIncluidos: suscripcion.mensajesIncluidos })
  saldo = await renovarCicloSiCorresponde(db, restauranteId, suscripcion, saldo)

  const disponible = utilityDisponible(saldo)

  if (suscripcion.mensajesIlimitados) {
    return {
      permitido: true,
      disponible,
      enGracia: false,
      graciaAgotada: false,
      deudaMaxima: DEUDA_MAXIMA_UTILITY,
      ilimitado: true,
    }
  }

  // Se permite mientras la deuda no alcance el techo: el aviso Nº100 de deuda es el último
  // (disponible pasa de -99 a -100); en -100 ya no sale.
  const permitido = disponible > -DEUDA_MAXIMA_UTILITY
  return {
    permitido,
    disponible,
    enGracia: disponible <= 0 && permitido,
    graciaAgotada: !permitido,
    deudaMaxima: DEUDA_MAXIMA_UTILITY,
    ilimitado: false,
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
  opts: { mensajesIncluidos: number; mensajesMarketingIncluidos?: number; ilimitado: boolean },
): Promise<void> {
  const ahora = new Date()
  const saldo = await getOrCreateSaldo(db, restauranteId, { mensajesIncluidos: 0 })
  const incluidos = opts.ilimitado ? 0 : opts.mensajesIncluidos
  const marketingIncluidos = opts.mensajesMarketingIncluidos ?? 0

  // El sobrante del cupo utility anterior se pierde.
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

  // El sobrante del cupo marketing anterior se pierde.
  if (saldo.marketingIncluidosRestantes > 0) {
    await registrarTransaccion(db, {
      restauranteId,
      tipo: 'expiracion',
      categoria: 'marketing',
      cantidad: -saldo.marketingIncluidosRestantes,
      saldoResultante: saldo.marketingRecargaSaldo,
      motivo: 'expiracion_por_cambio_plan',
    })
  }

  if (marketingIncluidos > 0) {
    await registrarTransaccion(db, {
      restauranteId,
      tipo: 'renovacion_plan',
      categoria: 'marketing',
      cantidad: marketingIncluidos,
      saldoResultante: marketingIncluidos + saldo.marketingRecargaSaldo,
      motivo: 'acreditacion_cupo_plan',
    })
  }

  await db
    .update(SaldoMensajesTable)
    .set({
      cicloInicio: ahora,
      cicloRenuevaEn: proximaRenovacion(ahora),
      utilityIncluidosRestantes: incluidos,
      marketingIncluidosRestantes: marketingIncluidos,
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
 *
 * `token`/`tokenExpiraEn` son opcionales: los usa el link de pago por QR (`/pago/:token`),
 * donde la recarga se crea al generar el QR y se paga desde otro dispositivo sin login.
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
    token?: string | null
    tokenExpiraEn?: Date | null
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
    // Sólo se referencian las columnas de token cuando el flujo QR las usa: así el
    // checkout normal no toca columnas nuevas si la migración todavía no corrió.
    ...(opts.token ? { token: opts.token, tokenExpiraEn: opts.tokenExpiraEn ?? null } : {}),
  })
  return Number((insert as any)[0].insertId)
}

/** Busca una recarga por su token de pago QR (para la página pública `/pago/:token`). */
export async function getRecargaPorToken(db: Db, token: string) {
  const [recarga] = await db
    .select()
    .from(RecargaMensajesTable)
    .where(eq(RecargaMensajesTable.token, token))
    .limit(1)
  return recarga ?? null
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
  let saldo = await getOrCreateSaldo(db, restauranteId, {
    mensajesIncluidos: suscripcion.mensajesIncluidos,
    mensajesMarketingIncluidos: suscripcion.mensajesMarketingIncluidos,
  })
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

  // Auto-recarga "asistida": sin card-on-file no se cobra en silencio, pero cuando el
  // saldo cruza el umbral configurado señalamos que hay que preparar la recarga para
  // que la UI ofrezca el pago de 1 tap (POST /mensajes/auto-recarga/checkout).
  const umbralAutoRecarga = saldo.autoRecargaUmbral ?? AUTO_RECARGA_UMBRAL_DEFAULT
  const autoRecargaSugerida =
    saldo.autoRecargaHabilitada && !suscripcion.mensajesIlimitados && utilDisp <= umbralAutoRecarga

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
      // Modo gracia: saldo agotado pero los avisos siguen saliendo (deuda acotada).
      enGracia: !suscripcion.mensajesIlimitados && utilDisp <= 0 && utilDisp > -DEUDA_MAXIMA_UTILITY,
      // Gracia agotada: superado el techo, los avisos por WhatsApp se pausan (degradación).
      graciaAgotada: !suscripcion.mensajesIlimitados && utilDisp <= -DEUDA_MAXIMA_UTILITY,
      deudaMaxima: DEUDA_MAXIMA_UTILITY,
    },
    marketing: {
      incluidosRestantes: saldo.marketingIncluidosRestantes,
      recargaSaldo: saldo.marketingRecargaSaldo,
      disponible: marketingDisponible(saldo),
      cupoPlan: suscripcion.mensajesMarketingIncluidos,
      consumidoCupo:
        suscripcion.mensajesMarketingIncluidos > 0
          ? suscripcion.mensajesMarketingIncluidos - saldo.marketingIncluidosRestantes
          : 0,
      negativo: marketingDisponible(saldo) < 0,
    },
    alerta,
    autoRecarga: {
      habilitada: saldo.autoRecargaHabilitada,
      umbral: umbralAutoRecarga,
      cantidad: saldo.autoRecargaCantidad ?? RECARGA_PACK_DEFAULT,
      // true cuando conviene ofrecer ya el pago de la recarga automática.
      sugerida: autoRecargaSugerida,
    },
  }
}

/**
 * Elige el pack a usar para la auto-recarga de un local: el pack utility activo cuya
 * cantidad coincide con la configurada (`autoRecargaCantidad`); si no hay match exacto,
 * el pack más chico que llegue a esa cantidad; y si ninguno llega, el pack más grande.
 * Devuelve null si no hay packs utility activos.
 */
export async function resolverPackAutoRecarga(db: Db, restauranteId: number) {
  const saldo = await getOrCreateSaldo(db, restauranteId)
  const objetivo = saldo.autoRecargaCantidad ?? RECARGA_PACK_DEFAULT
  const packs = await listarPacks(db, 'utility')
  if (packs.length === 0) return null
  const exacto = packs.find((p) => p.cantidad === objetivo)
  if (exacto) return exacto
  const alcanza = packs
    .filter((p) => p.cantidad >= objetivo)
    .sort((a, b) => a.cantidad - b.cantidad)
  if (alcanza[0]) return alcanza[0]
  return [...packs].sort((a, b) => b.cantidad - a.cantidad)[0]
}

/**
 * Inicio del día de hoy en hora Argentina (UTC-3), devuelto como Date UTC. Se usa para
 * el bucket "hoy" de las estadísticas de envíos (mismo criterio de día que el resto del motor).
 */
function inicioDiaAR(d: Date = new Date()): Date {
  const ar = new Date(d.getTime() - 3 * 3600000)
  ar.setUTCHours(0, 0, 0, 0)
  return new Date(ar.getTime() + 3 * 3600000)
}

export type EstadisticasEnvios = {
  utility: { hoy: number; semana: number; mes: number; total: number }
  marketing: { hoy: number; semana: number; mes: number; total: number }
}

/**
 * Cantidad de mensajes efectivamente enviados (movimientos de tipo `consumo`) por período,
 * separados por bucket. Cada consumo = 1 mensaje. Los períodos son: hoy (día calendario AR),
 * últimos 7 días y últimos 30 días (ventanas móviles) y total histórico. Alimenta la pantalla
 * de Mensajes del admin.
 */
export async function estadisticasEnvios(db: Db, restauranteId: number): Promise<EstadisticasEnvios> {
  const ahora = new Date()
  const inicioHoy = inicioDiaAR(ahora)
  const hace7 = new Date(ahora.getTime() - 7 * 86400000)
  const hace30 = new Date(ahora.getTime() - 30 * 86400000)

  const base = { hoy: 0, semana: 0, mes: 0, total: 0 }
  const acc: EstadisticasEnvios = { utility: { ...base }, marketing: { ...base } }

  // Ventana de 30 días: se recorre en JS para bucketizar hoy/semana/mes (volumen bajo por local).
  const recientes = await db
    .select({
      categoria: TransaccionMensajesTable.categoria,
      createdAt: TransaccionMensajesTable.createdAt,
    })
    .from(TransaccionMensajesTable)
    .where(
      and(
        eq(TransaccionMensajesTable.restauranteId, restauranteId),
        eq(TransaccionMensajesTable.tipo, 'consumo'),
        gte(TransaccionMensajesTable.createdAt, hace30),
      ),
    )

  for (const r of recientes) {
    const bucket = r.categoria === 'marketing' ? acc.marketing : acc.utility
    const ts = new Date(r.createdAt as any).getTime()
    bucket.mes += 1
    if (ts >= hace7.getTime()) bucket.semana += 1
    if (ts >= inicioHoy.getTime()) bucket.hoy += 1
  }

  // Total histórico: count agrupado (no requiere traer todas las filas).
  const totales = await db
    .select({
      categoria: TransaccionMensajesTable.categoria,
      total: sql<number>`count(*)`,
    })
    .from(TransaccionMensajesTable)
    .where(
      and(
        eq(TransaccionMensajesTable.restauranteId, restauranteId),
        eq(TransaccionMensajesTable.tipo, 'consumo'),
      ),
    )
    .groupBy(TransaccionMensajesTable.categoria)

  for (const t of totales) {
    const bucket = t.categoria === 'marketing' ? acc.marketing : acc.utility
    bucket.total = Number(t.total) || 0
  }

  return acc
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
