/**
 * Canonical payment method values stored in pedido_unificado.metodo_pago (varchar).
 * Legacy values (mercadopago, transferencia, efectivo) remain readable everywhere.
 */
export const METODO_PAGO = {
  MERCADOPAGO_CHECKOUT: 'mercadopago_checkout',
  MERCADOPAGO_BRICKS: 'mercadopago_bricks',
  TRANSFERENCIA_AUTO_CUCURU: 'transferencia_automatica_cucuru',
  TRANSFERENCIA_AUTO_TALO: 'transferencia_automatica_talo',
  MANUAL_TRANSFER: 'manual_transfer',
  CASH: 'cash',
  /** @deprecated use MERCADOPAGO_* */
  MERCADOPAGO_LEGACY: 'mercadopago',
  /** @deprecated disambiguate with AUTO vs manual */
  TRANSFERENCIA_LEGACY: 'transferencia',
  /** @deprecated use CASH */
  EFECTIVO_LEGACY: 'efectivo',
} as const

export type MetodoPagoCanonical = (typeof METODO_PAGO)[keyof typeof METODO_PAGO]

export interface MetodosPagoConfig {
  mercadopagoCheckout: boolean
  mercadopagoBricks: boolean
  transferenciaAutomatica: boolean
  transferenciaManual: boolean
  efectivo: boolean
}

const DEFAULT_CONFIG: MetodosPagoConfig = {
  mercadopagoCheckout: true,
  mercadopagoBricks: false,
  transferenciaAutomatica: true,
  transferenciaManual: false,
  efectivo: true,
}

export type RestaurantePagoRow = {
  metodosPagoConfig: unknown
  cardsPaymentsEnabled: boolean | null
  mpConnected: boolean | null
  mpPublicKey: string | null
  cucuruConfigurado: boolean | null
  cucuruEnabled: boolean | null
  proveedorPago: 'cucuru' | 'talo' | 'mercadopago' | 'manual' | null
  taloApiKey: string | null
  taloUserId: string | null
  transferenciaAlias: string | null
}

export function rowToPagoRow(r: {
  metodosPagoConfig?: unknown
  cardsPaymentsEnabled: boolean | null
  mpConnected: boolean | null
  mpPublicKey: string | null
  cucuruConfigurado: boolean | null
  cucuruEnabled: boolean | null
  proveedorPago: 'cucuru' | 'talo' | 'mercadopago' | 'manual' | null
  taloApiKey: string | null
  taloUserId: string | null
  transferenciaAlias: string | null
}): RestaurantePagoRow {
  return {
    metodosPagoConfig: r.metodosPagoConfig,
    cardsPaymentsEnabled: r.cardsPaymentsEnabled,
    mpConnected: r.mpConnected,
    mpPublicKey: r.mpPublicKey,
    cucuruConfigurado: r.cucuruConfigurado,
    cucuruEnabled: r.cucuruEnabled,
    proveedorPago: r.proveedorPago,
    taloApiKey: r.taloApiKey,
    taloUserId: r.taloUserId,
    transferenciaAlias: r.transferenciaAlias,
  }
}

function parseConfigJson(raw: unknown): Partial<MetodosPagoConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const o = raw as Record<string, unknown>
  const b = (k: string) => (typeof o[k] === 'boolean' ? o[k] : undefined)
  return {
    mercadopagoCheckout: b('mercadopagoCheckout'),
    mercadopagoBricks: b('mercadopagoBricks'),
    transferenciaAutomatica: b('transferenciaAutomatica'),
    transferenciaManual: b('transferenciaManual'),
    efectivo: b('efectivo'),
  }
}

/** Effective flags: JSON overrides with safe fallbacks from legacy columns. */
export function resolveMetodosPagoConfig(r: RestaurantePagoRow): MetodosPagoConfig {
  const fromJson = parseConfigJson(r.metodosPagoConfig)
  const mpOk = !!(r.mpConnected && r.mpPublicKey)
  const cardsOn = r.cardsPaymentsEnabled !== false
  const cucuruAuto = !!r.cucuruConfigurado && r.cucuruEnabled !== false
  const taloAuto = r.proveedorPago === 'talo' && !!(r.taloApiKey && r.taloUserId)
  const autoTransferAvailable = cucuruAuto || taloAuto
  const aliasOk = !!(r.transferenciaAlias && String(r.transferenciaAlias).trim())

  const fallback: MetodosPagoConfig = {
    mercadopagoCheckout: mpOk && cardsOn,
    mercadopagoBricks: false,
    transferenciaAutomatica: autoTransferAvailable,
    transferenciaManual: !autoTransferAvailable && aliasOk,
    efectivo: true,
  }

  return {
    mercadopagoCheckout: fromJson.mercadopagoCheckout ?? fallback.mercadopagoCheckout,
    mercadopagoBricks: fromJson.mercadopagoBricks ?? fallback.mercadopagoBricks,
    transferenciaAutomatica: fromJson.transferenciaAutomatica ?? fallback.transferenciaAutomatica,
    transferenciaManual: fromJson.transferenciaManual ?? fallback.transferenciaManual,
    efectivo: fromJson.efectivo ?? fallback.efectivo,
  }
}

export function hasAnyMetodoAutomatico(cfg: MetodosPagoConfig): boolean {
  return (
    cfg.mercadopagoCheckout ||
    cfg.mercadopagoBricks ||
    cfg.transferenciaAutomatica
  )
}

/** Public checkout must not mix automatic and manual; automatic wins if any auto is on. */
export function enforceMetodosPublicos(cfg: MetodosPagoConfig): MetodosPagoConfig {
  if (!hasAnyMetodoAutomatico(cfg)) return cfg
  return {
    ...cfg,
    transferenciaManual: false,
    efectivo: false,
  }
}

export interface MetodoPublicoOption {
  id: MetodoPagoCanonical
  label: string
  automatico: boolean
}

export function buildMetodosPublicosList(r: RestaurantePagoRow): MetodoPublicoOption[] {
  const cfg = enforceMetodosPublicos(resolveMetodosPagoConfig(r))
  const out: MetodoPublicoOption[] = []

  if (cfg.mercadopagoCheckout) {
    out.push({
      id: METODO_PAGO.MERCADOPAGO_CHECKOUT,
      label: 'Mercado Pago Checkout (redirección)',
      automatico: true,
    })
  }
  if (cfg.mercadopagoBricks) {
    out.push({ id: METODO_PAGO.MERCADOPAGO_BRICKS, label: 'Tarjeta (Bricks)', automatico: true })
  }
  if (cfg.transferenciaAutomatica) {
    if (r.proveedorPago === 'talo' && r.taloApiKey && r.taloUserId) {
      out.push({ id: METODO_PAGO.TRANSFERENCIA_AUTO_TALO, label: 'Transferencia (automática Talo)', automatico: true })
    } else if (r.cucuruConfigurado) {
      out.push({ id: METODO_PAGO.TRANSFERENCIA_AUTO_CUCURU, label: 'Transferencia (automática)', automatico: true })
    }
  }
  if (cfg.transferenciaManual && r.transferenciaAlias && String(r.transferenciaAlias).trim()) {
    out.push({ id: METODO_PAGO.MANUAL_TRANSFER, label: 'Transferencia (manual)', automatico: false })
  }
  if (cfg.efectivo) {
    out.push({ id: METODO_PAGO.CASH, label: 'Efectivo', automatico: false })
  }

  return out
}

export function isMetodoAutomatico(metodo: string | null | undefined): boolean {
  if (!metodo) return false
  switch (metodo) {
    case METODO_PAGO.MERCADOPAGO_CHECKOUT:
    case METODO_PAGO.MERCADOPAGO_BRICKS:
    case METODO_PAGO.MERCADOPAGO_LEGACY:
    case METODO_PAGO.TRANSFERENCIA_AUTO_CUCURU:
    case METODO_PAGO.TRANSFERENCIA_AUTO_TALO:
    case METODO_PAGO.TRANSFERENCIA_LEGACY:
      return true
    default:
      return false
  }
}

/** Manual transfer or cash — show in dashboard before payment verified. */
export function isMetodoManualVerificable(metodo: string | null | undefined): boolean {
  if (!metodo) return false
  return (
    metodo === METODO_PAGO.MANUAL_TRANSFER ||
    metodo === METODO_PAGO.CASH ||
    metodo === METODO_PAGO.EFECTIVO_LEGACY
  )
}

/** True = no WS al admin hasta acreditación (MP o transfer automática). */
export function debeEsperarWebhookParaNotificar(metodo: string | null | undefined): boolean {
  return isMetodoAutomatico(metodo)
}

/**
 * Normalize client input + defaults when optional.
 * Returns resolved canonical method or null if invalid / not allowed.
 */
export function resolverMetodoPagoPedido(
  solicitado: string | null | undefined,
  r: RestaurantePagoRow
): { metodo: MetodoPagoCanonical | null; error?: string } {
  const opciones = buildMetodosPublicosList(r)
  const allowed = new Set(opciones.map((o) => o.id))

  const raw = (solicitado || '').trim()
  if (!raw) {
    const firstAuto = opciones.find((o) => o.automatico)
    if (firstAuto) return { metodo: firstAuto.id }
    const first = opciones[0]
    if (first) return { metodo: first.id }
    return { metodo: null, error: 'No hay métodos de pago habilitados' }
  }

  let normalized = raw
  if (raw === METODO_PAGO.MERCADOPAGO_LEGACY) {
    normalized = resolveMetodosPagoConfig(r).mercadopagoBricks
      ? METODO_PAGO.MERCADOPAGO_BRICKS
      : METODO_PAGO.MERCADOPAGO_CHECKOUT
  }
  if (raw === METODO_PAGO.TRANSFERENCIA_LEGACY || raw === 'transferencia') {
    const cfg = resolveMetodosPagoConfig(r)
    if (cfg.transferenciaAutomatica) {
      if (r.proveedorPago === 'talo' && r.taloApiKey && r.taloUserId) {
        normalized = METODO_PAGO.TRANSFERENCIA_AUTO_TALO
      } else {
        normalized = METODO_PAGO.TRANSFERENCIA_AUTO_CUCURU
      }
    } else {
      normalized = METODO_PAGO.MANUAL_TRANSFER
    }
  }
  if (raw === METODO_PAGO.EFECTIVO_LEGACY || raw === 'efectivo') {
    normalized = METODO_PAGO.CASH
  }

  if (!allowed.has(normalized as MetodoPagoCanonical)) {
    return { metodo: null, error: 'Método de pago no disponible' }
  }

  return { metodo: normalized as MetodoPagoCanonical }
}

/** Dynamic CVU/alias: Cucuru pool or Talo create payment. */
export function proveedorTransferenciaDinamica(
  metodo: string,
  r: RestaurantePagoRow
): 'cucuru' | 'talo' | null {
  if (metodo === METODO_PAGO.TRANSFERENCIA_AUTO_TALO) return 'talo'
  if (metodo === METODO_PAGO.TRANSFERENCIA_AUTO_CUCURU) return 'cucuru'
  if (metodo === METODO_PAGO.TRANSFERENCIA_LEGACY) {
    if (r.proveedorPago === 'talo' && r.taloApiKey && r.taloUserId) return 'talo'
    if (r.cucuruConfigurado) return 'cucuru'
  }
  return null
}

/** List filter: hide unpaid orders when restaurant only uses automatic settlement. */
export function restauranteOcultaPedidosNoPagados(cfg: MetodosPagoConfig): boolean {
  return hasAnyMetodoAutomatico(enforceMetodosPublicos(cfg))
}

