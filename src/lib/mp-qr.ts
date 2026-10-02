/**
 * Cobros con QR estático de Mercado Pago (Orders API, `type: "qr"`, `mode: "static"`).
 *
 * Contrato (documentación oficial de Mercado Pago, "Código QR" en mercadopago.com.ar/developers):
 * - `POST /v1/orders` con `type: "qr"`, `total_amount` y `transactions.payments[0].amount` como
 *   strings iguales con dos decimales, `external_reference` único y `X-Idempotency-Key`.
 * - La caja (POS) y su tienda ya existen: la orden usa el `external_id` del POS en
 *   `config.qr.external_pos_id`. En modo `static` el comprador escanea el QR fijo que devolvió
 *   la caja (`qr_response.image`); la orden no trae `type_response.qr_data`.
 * - Cajas: `POST /v2/pos` (exige `X-Idempotency-Key`), `GET /v2/pos` (límite 1–30) y
 *   `GET /v2/pos/{id}`. Tiendas: `GET /users/{user_id}/stores/search`. Este módulo nunca crea tiendas.
 * - Estados de la orden: `created`, `processed`, `canceled`, `expired`, `refunded`.
 * - El token es el OAuth del vendedor obtenido con la aplicación de Mercado Pago creada para
 *   "Código QR" (pagos presenciales), distinta de la de pagos online: ver `mp-qr-oauth.ts`.
 *
 * Este módulo no toca la base ni lee el entorno: recibe el token y `fetch` por parámetro.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export const MP_API_URL = 'https://api.mercadopago.com'
export const MODO_QR = 'static' as const
/** Vida de una orden sin pagar. Con QR estático bloquea la caja, así que no conviene que sea larga. */
export const EXPIRACION_COBRO_MINUTOS = 10
export const EXPIRACION_ORDEN_MP = `PT${EXPIRACION_COBRO_MINUTOS}M`
const TIMEOUT_MP_MS = 12_000
/** `GET /v2/pos` admite de 1 a 30 resultados por página. */
const LIMITE_PAGINA_MP = 30

export type EstadoCobroQr = 'creando' | 'creado' | 'pagado' | 'cancelado' | 'vencido' | 'reembolsado' | 'error'
export const ESTADOS_COBRO_ACTIVOS: readonly EstadoCobroQr[] = ['creando', 'creado']

// ────────────────────────────── Montos ──────────────────────────────

/** Convierte a centavos enteros; `null` si no es un número finito. Nunca confía en el formato. */
export function aCentavos(monto: string | number | null | undefined): number | null {
  if (monto === null || monto === undefined || monto === '') return null
  const n = typeof monto === 'number' ? monto : Number(String(monto).trim())
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

export function centavosAMonto(centavos: number): string {
  return (centavos / 100).toFixed(2)
}

export const montosIguales = (a: string | number | null | undefined, b: string | number | null | undefined) => {
  const x = aCentavos(a)
  const y = aCentavos(b)
  return x !== null && y !== null && x === y
}

/** Monto listo para Mercado Pago ("1500.00") o `null` si no es un importe positivo. */
export function montoParaMp(monto: string | number | null | undefined): string | null {
  const centavos = aCentavos(monto)
  return centavos !== null && centavos > 0 ? centavosAMonto(centavos) : null
}

// ─────────────────────────── Identificadores ───────────────────────────

const azarHex = (bytes = 4) => randomBytes(bytes).toString('hex')

/** `external_reference` (máx. 64, sólo letras, números, guiones): trazable y sin colisión entre entornos. */
export function nuevaReferenciaCobro(restauranteId: number, pedidoId: number, azar: () => string = azarHex): string {
  return `piru-qr-${restauranteId}-${pedidoId}-${azar()}`.slice(0, 64)
}

/** `external_id` de una caja creada por Piru: alfanumérico en mayúsculas (máx. 40 en Mercado Pago). */
export function nuevoExternalPosId(restauranteId: number, azar: () => string = () => azarHex(5)): string {
  return `PIRU${restauranteId}${azar().toUpperCase()}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 40)
}

// ───────────────────────── Orden: armado e interpretación ─────────────────────────

export interface EntradaOrdenQr {
  /** Ya validado con `montoParaMp`. */
  monto: string
  referencia: string
  externalPosId: string
  descripcion: string
}

/** Cuerpo mínimo de `POST /v1/orders`: sin `payer`, sin `items` y sin campos legados. */
export function armarOrdenQr(entrada: EntradaOrdenQr) {
  return {
    type: 'qr',
    total_amount: entrada.monto,
    description: entrada.descripcion.slice(0, 150),
    external_reference: entrada.referencia,
    expiration_time: EXPIRACION_ORDEN_MP,
    config: { qr: { external_pos_id: entrada.externalPosId, mode: MODO_QR } },
    transactions: { payments: [{ amount: entrada.monto }] },
  }
}

export interface PagoOrdenMp {
  id: string | null
  status: string | null
  statusDetail: string | null
  amount: string | null
  paidAmount: string | null
}

export interface OrdenMp {
  id: string
  status: string
  statusDetail: string | null
  externalReference: string | null
  totalAmount: string | null
  totalPaidAmount: string | null
  pagos: PagoOrdenMp[]
}

const texto = (valor: unknown): string | null => {
  if (typeof valor === 'string') return valor.trim() === '' ? null : valor
  if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor)
  return null
}

/** Lee sólo lo que usamos de la respuesta de Mercado Pago. `null` si ni siquiera trae `id`. */
export function normalizarOrdenMp(crudo: unknown): OrdenMp | null {
  if (!crudo || typeof crudo !== 'object') return null
  const o = crudo as Record<string, any>
  const id = texto(o.id)
  if (!id) return null
  const pagosCrudos: unknown[] = Array.isArray(o.transactions?.payments) ? o.transactions.payments : []
  return {
    id,
    status: (texto(o.status) ?? '').toLowerCase(),
    statusDetail: texto(o.status_detail),
    externalReference: texto(o.external_reference),
    totalAmount: texto(o.total_amount),
    totalPaidAmount: texto(o.total_paid_amount),
    pagos: pagosCrudos.filter((p): p is Record<string, any> => !!p && typeof p === 'object').map((p) => ({
      id: texto(p.id),
      status: texto(p.status)?.toLowerCase() ?? null,
      statusDetail: texto(p.status_detail),
      amount: texto(p.amount),
      paidAmount: texto(p.paid_amount),
    })),
  }
}

export type ResultadoOrdenMp =
  | { estado: 'creado'; mpStatus: string; mpStatusDetail: string | null }
  | { estado: 'pagado'; mpStatus: string; mpStatusDetail: string | null; paymentId: string | null; montoPagado: string }
  | { estado: 'cancelado' | 'vencido' | 'reembolsado'; mpStatus: string; mpStatusDetail: string | null }
  | { estado: 'error'; mpStatus: string; mpStatusDetail: string | null; mensaje: string }

function centavosPagados(orden: OrdenMp): number | null {
  const total = aCentavos(orden.totalPaidAmount)
  if (total !== null) return total
  const acreditados = orden.pagos.filter((p) => p.status === 'processed')
  if (acreditados.length === 0) return null
  let suma = 0
  for (const pago of acreditados) {
    const c = aCentavos(pago.paidAmount ?? pago.amount)
    if (c === null) return null
    suma += c
  }
  return suma
}

/**
 * Traduce la orden de Mercado Pago al estado del cobro. Sólo `processed` con la referencia y el
 * monto esperados cuenta como pago: cualquier incoherencia queda como `error` para revisión
 * manual en lugar de marcar pagado un pedido.
 */
export function interpretarOrdenMp(orden: OrdenMp, esperado: { montoCentavos: number; referencia: string }): ResultadoOrdenMp {
  const mpStatus = orden.status
  const mpStatusDetail = orden.statusDetail
  if (orden.externalReference && orden.externalReference !== esperado.referencia) {
    return { estado: 'error', mpStatus, mpStatusDetail, mensaje: 'La orden de Mercado Pago no corresponde a este cobro' }
  }
  switch (mpStatus) {
    case 'processed': {
      const totalOrden = aCentavos(orden.totalAmount)
      if (totalOrden !== null && totalOrden !== esperado.montoCentavos) {
        return { estado: 'error', mpStatus, mpStatusDetail, mensaje: 'El monto de la orden no coincide con el del pedido' }
      }
      const pagado = centavosPagados(orden)
      if (pagado !== null && pagado < esperado.montoCentavos) {
        return { estado: 'error', mpStatus, mpStatusDetail, mensaje: 'Mercado Pago acreditó menos que el total del pedido' }
      }
      return {
        estado: 'pagado',
        mpStatus,
        mpStatusDetail,
        paymentId: orden.pagos.find((p) => p.id)?.id ?? null,
        montoPagado: centavosAMonto(pagado ?? esperado.montoCentavos),
      }
    }
    case 'canceled':
    case 'cancelled':
      return { estado: 'cancelado', mpStatus, mpStatusDetail }
    case 'expired':
      return { estado: 'vencido', mpStatus, mpStatusDetail }
    case 'refunded':
      return { estado: 'reembolsado', mpStatus, mpStatusDetail }
    case 'failed':
      return { estado: 'error', mpStatus, mpStatusDetail, mensaje: 'Mercado Pago no pudo procesar el pago' }
    default:
      // created, processing, action_required… todavía a la espera del comprador.
      return { estado: 'creado', mpStatus, mpStatusDetail }
  }
}

// ─────────────────────────────── Errores ───────────────────────────────

export class MpError extends Error {
  status: number
  code: string | null
  detalle: unknown
  /** Falló la comunicación (red/timeout): no se sabe si Mercado Pago llegó a procesar el pedido. */
  red: boolean

  constructor(mensaje: string, opciones: { status?: number; code?: string | null; detalle?: unknown; red?: boolean } = {}) {
    super(mensaje)
    this.name = 'MpError'
    this.status = opciones.status ?? 0
    this.code = opciones.code ?? null
    this.detalle = opciones.detalle
    this.red = opciones.red ?? false
  }

  get cajaOcupada(): boolean {
    return this.code === 'already_queued_order_on_pos'
  }
}

/** Diagnóstico para logs de OAuth: Drizzle incluye SQL y tokens incluso en Error.message. */
export function diagnosticoSeguroQr(error: unknown): Record<string, string | number | boolean> {
  if (error instanceof MpError) return { tipo: 'mercadopago', status: error.status, red: error.red }
  // Drizzle envuelve el error del driver en `cause`. Nunca registrar mensajes, SQL, params ni stacks.
  let causa = error
  for (let nivel = 0; nivel < 5 && causa && typeof causa === 'object'; nivel++) {
    const datos = causa as Record<string, unknown>
    if (typeof datos.code === 'string' && /^ER_[A-Z0-9_]{1,64}$/.test(datos.code)) {
      return {
        tipo: 'mysql',
        codigo: datos.code,
        ...(typeof datos.errno === 'number' && Number.isSafeInteger(datos.errno) ? { numero: datos.errno } : {}),
        ...(typeof datos.sqlState === 'string' && /^[A-Z0-9]{5}$/.test(datos.sqlState) ? { estadoSql: datos.sqlState } : {}),
      }
    }
    causa = datos.cause
  }
  return { tipo: 'desconocido' }
}

/** Mercado Pago usa `errors[]` (Orders) o `message`/`cause[]` (API clásica). */
export function detalleErrorMp(payload: unknown): { code: string | null; message: string | null } {
  if (!payload || typeof payload !== 'object') return { code: null, message: null }
  const p = payload as Record<string, any>
  const primero = Array.isArray(p.errors) ? p.errors[0] : null
  const causa = Array.isArray(p.cause) ? p.cause[0] : null
  const code = texto(primero?.code) ?? texto(causa?.code) ?? texto(p.error)
  const message = texto(primero?.message) ?? texto(causa?.description) ?? texto(p.message)
  return { code, message }
}

// ─────────────────────────── Cajas y tiendas ───────────────────────────

export interface CajaMp {
  id: string
  nombre: string
  externalId: string | null
  storeId: string | null
  externalStoreId: string | null
  qrImagen: string | null
  qrPlantilla: string | null
  /** `false` si Mercado Pago la tiene `inactive`: no puede recibir pagos. */
  activa: boolean
}

/**
 * Nombre que acepta `POST /v2/pos`: sólo letras, números, guiones, guiones bajos y espacios internos,
 * hasta 45 caracteres. Se quitan acentos y signos en lugar de rechazar lo que escribió el dueño.
 */
export function nombreCajaMp(nombre: string): string {
  const limpio = nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 _-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 45)
    .trim()
  return limpio || 'Caja Piru'
}

export interface TiendaMp {
  id: string
  nombre: string
  externalId: string | null
  direccion: string | null
}

export function normalizarCajaMp(crudo: unknown): CajaMp | null {
  if (!crudo || typeof crudo !== 'object') return null
  const p = crudo as Record<string, any>
  const id = texto(p.id)
  if (!id) return null
  // `/v2/pos` devuelve el QR en `qr_response`; la API anterior lo devolvía en `qr`.
  const qr = p.qr_response && typeof p.qr_response === 'object' ? p.qr_response : p.qr
  return {
    id,
    nombre: texto(p.name) ?? `Caja ${id}`,
    externalId: texto(p.external_id),
    storeId: texto(p.store_id),
    externalStoreId: texto(p.external_store_id),
    qrImagen: texto(qr?.image),
    qrPlantilla: texto(qr?.template_document) ?? texto(qr?.template_image),
    activa: texto(p.status)?.toLowerCase() !== 'inactive',
  }
}

/** Filas de una respuesta paginada: `data` (cajas) o `results` (tiendas), a veces envueltas en un arreglo. */
function filasDeLista(datos: any): unknown[] {
  const pagina = Array.isArray(datos) && datos.length > 0 && !Array.isArray(datos[0]) && datos[0] && ('results' in datos[0] || 'data' in datos[0]) ? datos[0] : datos
  if (Array.isArray(pagina?.data)) return pagina.data
  if (Array.isArray(pagina?.results)) return pagina.results
  return Array.isArray(pagina) ? pagina : []
}

export function normalizarTiendaMp(crudo: unknown): TiendaMp | null {
  if (!crudo || typeof crudo !== 'object') return null
  const t = crudo as Record<string, any>
  const id = texto(t.id)
  if (!id) return null
  const ubicacion = t.location && typeof t.location === 'object' ? t.location : {}
  const calle = [texto(ubicacion.street_name), texto(ubicacion.street_number)].filter(Boolean).join(' ')
  return {
    id,
    nombre: texto(t.name) ?? `Tienda ${id}`,
    externalId: texto(t.external_id),
    direccion: texto(ubicacion.address_line) ?? (calle || null),
  }
}

// ─────────────────────────── Cliente HTTP ───────────────────────────

export interface DependenciasClienteMp {
  /** Token OAuth vigente del vendedor, o `null` si no tiene Mercado Pago conectado. */
  obtenerToken: (restauranteId: number) => Promise<string | null>
  /**
   * Renueva el token tras un 401 y devuelve el que corresponde usar. Recibe el token que falló: si otro
   * proceso ya lo renovó, devuelve el nuevo sin gastar el `refresh_token` (cada renovación lo rota).
   */
  refrescarToken: (restauranteId: number, tokenFallido: string) => Promise<string | null>
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface ClienteMpQr {
  crearOrdenQr(restauranteId: number, entrada: EntradaOrdenQr): Promise<OrdenMp>
  obtenerOrden(restauranteId: number, mpOrderId: string): Promise<OrdenMp>
  cancelarOrden(restauranteId: number, mpOrderId: string): Promise<OrdenMp>
  listarCajas(restauranteId: number): Promise<CajaMp[]>
  obtenerCaja(restauranteId: number, mpPosId: string): Promise<CajaMp | null>
  listarTiendas(restauranteId: number, mpUserId: string): Promise<TiendaMp[]>
  crearCaja(restauranteId: number, entrada: { nombre: string; tiendaId: string; externalPosId: string }): Promise<CajaMp>
}

export function crearClienteMpQr(dependencias: DependenciasClienteMp): ClienteMpQr {
  const enviarHttp = dependencias.fetch ?? fetch
  const timeoutMs = dependencias.timeoutMs ?? TIMEOUT_MP_MS

  async function pedir(
    restauranteId: number,
    metodo: 'GET' | 'POST',
    ruta: string,
    opciones: { cuerpo?: unknown; idempotencia?: string } = {},
  ): Promise<any> {
    const token = await dependencias.obtenerToken(restauranteId)
    if (!token) throw new MpError('Mercado Pago no está conectado para cobros con QR', { status: 401, code: 'mp_no_conectado' })

    const enviar = async (bearer: string): Promise<Response> => {
      try {
        return await enviarHttp(`${MP_API_URL}${ruta}`, {
          method: metodo,
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
            ...(opciones.idempotencia ? { 'X-Idempotency-Key': opciones.idempotencia } : {}),
          },
          body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        throw new MpError('No se pudo comunicar con Mercado Pago', { red: true, detalle: String(error) })
      }
    }

    let respuesta = await enviar(token)
    if (respuesta.status === 401) {
      const renovado = await dependencias.refrescarToken(restauranteId, token)
      if (renovado && renovado !== token) respuesta = await enviar(renovado)
    }

    const crudo = await respuesta.text().catch(() => '')
    let datos: unknown = null
    if (crudo) {
      try { datos = JSON.parse(crudo) } catch { datos = { message: crudo.slice(0, 300) } }
    }
    if (!respuesta.ok) {
      const { code, message } = detalleErrorMp(datos)
      throw new MpError(message ?? `Mercado Pago respondió ${respuesta.status}`, { status: respuesta.status, code, detalle: datos })
    }
    return datos
  }

  const ordenODeError = (crudo: unknown): OrdenMp => {
    const orden = normalizarOrdenMp(crudo)
    if (!orden) throw new MpError('Mercado Pago devolvió una orden sin identificador', { detalle: crudo })
    return orden
  }

  return {
    async crearOrdenQr(restauranteId, entrada) {
      const crudo = await pedir(restauranteId, 'POST', '/v1/orders', {
        cuerpo: armarOrdenQr(entrada),
        // La referencia es única por intento: reintentar el mismo intento no duplica la orden.
        idempotencia: entrada.referencia,
      })
      return ordenODeError(crudo)
    },

    async obtenerOrden(restauranteId, mpOrderId) {
      return ordenODeError(await pedir(restauranteId, 'GET', `/v1/orders/${encodeURIComponent(mpOrderId)}`))
    },

    async cancelarOrden(restauranteId, mpOrderId) {
      return ordenODeError(await pedir(restauranteId, 'POST', `/v1/orders/${encodeURIComponent(mpOrderId)}/cancel`, {
        // Una clave nueva por intento: con una fija, reintentar tras un fallo (p. ej. un pago en curso)
        // devolvería `idempotency_key_already_used` en lugar de evaluar de nuevo la cancelación.
        idempotencia: randomUUID(),
      }))
    },

    async listarCajas(restauranteId) {
      const cajas: CajaMp[] = []
      // Tope de 4 páginas de 30: un vendedor normal tiene un puñado de cajas.
      for (let pagina = 0; pagina < 4; pagina++) {
        const datos = await pedir(restauranteId, 'GET', `/v2/pos?limit=${LIMITE_PAGINA_MP}&offset=${pagina * LIMITE_PAGINA_MP}`)
        const resultados = filasDeLista(datos)
        for (const item of resultados) {
          const caja = normalizarCajaMp(item)
          if (caja) cajas.push(caja)
        }
        if (resultados.length < LIMITE_PAGINA_MP) break
      }
      return cajas
    },

    async obtenerCaja(restauranteId, mpPosId) {
      try {
        return normalizarCajaMp(await pedir(restauranteId, 'GET', `/v2/pos/${encodeURIComponent(mpPosId)}`))
      } catch (error) {
        // `pos_not_found` (404) o una caja que no es de este vendedor (400 `bad_request`).
        if (error instanceof MpError && (error.status === 404 || error.status === 400)) return null
        throw error
      }
    },

    async listarTiendas(restauranteId, mpUserId) {
      const datos = await pedir(restauranteId, 'GET', `/users/${encodeURIComponent(mpUserId)}/stores/search?limit=${LIMITE_PAGINA_MP}&offset=0`)
      return filasDeLista(datos).map(normalizarTiendaMp).filter((t): t is TiendaMp => t !== null)
    },

    async crearCaja(restauranteId, entrada) {
      const tiendaId = String(entrada.tiendaId ?? '').trim()
      if (!/^\d{1,20}$/.test(tiendaId)) throw new MpError('La tienda de Mercado Pago no es válida', { code: 'tienda_invalida' })
      const crudo = await pedir(restauranteId, 'POST', '/v2/pos', {
        cuerpo: {
          name: nombreCajaMp(entrada.nombre),
          store_id: tiendaId,
          external_id: entrada.externalPosId,
          // `pdv`: modo atendido (hay un cajero). Es el que acompaña a las órdenes QR estáticas por API.
          config: { qr: { operating_mode: 'pdv' } },
        },
        // `external_id` es único por intento (azar en `nuevoExternalPosId`): sirve de clave y evita duplicar la caja.
        idempotencia: entrada.externalPosId,
      })
      const caja = normalizarCajaMp(crudo)
      if (!caja) throw new MpError('Mercado Pago devolvió una caja sin identificador', { detalle: crudo })
      return caja
    },
  }
}

// ───────────────────────── Webhook ─────────────────────────

/**
 * Notificaciones de la Orders API (QR, Point): tópico `order`/`orders` o acción `order.*`.
 * Los pagos clásicos (`payment`) siguen su propio camino.
 */
export function esNotificacionDeOrden(type: unknown, topic: unknown, action: unknown): boolean {
  const esOrden = (valor: unknown) => ['order', 'orders'].includes(String(valor ?? '').toLowerCase())
  return esOrden(type) || esOrden(topic) || String(action ?? '').toLowerCase().startsWith('order.')
}

/**
 * Valida `x-signature` (`ts=…,v1=…`): HMAC-SHA256 hex de `id:{data.id};request-id:{x-request-id};ts:{ts};`.
 * `data.id` es el parámetro `data.id` de la URL (no el del cuerpo), en minúsculas. Si `data.id` o
 * `x-request-id` no llegaron, se omiten del manifiesto antes de calcular el HMAC. Comparación en
 * tiempo constante.
 */
export function validarFirmaWebhookMp(entrada: {
  secreto: string
  firma: string | null | undefined
  requestId: string | null | undefined
  dataId: string | null | undefined
}): boolean {
  const { secreto, firma, requestId, dataId } = entrada
  if (!secreto || !firma) return false
  const partes = Object.fromEntries(
    firma.split(',').map((parte) => {
      const i = parte.indexOf('=')
      return i < 0 ? [parte.trim(), ''] : [parte.slice(0, i).trim(), parte.slice(i + 1).trim()]
    }),
  ) as Record<string, string>
  const { ts, v1 } = partes
  if (!ts || !v1) return false
  const manifiesto = `${[
    ...(dataId ? [`id:${dataId.toLowerCase()}`] : []),
    ...(requestId ? [`request-id:${requestId}`] : []),
    `ts:${ts}`,
  ].join(';')};`
  const esperado = createHmac('sha256', secreto).update(manifiesto).digest('hex')
  const recibido = Buffer.from(v1, 'utf8')
  const calculado = Buffer.from(esperado, 'utf8')
  return recibido.length === calculado.length && timingSafeEqual(recibido, calculado)
}
