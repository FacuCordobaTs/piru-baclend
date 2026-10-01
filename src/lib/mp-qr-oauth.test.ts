import { describe, expect, test } from 'bun:test'
import { MpError } from './mp-qr'
import {
  REDIRECT_URI_QR_POR_DEFECTO,
  VIGENCIA_ESTADO_OAUTH_MS,
  autorizacionPerdida,
  canjearCodigoOAuth,
  firmarEstadoOAuth,
  leerConfigOAuthQr,
  leerEstadoOAuth,
  normalizarTokensOAuth,
  renovarTokensOAuth,
  urlAutorizacionQr,
  type ConfigOAuthQr,
} from './mp-qr-oauth'

const config: ConfigOAuthQr = { clientId: '7364289770550796', clientSecret: 'secreto-de-la-app', redirectUri: 'https://api.piru.app/api/mp-qr/callback' }
const AHORA = new Date('2026-10-01T15:00:00.000Z')

describe('configuración de la aplicación de QR', () => {
  test('sin client id o sin secreto el servidor no tiene la aplicación configurada', () => {
    expect(leerConfigOAuthQr({})).toBeNull()
    expect(leerConfigOAuthQr({ MP_QR_CLIENT_ID: '123' })).toBeNull()
    expect(leerConfigOAuthQr({ MP_QR_CLIENT_SECRET: 'x' })).toBeNull()
    expect(leerConfigOAuthQr({ MP_QR_CLIENT_ID: '  ', MP_QR_CLIENT_SECRET: 'x' })).toBeNull()
  })

  test('usa el callback de Piru por defecto y permite cambiarlo', () => {
    expect(leerConfigOAuthQr({ MP_QR_CLIENT_ID: '123', MP_QR_CLIENT_SECRET: 'x' }))
      .toEqual({ clientId: '123', clientSecret: 'x', redirectUri: REDIRECT_URI_QR_POR_DEFECTO })
    expect(REDIRECT_URI_QR_POR_DEFECTO).toBe('https://api.piru.app/api/mp-qr/callback')
    expect(leerConfigOAuthQr({ MP_QR_CLIENT_ID: '123', MP_QR_CLIENT_SECRET: 'x', MP_QR_REDIRECT_URI: 'https://otra.example/cb' })?.redirectUri)
      .toBe('https://otra.example/cb')
  })

  test('la aplicación de QR no se confunde con la de pagos online', () => {
    // Variables propias: las MP_CLIENT_ID/MP_CLIENT_SECRET de pagos online no cuentan.
    expect(leerConfigOAuthQr({ MP_CLIENT_ID: '999', MP_CLIENT_SECRET: 'online' })).toBeNull()
  })
})

describe('state firmado del OAuth', () => {
  const ahoraMs = AHORA.getTime()

  test('un state propio y vigente devuelve el local que lo pidió', () => {
    const estado = firmarEstadoOAuth(42, config.clientSecret, ahoraMs)
    expect(estado).toMatch(/^42\.\d+\.[0-9a-f]+\.[0-9a-f]{64}$/)
    expect(leerEstadoOAuth(estado, config.clientSecret, ahoraMs)).toBe(42)
    expect(leerEstadoOAuth(estado, config.clientSecret, ahoraMs + 10 * 60_000)).toBe(42)
  })

  test('cada intento genera un state distinto', () => {
    expect(firmarEstadoOAuth(42, config.clientSecret, ahoraMs)).not.toBe(firmarEstadoOAuth(42, config.clientSecret, ahoraMs))
  })

  test('no se puede apuntar el callback a otro local ni reutilizar una firma ajena', () => {
    const estado = firmarEstadoOAuth(42, config.clientSecret, ahoraMs)
    const [, ts, azar, firma] = estado.split('.')
    // El id de local plano (como el callback de pagos online) NO sirve.
    expect(leerEstadoOAuth('42', config.clientSecret, ahoraMs)).toBeNull()
    expect(leerEstadoOAuth(`7.${ts}.${azar}.${firma}`, config.clientSecret, ahoraMs)).toBeNull()
    expect(leerEstadoOAuth(`42.${ts}.${azar}.${'0'.repeat(64)}`, config.clientSecret, ahoraMs)).toBeNull()
    expect(leerEstadoOAuth(estado, 'otro-secreto', ahoraMs)).toBeNull()
  })

  test('caduca, y un reloj levemente adelantado no lo rompe', () => {
    const estado = firmarEstadoOAuth(42, config.clientSecret, ahoraMs)
    expect(leerEstadoOAuth(estado, config.clientSecret, ahoraMs + VIGENCIA_ESTADO_OAUTH_MS + 1)).toBeNull()
    expect(leerEstadoOAuth(estado, config.clientSecret, ahoraMs - 30_000)).toBe(42)
    expect(leerEstadoOAuth(estado, config.clientSecret, ahoraMs - 10 * 60_000)).toBeNull()
  })

  test('lo mal formado se rechaza sin lanzar', () => {
    for (const basura of [undefined, null, '', 'a.b.c', 'x.y.z.w', '42.1.2.3.4', `${'9'.repeat(30)}.1.ab.${'0'.repeat(64)}`]) {
      expect(leerEstadoOAuth(basura as never, config.clientSecret, ahoraMs)).toBeNull()
    }
    expect(leerEstadoOAuth(firmarEstadoOAuth(42, config.clientSecret, ahoraMs), '', ahoraMs)).toBeNull()
  })
})

describe('URL de autorización (flujo Authorization code)', () => {
  test('lleva al vendedor a Mercado Pago con la aplicación de QR y vuelve al callback registrado', () => {
    const url = new URL(urlAutorizacionQr(config, '42.1.ab.cd'))
    expect(url.origin + url.pathname).toBe('https://auth.mercadopago.com.ar/authorization')
    expect(url.searchParams.get('client_id')).toBe('7364289770550796')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('platform_id')).toBe('mp')
    expect(url.searchParams.get('state')).toBe('42.1.ab.cd')
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.piru.app/api/mp-qr/callback')
  })

  test('nunca incluye el secreto de la aplicación', () => {
    expect(urlAutorizacionQr(config, 'x')).not.toContain(config.clientSecret)
  })
})

describe('tokens', () => {
  const respuestaOficial = {
    access_token: 'APP_USR-4934588586838432-XXXXXXXX-241983636',
    token_type: 'bearer',
    expires_in: 15552000,
    scope: 'read write offline_access',
    user_id: 241983636,
    refresh_token: 'TG-XXXXXXXX-241983636',
    public_key: 'APP_USR-d0a26210-XXXXXXXX-479f0400869e',
    live_mode: true,
  }

  test('normaliza la respuesta oficial: user_id a string y vencimiento a 180 días', () => {
    const t = normalizarTokensOAuth(respuestaOficial, AHORA)!
    expect(t).toMatchObject({
      accessToken: 'APP_USR-4934588586838432-XXXXXXXX-241983636',
      refreshToken: 'TG-XXXXXXXX-241983636',
      mpUserId: '241983636',
      scope: 'read write offline_access',
      liveMode: true,
    })
    expect(t.expiraAt!.getTime() - AHORA.getTime()).toBe(15552000 * 1000)
  })

  test('sin access token no hay conexión; sin refresh token o vencimiento se tolera', () => {
    expect(normalizarTokensOAuth({ user_id: 1 }, AHORA)).toBeNull()
    expect(normalizarTokensOAuth({ access_token: '   ' }, AHORA)).toBeNull()
    expect(normalizarTokensOAuth(null, AHORA)).toBeNull()
    expect(normalizarTokensOAuth('x', AHORA)).toBeNull()
    expect(normalizarTokensOAuth({ access_token: 'A' }, AHORA)).toEqual({
      accessToken: 'A', refreshToken: null, mpUserId: null, scope: null, liveMode: true, expiraAt: null,
    })
  })
})

describe('canje del código y renovación', () => {
  interface Llamada { url: string; init: RequestInit }
  const fetchCon = (respuesta: Response | Error) => {
    const llamadas: Llamada[] = []
    const fn = (async (url: string, init: RequestInit) => {
      llamadas.push({ url, init })
      if (respuesta instanceof Error) throw respuesta
      return respuesta.clone()
    }) as unknown as typeof fetch
    return { fn, llamadas }
  }
  const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })
  const ok = { access_token: 'NUEVO', refresh_token: 'TG-NUEVO', user_id: 555, expires_in: 3600, scope: 'read' }

  test('canjea el código con las credenciales de la aplicación de QR y el mismo redirect_uri', async () => {
    const { fn, llamadas } = fetchCon(json(ok))
    const tokens = await canjearCodigoOAuth(config, 'TG-CODIGO', { fetch: fn, ahora: () => AHORA })
    expect(tokens).toMatchObject({ accessToken: 'NUEVO', refreshToken: 'TG-NUEVO', mpUserId: '555' })
    expect(llamadas).toHaveLength(1)
    expect(llamadas[0].url).toBe('https://api.mercadopago.com/oauth/token')
    expect(llamadas[0].init.method).toBe('POST')
    expect(JSON.parse(String(llamadas[0].init.body))).toEqual({
      client_id: '7364289770550796',
      client_secret: 'secreto-de-la-app',
      grant_type: 'authorization_code',
      code: 'TG-CODIGO',
      redirect_uri: 'https://api.piru.app/api/mp-qr/callback',
    })
  })

  test('renueva con grant_type refresh_token', async () => {
    const { fn, llamadas } = fetchCon(json(ok))
    await renovarTokensOAuth(config, 'TG-VIEJO', { fetch: fn, ahora: () => AHORA })
    expect(JSON.parse(String(llamadas[0].init.body))).toEqual({
      client_id: '7364289770550796', client_secret: 'secreto-de-la-app', grant_type: 'refresh_token', refresh_token: 'TG-VIEJO',
    })
  })

  test('un código inválido llega como MpError con su estado y código', async () => {
    const { fn } = fetchCon(json({ message: 'Invalid authorization code', error: 'invalid_grant', status: 400 }, 400))
    const error = await canjearCodigoOAuth(config, 'MAL', { fetch: fn }).catch((e) => e)
    expect(error).toBeInstanceOf(MpError)
    expect(error).toMatchObject({ status: 400, code: 'invalid_grant', red: false })
    expect(autorizacionPerdida(error)).toBe(true)
  })

  test('un corte de red queda marcado como tal y NO da por perdida la autorización', async () => {
    const { fn } = fetchCon(new Error('socket hang up'))
    const error = await renovarTokensOAuth(config, 'TG', { fetch: fn }).catch((e) => e)
    expect(error).toMatchObject({ name: 'MpError', red: true })
    expect(autorizacionPerdida(error)).toBe(false)
    expect(autorizacionPerdida(new MpError('boom', { status: 500 }))).toBe(false)
    expect(autorizacionPerdida(new Error('x'))).toBe(false)
  })

  test('una respuesta sin access token es un error', async () => {
    const { fn } = fetchCon(json({ user_id: 1 }))
    await expect(canjearCodigoOAuth(config, 'C', { fetch: fn })).rejects.toMatchObject({ name: 'MpError' })
  })
})
