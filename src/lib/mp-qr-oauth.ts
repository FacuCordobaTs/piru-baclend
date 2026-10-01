/**
 * Conexión OAuth de un local con la aplicación de Mercado Pago creada para "Código QR".
 *
 * Por qué es una aplicación aparte (documentación oficial de Mercado Pago):
 * - Cada aplicación se crea para UNA solución: pagos online (Checkout Pro, Bricks, suscripciones…) o
 *   pagos presenciales (Código QR, Point). Mercado Pago recomienda una aplicación por solución, cada una
 *   con sus propias credenciales y notificaciones (panel «Tus integraciones»).
 * - Para cobrar con QR a nombre de otro vendedor se le pide autorizar, por OAuth (Authorization code), la
 *   aplicación con la que se integra Código QR (guía «Salir a producción»); las notificaciones `order` se
 *   configuran en esa misma aplicación.
 * Por eso los tokens de la aplicación online (`restaurante.mp_access_token`) no se usan acá: cada local
 * autoriza la aplicación presencial por separado y sus tokens viven en `mp_conexion_qr`.
 *
 * Este módulo es puro salvo `fetch`, que llega por parámetro: no toca la base ni lee `process.env`
 * (salvo `leerConfigOAuthQr`, que recibe el entorno).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { MP_API_URL, MpError, detalleErrorMp } from './mp-qr'

export const URL_AUTORIZACION_MP = 'https://auth.mercadopago.com.ar/authorization'
export const REDIRECT_URI_QR_POR_DEFECTO = 'https://api.piru.app/api/mp-qr/callback'
/** Cuánto tiempo vale el `state` desde que se genera hasta que vuelve el vendedor (el código vale 10 min). */
export const VIGENCIA_ESTADO_OAUTH_MS = 15 * 60_000
const TIMEOUT_OAUTH_MS = 12_000

export interface ConfigOAuthQr {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/** Aplicación de Mercado Pago para Código QR, o `null` si el servidor todavía no la tiene configurada. */
export function leerConfigOAuthQr(env: Record<string, string | undefined>): ConfigOAuthQr | null {
  const clientId = env.MP_QR_CLIENT_ID?.trim()
  const clientSecret = env.MP_QR_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret, redirectUri: env.MP_QR_REDIRECT_URI?.trim() || REDIRECT_URI_QR_POR_DEFECTO }
}

// ─────────────────────────────── `state` firmado ───────────────────────────────
//
// El `state` viaja por el navegador del vendedor y vuelve en el callback, que es público: no puede ser
// el id del local a secas (cualquiera podría armar uno ajeno). Se firma con el secreto de la aplicación,
// así sólo lo genera este servidor, y caduca.

const firmaDe = (cuerpo: string, secreto: string) => createHmac('sha256', secreto).update(`mp-qr-oauth:${cuerpo}`).digest('hex')

const azarHex = () => randomBytes(8).toString('hex')

export function firmarEstadoOAuth(restauranteId: number, secreto: string, ahoraMs: number, azar: () => string = azarHex): string {
  const cuerpo = `${restauranteId}.${ahoraMs}.${azar()}`
  return `${cuerpo}.${firmaDe(cuerpo, secreto)}`
}

/** Id del local si el `state` es auténtico y vigente; `null` en cualquier otro caso. */
export function leerEstadoOAuth(
  estado: string | null | undefined,
  secreto: string,
  ahoraMs: number,
  vigenciaMs = VIGENCIA_ESTADO_OAUTH_MS,
): number | null {
  if (!estado || !secreto) return null
  const partes = estado.split('.')
  if (partes.length !== 4) return null
  const [id, ts, azar, firma] = partes
  if (!/^\d{1,10}$/.test(id) || !/^\d{10,16}$/.test(ts) || !/^[0-9a-f]{4,64}$/.test(azar) || !/^[0-9a-f]{64}$/.test(firma)) return null
  const esperada = Buffer.from(firmaDe(`${id}.${ts}.${azar}`, secreto))
  const recibida = Buffer.from(firma)
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null
  const edad = ahoraMs - Number(ts)
  // Un `ts` apenas en el futuro es desfase de reloj; mucho más, o vencido, no se acepta.
  if (edad < -60_000 || edad > vigenciaMs) return null
  const restauranteId = Number(id)
  return Number.isSafeInteger(restauranteId) && restauranteId > 0 ? restauranteId : null
}

/** URL a la que se lleva al vendedor para que autorice la aplicación (flujo Authorization code). */
export function urlAutorizacionQr(config: ConfigOAuthQr, estado: string): string {
  const url = new URL(URL_AUTORIZACION_MP)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('platform_id', 'mp')
  url.searchParams.set('state', estado)
  url.searchParams.set('redirect_uri', config.redirectUri)
  return url.toString()
}

// ───────────────────────────────── Tokens ─────────────────────────────────

export interface TokensOAuth {
  accessToken: string
  /** Mercado Pago lo rota en cada renovación: hay que guardar siempre el último. */
  refreshToken: string | null
  mpUserId: string | null
  scope: string | null
  liveMode: boolean
  /** El access token dura 180 días (`expires_in`). */
  expiraAt: Date | null
}

/** Lee sólo lo que usamos de `POST /oauth/token`. `null` si no trae un access token. */
export function normalizarTokensOAuth(crudo: unknown, ahora: Date): TokensOAuth | null {
  if (!crudo || typeof crudo !== 'object') return null
  const t = crudo as Record<string, unknown>
  const accessToken = typeof t.access_token === 'string' ? t.access_token.trim() : ''
  if (!accessToken) return null
  const refreshToken = typeof t.refresh_token === 'string' && t.refresh_token.trim() ? t.refresh_token.trim() : null
  const userId = t.user_id !== undefined && t.user_id !== null ? String(t.user_id).trim() : ''
  const expiresIn = Number(t.expires_in)
  return {
    accessToken,
    refreshToken,
    mpUserId: userId || null,
    scope: typeof t.scope === 'string' && t.scope.trim() ? t.scope.trim() : null,
    liveMode: t.live_mode !== false,
    expiraAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(ahora.getTime() + expiresIn * 1000) : null,
  }
}

export interface DependenciasOAuth {
  fetch?: typeof fetch
  ahora?: () => Date
}

async function pedirToken(config: ConfigOAuthQr, cuerpo: Record<string, string>, dependencias: DependenciasOAuth): Promise<TokensOAuth> {
  const enviar = dependencias.fetch ?? fetch
  const ahora = dependencias.ahora ?? (() => new Date())
  let respuesta: Response
  try {
    respuesta = await enviar(`${MP_API_URL}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...cuerpo }),
      signal: AbortSignal.timeout(TIMEOUT_OAUTH_MS),
    })
  } catch (error) {
    throw new MpError('No se pudo comunicar con Mercado Pago', { red: true, detalle: String(error) })
  }
  const crudo = await respuesta.text().catch(() => '')
  let datos: unknown = null
  try { datos = crudo ? JSON.parse(crudo) : null } catch { datos = null }
  if (!respuesta.ok) {
    const { code, message } = detalleErrorMp(datos)
    throw new MpError(message ?? `Mercado Pago respondió ${respuesta.status}`, { status: respuesta.status, code, detalle: datos })
  }
  const tokens = normalizarTokensOAuth(datos, ahora())
  if (!tokens) throw new MpError('Mercado Pago no devolvió un access token', { status: respuesta.status, detalle: datos })
  return tokens
}

/** Cambia el `code` del callback por los tokens del vendedor. El código vale 10 minutos y es de un solo uso. */
export function canjearCodigoOAuth(config: ConfigOAuthQr, code: string, dependencias: DependenciasOAuth = {}): Promise<TokensOAuth> {
  return pedirToken(config, { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }, dependencias)
}

/** Renueva el access token con el `refresh_token`: devuelve un par nuevo y el anterior deja de servir. */
export function renovarTokensOAuth(config: ConfigOAuthQr, refreshToken: string, dependencias: DependenciasOAuth = {}): Promise<TokensOAuth> {
  return pedirToken(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, dependencias)
}

/** ¿Mercado Pago dio por perdida la autorización (código o refresh token inválido)? Hay que reconectar. */
export const autorizacionPerdida = (error: unknown): boolean =>
  error instanceof MpError && !error.red && (error.status === 400 || error.status === 401 || error.status === 403)
