import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'
import { createDemoPanelRoute } from './demo-panel'
import { createMarketingDuenioRoute } from './marketing-duenio'
import { createAuthMiddleware } from '../middleware/auth'
import { DEMO_SESION_TTL_SEGUNDOS } from '../lib/demo-panel'

const secreto = process.env.JWT_SECRET || 'fallback-secret'
const firmar = (payload: object, opciones?: jwt.SignOptions) => jwt.sign(payload, secreto, opciones)

const PROSPECTO = {
  id: 6,
  nombre: 'Brasa',
  email: null,
  rapiboyToken: 'rb-secreto',
  origen: 'outbound',
  claimedAt: null,
  telefonoVerificado: false,
  completedOnboarding: true,
}

/** Una base que responde una sola fila para cualquier consulta de local. */
const dbDeLocal = (local: Record<string, unknown> | null) => ({
  select: () => {
    const query: any = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      limit: async () => (local ? [local] : []),
    }
    return query
  },
  insert: () => ({ values: async () => {} }),
})

function appDemo(
  local: Record<string, unknown> | null,
  asegurar = async () => null,
  registrar: () => Promise<void> = async () => {},
) {
  const llamadas: number[] = []
  const entradas: number[] = []
  const app = new Hono().route(
    '/api/demo-panel',
    createDemoPanelRoute(
      () => dbDeLocal(local) as never,
      (async (_db: unknown, id: number) => {
        llamadas.push(id)
        return asegurar()
      }) as never,
      (async (_db: unknown, id: number) => {
        entradas.push(id)
        return registrar()
      }) as never,
    ),
  )
  const entrar = (username: unknown, ip = '1.1.1.1') =>
    app.request('/api/demo-panel/sesion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ username }),
    })
  return { entrar, llamadas, entradas }
}

describe('la entrada al panel desde la demo de la tienda', () => {
  afterEach(() => setSystemTime())

  test('un prospecto sin reclamar entrega una sesión demo de 7 días y prepara los datos de ejemplo', async () => {
    setSystemTime(new Date('2026-10-13T12:00:00Z'))
    const { entrar, llamadas } = appDemo(PROSPECTO)
    const res = await entrar('brasa')
    expect(res.status).toBe(200)
    const cuerpo = await res.json()
    expect(cuerpo).toMatchObject({ success: true, restauranteId: 6, nombre: 'Brasa' })
    const sesion = jwt.verify(cuerpo.token, secreto) as jwt.JwtPayload
    expect(sesion).toMatchObject({ id: 6, scope: 'restaurante', demo: true })
    expect(sesion.exp! - sesion.iat!).toBe(DEMO_SESION_TTL_SEGUNDOS)
    expect(sesion.exp! - sesion.iat!).toBe(604800)
    expect(new Date(cuerpo.expira).getTime() / 1000).toBe(sesion.exp!)
    // No es una sesión de construcción ni un acceso de interno.
    expect(sesion.altaInterna).toBeUndefined()
    expect(sesion.accesoTemporalInterno).toBeUndefined()
    expect(llamadas).toEqual([6])
  })

  test('si el lote de datos falla igual se entra al panel', async () => {
    const { entrar } = appDemo(PROSPECTO, async () => {
      throw new Error('sin tabla')
    })
    const res = await entrar('brasa')
    expect(res.status).toBe(200)
    expect((await res.json()).token).toBeTruthy()
  })

  test('anota cada entrada al panel; si no se puede anotar igual se entra', async () => {
    const { entrar, entradas } = appDemo(PROSPECTO)
    expect((await entrar('brasa')).status).toBe(200)
    expect((await entrar('brasa')).status).toBe(200)
    expect(entradas).toEqual([6, 6])

    const falla = appDemo(PROSPECTO, async () => null, async () => {
      throw new Error('sin tabla')
    })
    const res = await falla.entrar('brasa')
    expect(res.status).toBe(200)
    expect((await res.json()).token).toBeTruthy()
  })

  test('una entrada que no se concede no deja marca', async () => {
    for (const local of [
      { ...PROSPECTO, claimedAt: new Date() },
      { ...PROSPECTO, completedOnboarding: false },
      null,
    ]) {
      const { entrar, entradas } = appDemo(local)
      await entrar('brasa')
      expect(entradas).toEqual([])
    }
  })

  test('una tienda ya reclamada o verificada no se abre: se entra con la cuenta', async () => {
    for (const local of [
      { ...PROSPECTO, claimedAt: new Date() },
      { ...PROSPECTO, telefonoVerificado: true },
      { ...PROSPECTO, origen: 'self_serve' },
    ]) {
      const { entrar, llamadas } = appDemo(local)
      const res = await entrar('brasa')
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('demo_cerrada')
      expect(llamadas).toEqual([])
    }
  })

  test('una tienda que todavía se está armando no se muestra', async () => {
    const res = await appDemo({ ...PROSPECTO, completedOnboarding: false }).entrar('brasa')
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('en_construccion')
  })

  test('un local que no existe y un alias raro responden igual: no encontrada', async () => {
    const sinLocal = appDemo(null)
    const a = await sinLocal.entrar('nadie')
    expect(a.status).toBe(404)
    expect((await a.json()).code).toBe('tienda_no_encontrada')
    const conLocal = appDemo(PROSPECTO)
    const b = await conLocal.entrar("brasa'; drop table restaurante;--")
    expect(b.status).toBe(404)
    expect(conLocal.llamadas).toEqual([])
    expect((await conLocal.entrar('')).status).toBe(400)
  })

  test('limita los intentos por IP', async () => {
    const { entrar } = appDemo(PROSPECTO)
    let ultimo = 200
    for (let i = 0; i < 61; i++) ultimo = (await entrar('brasa', '9.9.9.9')).status
    expect(ultimo).toBe(429)
    // Otra IP no queda afectada.
    expect((await entrar('brasa', '8.8.8.8')).status).toBe(200)
  })
})

describe('la sesión demo en el resto de la API', () => {
  const sesionDemo = (extra: object = {}) => firmar({ id: 6, scope: 'restaurante', demo: true, ...extra }, { expiresIn: 3600 })

  function appApi(local: Record<string, unknown> | null) {
    const auth = createAuthMiddleware(() => dbDeLocal(local) as never)
    return new Hono()
      .use('/api/*', auth)
      .get('/api/restaurante/profile', (c) =>
        c.json({
          success: true,
          data: {
            restaurante: {
              id: 6,
              nombre: 'Brasa',
              password: '$2b$10$hash',
              claimToken: 'token-de-reclamo',
              mpAccessToken: 'APP_USR-x',
              mpConnected: true,
            },
          },
        }),
      )
      .put('/api/restaurante/update', (c) => c.json({ success: true }))
      .put('/api/pedido-unificado/:id/estado', (c) => c.json({ success: true }))
      .get('/api/otro', (c) => c.text('texto plano'))
  }
  const pedir = (app: Hono, metodo: string, ruta: string, token: string) =>
    app.request(ruta, { method: metodo, headers: { Authorization: `Bearer ${token}` } })

  test('lee el panel, pero la respuesta no lleva credenciales ni el token de reclamo', async () => {
    const res = await pedir(appApi(PROSPECTO), 'GET', '/api/restaurante/profile', sesionDemo())
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.restaurante).toMatchObject({
      id: 6,
      nombre: 'Brasa',
      password: null,
      claimToken: null,
      mpAccessToken: null,
      mpConnected: true,
    })
  })

  test('opera pedidos, pero no cambia lo que redirige pedidos o plata', async () => {
    const app = appApi(PROSPECTO)
    expect((await pedir(app, 'PUT', '/api/pedido-unificado/4/estado', sesionDemo())).status).toBe(200)
    const prohibido = await pedir(app, 'PUT', '/api/restaurante/update', sesionDemo())
    expect(prohibido.status).toBe(403)
    expect((await prohibido.json()).code).toBe('demo_sin_permiso')
  })

  test('cuando el dueño reclama la tienda, las sesiones demo abiertas dejan de servir', async () => {
    const reclamada = appApi({ ...PROSPECTO, claimedAt: new Date() })
    const res = await pedir(reclamada, 'GET', '/api/restaurante/profile', sesionDemo())
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('demo_vencida')
    const verificada = appApi({ ...PROSPECTO, telefonoVerificado: true })
    expect((await pedir(verificada, 'GET', '/api/restaurante/profile', sesionDemo())).status).toBe(401)
  })

  test('la marca demo no se combina con un acceso de interno ni de marketer', async () => {
    const app = appApi(PROSPECTO)
    for (const extra of [{ altaInterna: true }, { accesoTemporalInterno: true }, { marketerId: 3 }, { demo: 'si' }]) {
      const res = await pedir(app, 'GET', '/api/restaurante/profile', sesionDemo(extra))
      expect(res.status, JSON.stringify(extra)).toBe(401)
    }
  })

  test('no deja de lado el resto de las sesiones: la del dueño ve todo como siempre', async () => {
    const app = appApi({ ...PROSPECTO, claimedAt: new Date() })
    const dueno = firmar({ id: 6 }, { expiresIn: 3600 })
    const res = await pedir(app, 'GET', '/api/restaurante/profile', dueno)
    expect(res.status).toBe(200)
    expect((await res.json()).data.restaurante.password).toBe('$2b$10$hash')
    expect((await pedir(app, 'PUT', '/api/restaurante/update', dueno)).status).toBe(200)
  })

  test('las respuestas que no son JSON pasan intactas', async () => {
    const res = await pedir(appApi(PROSPECTO), 'GET', '/api/otro', sesionDemo())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('texto plano')
  })
})

describe('la demo dentro de la app de marketing', () => {
  const auth = (local: Record<string, unknown> | null) => createAuthMiddleware(() => dbDeLocal(local) as never)
  const rutas = (local: Record<string, unknown> | null) =>
    new Hono().route(
      '/api/marketing-duenio',
      createMarketingDuenioRoute(() => dbDeLocal(local) as never, auth(local)),
    )
  const post = (app: Hono, ruta: string, token?: string) =>
    app.request(`/api/marketing-duenio${ruta}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  const paseDe = async (app: Hono, token: string) => {
    const { data } = await (await post(app, '/entrada', token)).json()
    return decodeURIComponent(data.url.split('#token=')[1])
  }

  test('el pase hereda la marca demo y su vencimiento, y la sesión de la app sigue limitada', async () => {
    const app = rutas(PROSPECTO)
    const sesionDemo = firmar({ id: 6, scope: 'restaurante', demo: true }, { expiresIn: 600 })
    const pase = jwt.verify(await paseDe(app, sesionDemo), secreto) as jwt.JwtPayload
    expect(pase).toMatchObject({ scope: 'entrada-app-marketing', restauranteId: 6, demo: true })
    expect(pase.hasta).toBe((jwt.decode(sesionDemo) as jwt.JwtPayload).exp)

    const res = await post(app, '/sesion', await paseDe(app, sesionDemo))
    expect(res.status).toBe(200)
    const { token } = await res.json()
    expect(jwt.verify(token, secreto)).toMatchObject({ id: 6, scope: 'restaurante', appMarketing: true, demo: true })
  })

  test('un pase de la demo no se canjea si la tienda ya fue reclamada', async () => {
    const sesionDemo = firmar({ id: 6, scope: 'restaurante', demo: true }, { expiresIn: 600 })
    const pase = await paseDe(rutas(PROSPECTO), sesionDemo)
    const res = await post(rutas({ ...PROSPECTO, claimedAt: new Date() }), '/sesion', pase)
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('entrada_vencida')
  })

  test('el dueño de verdad sigue entrando como antes, sin marca demo', async () => {
    const app = rutas({ ...PROSPECTO, claimedAt: new Date() })
    const dueno = firmar({ id: 6 }, { expiresIn: 600 })
    const pase = jwt.verify(await paseDe(app, dueno), secreto) as jwt.JwtPayload
    expect(pase.demo).toBeUndefined()
    const res = await post(app, '/sesion', await paseDe(app, dueno))
    expect(res.status).toBe(200)
    expect(jwt.verify((await res.json()).token, secreto)).not.toHaveProperty('demo')
  })
})
