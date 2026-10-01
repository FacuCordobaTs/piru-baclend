/**
 * Conexión de cada local con la aplicación de Mercado Pago creada para "Código QR" (pagos presenciales):
 * iniciar la autorización, completarla en el callback, entregar un token vigente (renovándolo a tiempo)
 * y desconectar. Ver `mp-qr-oauth.ts` para el porqué de una aplicación aparte.
 *
 * No importa la base ni el entorno: la persistencia llega por `repo` y la configuración por `config`.
 */
import { MpError } from './mp-qr'
import {
  canjearCodigoOAuth,
  firmarEstadoOAuth,
  leerEstadoOAuth,
  renovarTokensOAuth,
  urlAutorizacionQr,
  type ConfigOAuthQr,
  type TokensOAuth,
} from './mp-qr-oauth'
import type { Resultado } from './pos-cobros-qr'

export interface ConexionQr {
  restauranteId: number
  mpUserId: string
  accessToken: string
  refreshToken: string | null
  scope: string | null
  expiraAt: Date | null
  /** `false` cuando Mercado Pago dio por perdida la autorización: hay que volver a conectar. */
  conectado: boolean
}

export type TokensConCuenta = TokensOAuth & { mpUserId: string }

export interface RepositorioConexionQr {
  /** El local tiene el módulo comercial "Mercado Pago". */
  moduloActivo(restauranteId: number): Promise<boolean>
  leer(restauranteId: number): Promise<ConexionQr | null>
  /**
   * Guarda (o reemplaza) la conexión del local, que es única. Si ya había otra cuenta de Mercado Pago,
   * las cajas vinculadas con ella dejan de servir y se desactivan.
   */
  guardar(restauranteId: number, tokens: TokensConCuenta, ahora: Date): Promise<{ cuentaCambiada: boolean }>
  /**
   * Renueva los tokens bajo lock de la fila. Si el token vigente ya no es `tokenFallido`, otro proceso
   * lo renovó y se devuelve ése sin gastar el `refresh_token` (cada renovación lo rota). Si Mercado
   * Pago da por perdida la autorización, la conexión queda `conectado=false`.
   */
  renovar(
    restauranteId: number,
    tokenFallido: string | null,
    renovarEnMp: (refreshToken: string) => Promise<TokensOAuth>,
    ahora: Date,
  ): Promise<string | null>
  /** Borra la conexión y desactiva las cajas vinculadas. */
  desconectar(restauranteId: number): Promise<void>
}

export type MotivoFalloConexion =
  | 'denegado'
  | 'faltan_parametros'
  | 'sin_configurar'
  | 'estado_invalido'
  | 'modulo'
  | 'oauth_fallido'
  | 'cuenta_invalida'

export type ResultadoConexion = { ok: true; restauranteId: number } | { ok: false; motivo: MotivoFalloConexion }

export interface DependenciasConexionQr {
  repo: RepositorioConexionQr
  /** Aplicación de Mercado Pago para QR, o `null` si el servidor no la tiene configurada. */
  config: () => ConfigOAuthQr | null
  fetch?: typeof fetch
  ahora?: () => Date
  /** Se renueva con esta anticipación al vencimiento, para no depender de un 401 en pleno cobro. */
  anticipacionRenovacionMs?: number
  log?: (mensaje: string, detalle?: unknown) => void
}

const SIETE_DIAS_MS = 7 * 24 * 60 * 60_000

export function crearServicioConexionQr(deps: DependenciasConexionQr) {
  const { repo } = deps
  const ahora = deps.ahora ?? (() => new Date())
  const anticipacion = deps.anticipacionRenovacionMs ?? SIETE_DIAS_MS
  const log = deps.log ?? ((mensaje, detalle) => console.error(`[mp-conexion-qr] ${mensaje}`, detalle ?? ''))
  const dependenciasHttp = () => ({ fetch: deps.fetch, ahora })

  async function refrescar(restauranteId: number, tokenFallido: string | null): Promise<string | null> {
    const config = deps.config()
    if (!config) return null
    try {
      return await repo.renovar(
        restauranteId,
        tokenFallido,
        (refreshToken) => renovarTokensOAuth(config, refreshToken, dependenciasHttp()),
        ahora(),
      )
    } catch (error) {
      // Un fallo de base o de red no debe tumbar el cobro: se sigue con el token que había.
      log(`No se pudo renovar el token del local ${restauranteId}`, error instanceof MpError ? error.message : error)
      return null
    }
  }

  return {
    /** ¿Está configurada la aplicación de Mercado Pago para QR en este servidor? */
    configurada: () => deps.config() !== null,

    async estado(restauranteId: number): Promise<{ conectado: boolean; mpUserId: string | null }> {
      const conexion = await repo.leer(restauranteId)
      return conexion?.conectado ? { conectado: true, mpUserId: conexion.mpUserId } : { conectado: false, mpUserId: null }
    },

    /** URL a la que se lleva al vendedor para que autorice la aplicación de QR. */
    async iniciar(restauranteId: number): Promise<Resultado<{ url: string }>> {
      const config = deps.config()
      if (!config) {
        return { ok: false, codigo: 'APP_QR_NO_CONFIGURADA', status: 503, mensaje: 'El cobro con QR todavía no está habilitado en Piru. Avisanos para activarlo.' }
      }
      if (!(await repo.moduloActivo(restauranteId))) {
        return { ok: false, codigo: 'MODULO_MP_INACTIVO', status: 403, mensaje: 'Activá el módulo Mercado Pago para cobrar con QR' }
      }
      const estado = firmarEstadoOAuth(restauranteId, config.clientSecret, ahora().getTime())
      return { ok: true, data: { url: urlAutorizacionQr(config, estado) } }
    },

    /** Callback de Mercado Pago: valida el `state`, cambia el `code` por los tokens y los guarda. */
    async completar(entrada: { code?: string | null; state?: string | null; error?: string | null }): Promise<ResultadoConexion> {
      if (entrada.error) return { ok: false, motivo: 'denegado' }
      const config = deps.config()
      if (!config) return { ok: false, motivo: 'sin_configurar' }
      if (!entrada.code || !entrada.state) return { ok: false, motivo: 'faltan_parametros' }
      const restauranteId = leerEstadoOAuth(entrada.state, config.clientSecret, ahora().getTime())
      if (restauranteId === null) return { ok: false, motivo: 'estado_invalido' }
      if (!(await repo.moduloActivo(restauranteId))) return { ok: false, motivo: 'modulo' }

      let tokens: TokensOAuth
      try {
        tokens = await canjearCodigoOAuth(config, entrada.code, dependenciasHttp())
      } catch (error) {
        log(`Mercado Pago rechazó el código de autorización del local ${restauranteId}`, error instanceof MpError ? error.message : error)
        return { ok: false, motivo: 'oauth_fallido' }
      }
      if (!tokens.mpUserId) return { ok: false, motivo: 'cuenta_invalida' }
      const { cuentaCambiada } = await repo.guardar(restauranteId, { ...tokens, mpUserId: tokens.mpUserId }, ahora())
      if (cuentaCambiada) log(`El local ${restauranteId} conectó otra cuenta de Mercado Pago: se desactivaron sus cajas anteriores`)
      return { ok: true, restauranteId }
    },

    async desconectar(restauranteId: number): Promise<void> {
      await repo.desconectar(restauranteId)
    },

    /**
     * Access token vigente del local para llamar a la API de QR, o `null` si no está conectado. Si está
     * cerca de vencer se renueva antes; si no se puede, se sigue con el actual mientras no haya vencido.
     */
    async obtenerToken(restauranteId: number): Promise<string | null> {
      const conexion = await repo.leer(restauranteId)
      if (!conexion?.conectado || !conexion.accessToken) return null
      const porVencer = conexion.expiraAt !== null && conexion.expiraAt.getTime() - ahora().getTime() < anticipacion
      if (!porVencer || !conexion.refreshToken) return conexion.accessToken
      const renovado = await refrescar(restauranteId, conexion.accessToken)
      if (renovado) return renovado
      return conexion.expiraAt!.getTime() > ahora().getTime() ? conexion.accessToken : null
    },

    /** Tras un 401: renueva (si nadie lo hizo ya) y devuelve el token a usar. */
    refrescar,
  }
}

export type ServicioConexionQr = ReturnType<typeof crearServicioConexionQr>
