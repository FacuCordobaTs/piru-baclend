/**
 * Dobles de test de la conexión OAuth con la aplicación de QR (no es un test: lo importan los tests de
 * `mp-conexion-qr` y de las rutas). Mantienen la semántica del repositorio de MySQL, sin concurrencia:
 * si cambia la interfaz `RepositorioConexionQr`, cambian los dos.
 */
import { crearServicioConexionQr, type ConexionQr, type RepositorioConexionQr, type TokensConCuenta } from './mp-conexion-qr'
import { MpError } from './mp-qr'
import type { ConfigOAuthQr, TokensOAuth } from './mp-qr-oauth'

export const config: ConfigOAuthQr = { clientId: '7364289770550796', clientSecret: 'secreto-de-la-app', redirectUri: 'https://api.piru.app/api/mp-qr/callback' }
export const T0 = new Date('2026-10-01T15:00:00.000Z')
export const DIA = 24 * 60 * 60_000
export const LOCAL = 42
/** Permisos de OAuth actuales: las URNs de QR y pagos exceden el antiguo VARCHAR(255). */
export const SCOPE_QR_EXTENSO = [
  'offline_access', 'payments', 'read',
  ...['instore-order', 'integration:integrator', 'pos', 'store', 'terminal:actions', 'terminal:list', 'terminal:setup']
    .map((recurso) => `urn:mp:instore:${recurso}/read-write`),
  ...['customer:cards', 'customer:customer', 'merchant-order', 'order:payment', 'payments', 'payments:cancel', 'payments:refunds', 'preference', 'subs-recurring:subscription']
    .map((recurso) => `urn:mp:online:${recurso}/read-write`),
  'write',
].join(' ')

/** Repositorio en memoria con la misma semántica que el de MySQL (sin concurrencia). */
export function repoFalso(inicial: { modulo?: boolean; conexion?: Partial<ConexionQr> | null } = {}) {
  let modulo = inicial.modulo ?? true
  const filas = new Map<number, ConexionQr>()
  if (inicial.conexion !== null) {
    filas.set(LOCAL, {
      restauranteId: LOCAL, mpUserId: '555', accessToken: 'TOKEN-A', refreshToken: 'TG-A', scope: 'read write offline_access',
      expiraAt: new Date(T0.getTime() + 90 * DIA), conectado: true, ...inicial.conexion,
    })
  }
  const registro = { guardados: [] as TokensConCuenta[], cajasDesactivadas: [] as number[], renovaciones: [] as Array<string | null>, desconexiones: [] as number[] }
  const repo: RepositorioConexionQr = {
    async moduloActivo() { return modulo },
    async leer(id) { return filas.get(id) ?? null },
    async guardar(id, tokens) {
      const previa = filas.get(id)
      const cuentaCambiada = !!previa && previa.mpUserId !== tokens.mpUserId
      registro.guardados.push(tokens)
      filas.set(id, { restauranteId: id, mpUserId: tokens.mpUserId, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, scope: tokens.scope, expiraAt: tokens.expiraAt, conectado: true })
      if (cuentaCambiada) registro.cajasDesactivadas.push(id)
      return { cuentaCambiada }
    },
    async renovar(id, tokenFallido, renovarEnMp) {
      registro.renovaciones.push(tokenFallido)
      const actual = filas.get(id)
      if (!actual?.conectado) return null
      if (tokenFallido !== null && actual.accessToken !== tokenFallido) return actual.accessToken
      if (!actual.refreshToken) return null
      let nuevos: TokensOAuth
      try { nuevos = await renovarEnMp(actual.refreshToken) } catch (error) {
        if (error instanceof MpError && !error.red && [400, 401, 403].includes(error.status)) filas.set(id, { ...actual, conectado: false })
        return null
      }
      filas.set(id, { ...actual, accessToken: nuevos.accessToken, refreshToken: nuevos.refreshToken ?? actual.refreshToken, scope: nuevos.scope ?? actual.scope, expiraAt: nuevos.expiraAt })
      return nuevos.accessToken
    },
    async desconectar(id) { filas.delete(id); registro.desconexiones.push(id) },
  }
  return { repo, filas, registro, apagarModulo: () => { modulo = false } }
}

interface Llamada { url: string; cuerpo: Record<string, string> }
export function fetchFalso(respuestas: Array<Response | Error>) {
  const llamadas: Llamada[] = []
  const fn = (async (url: string, init: RequestInit) => {
    llamadas.push({ url, cuerpo: JSON.parse(String(init.body)) })
    const siguiente = respuestas.shift()
    if (!siguiente) throw new Error('sin respuesta preparada')
    if (siguiente instanceof Error) throw siguiente
    return siguiente
  }) as unknown as typeof fetch
  return { fn, llamadas }
}
export const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })
export const tokensMp = (extra: Record<string, unknown> = {}) => ({ access_token: 'TOKEN-B', refresh_token: 'TG-B', user_id: 555, expires_in: 15552000, scope: 'read write offline_access', ...extra })

export function montar(opciones: { repo?: Parameters<typeof repoFalso>[0]; respuestas?: Array<Response | Error>; config?: ConfigOAuthQr | null } = {}) {
  const r = repoFalso(opciones.repo)
  const http = fetchFalso(opciones.respuestas ?? [])
  const logs: string[] = []
  const servicio = crearServicioConexionQr({
    repo: r.repo,
    config: () => (opciones.config === undefined ? config : opciones.config),
    fetch: http.fn,
    ahora: () => T0,
    log: (m) => { logs.push(m) },
  })
  return { ...r, ...http, servicio, logs }
}
