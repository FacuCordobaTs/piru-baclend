import { describe, expect, test } from 'bun:test'
import { DIA, LOCAL, T0, config, fetchFalso, json, montar, repoFalso, tokensMp } from './mp-conexion-qr.fakes'
import { crearServicioConexionQr } from './mp-conexion-qr'
import { leerEstadoOAuth } from './mp-qr-oauth'

describe('iniciar la conexión', () => {
  test('arma la URL de autorización con un state firmado para este local', async () => {
    const s = montar()
    const r = await s.servicio.iniciar(LOCAL)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const url = new URL(r.data.url)
    expect(url.hostname).toBe('auth.mercadopago.com.ar')
    expect(url.searchParams.get('client_id')).toBe(config.clientId)
    expect(leerEstadoOAuth(url.searchParams.get('state'), config.clientSecret, T0.getTime())).toBe(LOCAL)
    expect(s.llamadas).toHaveLength(0)
  })

  test('sin la aplicación de QR configurada en el servidor no se puede conectar', async () => {
    const s = montar({ config: null })
    expect(s.servicio.configurada()).toBe(false)
    expect(await s.servicio.iniciar(LOCAL)).toMatchObject({ ok: false, codigo: 'APP_QR_NO_CONFIGURADA', status: 503 })
  })

  test('exige el módulo comercial de Mercado Pago', async () => {
    const s = montar({ repo: { modulo: false } })
    expect(await s.servicio.iniciar(LOCAL)).toMatchObject({ ok: false, codigo: 'MODULO_MP_INACTIVO', status: 403 })
  })
})

describe('completar la conexión en el callback', () => {
  const estadoValido = async (s: ReturnType<typeof montar>) => {
    const r = await s.servicio.iniciar(LOCAL)
    if (!r.ok) throw new Error('no se pudo iniciar')
    return new URL(r.data.url).searchParams.get('state')!
  }

  test('con un state propio canjea el código y guarda los tokens del local del state', async () => {
    const s = montar({ repo: { conexion: null }, respuestas: [json(tokensMp())] })
    const state = await estadoValido(s)
    expect(await s.servicio.completar({ code: 'TG-CODIGO', state })).toEqual({ ok: true, restauranteId: LOCAL })
    expect(s.llamadas).toHaveLength(1)
    expect(s.llamadas[0].cuerpo).toMatchObject({ grant_type: 'authorization_code', code: 'TG-CODIGO', client_id: config.clientId })
    expect(s.registro.guardados).toHaveLength(1)
    expect(s.registro.guardados[0]).toMatchObject({ accessToken: 'TOKEN-B', refreshToken: 'TG-B', mpUserId: '555' })
    expect(s.filas.get(LOCAL)).toMatchObject({ conectado: true, accessToken: 'TOKEN-B' })
  })

  test('un state ajeno, adulterado o vencido no toca la red ni la base', async () => {
    const s = montar({ repo: { conexion: null }, respuestas: [json(tokensMp())] })
    const state = await estadoValido(s)
    for (const malo of ['42', `7${state.slice(2)}`, `${state.slice(0, -4)}0000`, 'basura', '']) {
      expect(await s.servicio.completar({ code: 'TG', state: malo })).toEqual({ ok: false, motivo: malo === '' ? 'faltan_parametros' : 'estado_invalido' })
    }
    expect(s.llamadas).toHaveLength(0)
    expect(s.registro.guardados).toHaveLength(0)
  })

  test('si el vendedor rechaza la autorización o faltan parámetros, no hay conexión', async () => {
    const s = montar({ repo: { conexion: null } })
    expect(await s.servicio.completar({ error: 'access_denied', state: 'x' })).toEqual({ ok: false, motivo: 'denegado' })
    expect(await s.servicio.completar({ state: 'x' })).toEqual({ ok: false, motivo: 'faltan_parametros' })
    expect(await s.servicio.completar({ code: 'x' })).toEqual({ ok: false, motivo: 'faltan_parametros' })
    expect(s.llamadas).toHaveLength(0)
  })

  test('sin configurar la aplicación o sin módulo no se canjea nada', async () => {
    const sin = montar({ config: null })
    expect(await sin.servicio.completar({ code: 'TG', state: 'x' })).toEqual({ ok: false, motivo: 'sin_configurar' })

    const s = montar({ repo: { conexion: null }, respuestas: [json(tokensMp())] })
    const state = await estadoValido(s)
    s.apagarModulo()
    expect(await s.servicio.completar({ code: 'TG', state })).toEqual({ ok: false, motivo: 'modulo' })
    expect(s.llamadas).toHaveLength(0)
  })

  test('si Mercado Pago rechaza el código, no se guarda nada', async () => {
    const s = montar({ repo: { conexion: null }, respuestas: [json({ message: 'Invalid code', error: 'invalid_grant' }, 400)] })
    const state = await estadoValido(s)
    expect(await s.servicio.completar({ code: 'MAL', state })).toEqual({ ok: false, motivo: 'oauth_fallido' })
    expect(s.registro.guardados).toHaveLength(0)
    expect(s.logs.join(' ')).not.toContain('TOKEN')
  })

  test('una respuesta sin user_id no es una cuenta utilizable', async () => {
    const s = montar({ repo: { conexion: null }, respuestas: [json({ access_token: 'T', refresh_token: 'R', expires_in: 100 })] })
    const state = await estadoValido(s)
    expect(await s.servicio.completar({ code: 'TG', state })).toEqual({ ok: false, motivo: 'cuenta_invalida' })
    expect(s.registro.guardados).toHaveLength(0)
  })

  test('conectar otra cuenta de Mercado Pago desactiva las cajas de la anterior', async () => {
    const s = montar({ repo: { conexion: { mpUserId: '111' } }, respuestas: [json(tokensMp({ user_id: 999 }))] })
    const state = await estadoValido(s)
    expect(await s.servicio.completar({ code: 'TG', state })).toEqual({ ok: true, restauranteId: LOCAL })
    expect(s.registro.cajasDesactivadas).toEqual([LOCAL])
    expect(s.logs.some((l) => l.includes('otra cuenta'))).toBe(true)
  })

  test('reconectar la misma cuenta conserva las cajas', async () => {
    const s = montar({ repo: { conexion: { mpUserId: '555', conectado: false } }, respuestas: [json(tokensMp())] })
    const state = await estadoValido(s)
    await s.servicio.completar({ code: 'TG', state })
    expect(s.registro.cajasDesactivadas).toEqual([])
    expect(s.filas.get(LOCAL)?.conectado).toBe(true)
  })
})

describe('token vigente', () => {
  test('sin conexión, o con la conexión perdida, no hay token', async () => {
    expect(await montar({ repo: { conexion: null } }).servicio.obtenerToken(LOCAL)).toBeNull()
    expect(await montar({ repo: { conexion: { conectado: false } } }).servicio.obtenerToken(LOCAL)).toBeNull()
  })

  test('un token lejos de vencer se entrega tal cual, sin llamar a Mercado Pago', async () => {
    const s = montar()
    expect(await s.servicio.obtenerToken(LOCAL)).toBe('TOKEN-A')
    expect(s.llamadas).toHaveLength(0)
    expect(s.registro.renovaciones).toHaveLength(0)
  })

  test('a menos de 7 días del vencimiento se renueva antes de usarlo y se guarda el refresh token nuevo', async () => {
    const s = montar({ repo: { conexion: { expiraAt: new Date(T0.getTime() + 3 * DIA) } }, respuestas: [json(tokensMp())] })
    expect(await s.servicio.obtenerToken(LOCAL)).toBe('TOKEN-B')
    expect(s.llamadas[0].cuerpo).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'TG-A', client_id: config.clientId })
    expect(s.filas.get(LOCAL)).toMatchObject({ accessToken: 'TOKEN-B', refreshToken: 'TG-B' })
    // La renovación se pide indicando qué token se estaba usando.
    expect(s.registro.renovaciones).toEqual(['TOKEN-A'])
  })

  test('si la renovación falla pero el token todavía no venció, se sigue con el actual', async () => {
    const s = montar({ repo: { conexion: { expiraAt: new Date(T0.getTime() + 3 * DIA) } }, respuestas: [new Error('sin red')] })
    expect(await s.servicio.obtenerToken(LOCAL)).toBe('TOKEN-A')
  })

  test('vencido y sin poder renovar, no hay token (hay que reconectar)', async () => {
    const s = montar({ repo: { conexion: { expiraAt: new Date(T0.getTime() - DIA) } }, respuestas: [json({ error: 'invalid_grant' }, 400)] })
    expect(await s.servicio.obtenerToken(LOCAL)).toBeNull()
    expect(s.filas.get(LOCAL)?.conectado).toBe(false)
  })

  test('sin refresh token no intenta renovar', async () => {
    const s = montar({ repo: { conexion: { refreshToken: null, expiraAt: new Date(T0.getTime() + DIA) } } })
    expect(await s.servicio.obtenerToken(LOCAL)).toBe('TOKEN-A')
    expect(s.llamadas).toHaveLength(0)
  })
})

describe('renovar tras un 401 y desconectar', () => {
  test('renueva con el refresh token del local y devuelve el token nuevo', async () => {
    const s = montar({ respuestas: [json(tokensMp())] })
    expect(await s.servicio.refrescar(LOCAL, 'TOKEN-A')).toBe('TOKEN-B')
  })

  test('si otro proceso ya lo renovó, devuelve ése sin gastar el refresh token', async () => {
    const s = montar({ repo: { conexion: { accessToken: 'TOKEN-YA-RENOVADO' } } })
    expect(await s.servicio.refrescar(LOCAL, 'TOKEN-VIEJO')).toBe('TOKEN-YA-RENOVADO')
    expect(s.llamadas).toHaveLength(0)
  })

  test('sin la aplicación configurada no renueva', async () => {
    const s = montar({ config: null })
    expect(await s.servicio.refrescar(LOCAL, 'TOKEN-A')).toBeNull()
  })

  test('un fallo inesperado del repositorio no tumba el cobro: se informa y devuelve null', async () => {
    const r = repoFalso()
    r.repo.renovar = async () => { throw new Error('deadlock') }
    const logs: string[] = []
    const servicio = crearServicioConexionQr({ repo: r.repo, config: () => config, ahora: () => T0, log: (m) => { logs.push(m) } })
    expect(await servicio.refrescar(LOCAL, 'TOKEN-A')).toBeNull()
    expect(logs).toHaveLength(1)
  })

  test('el estado refleja si hay conexión y de qué cuenta', async () => {
    expect(await montar().servicio.estado(LOCAL)).toEqual({ conectado: true, mpUserId: '555' })
    expect(await montar({ repo: { conexion: { conectado: false } } }).servicio.estado(LOCAL)).toEqual({ conectado: false, mpUserId: null })
    expect(await montar({ repo: { conexion: null } }).servicio.estado(LOCAL)).toEqual({ conectado: false, mpUserId: null })
  })

  test('desconectar borra la conexión del local', async () => {
    const s = montar()
    await s.servicio.desconectar(LOCAL)
    expect(s.registro.desconexiones).toEqual([LOCAL])
    expect(await s.servicio.obtenerToken(LOCAL)).toBeNull()
  })
})
