import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'
import { createMarketingDuenioRoute } from './marketing-duenio'
import { createAuthMiddleware } from '../middleware/auth'
import { restaurante, restauranteMarketer } from '../db/schema'
import {
  AHORA_CARTERA,
  TARJETA_BRASA,
  datosCarteraEjemplo,
  dbCarteraFalsa,
  type DatosCarteraFalsa,
} from '../lib/marketer-cartera-db.fakes'

const secreto = process.env.JWT_SECRET || 'fallback-secret'
const firmar = (payload: object, opciones?: jwt.SignOptions) =>
  jwt.sign(payload, secreto, opciones)
const sesionApp = () =>
  firmar({ id: 6, scope: 'restaurante', appMarketing: true })

/** authMiddleware real contra una base mínima: el vínculo del marketer y el local existen. */
const dbAuth = {
  select: () => {
    let tabla: unknown
    const query: any = {
      from: (t: unknown) => {
        tabla = t
        return query
      },
      innerJoin: () => query,
      where: () => query,
      limit: async () =>
        tabla === restauranteMarketer
          ? [{ id: 1 }]
          : [{ id: 6, email: null, nombre: 'Brasa', rapiboyToken: null }],
    }
    return query
  },
  insert: () => ({ values: async () => {} }),
}

function caso(datos: DatosCarteraFalsa = datosCarteraEjemplo()) {
  const { db, consultas, columnas } = dbCarteraFalsa(datos)
  const app = new Hono().route(
    '/api/marketing-duenio',
    createMarketingDuenioRoute(
      () => db,
      createAuthMiddleware(() => dbAuth as any),
    ),
  )
  const pedir = (path: string, method: string, token?: string) =>
    app.request(`/api/marketing-duenio${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  const pase = async (token = firmar({ id: 6 })) => {
    const { data } = await (await pedir('/entrada', 'POST', token)).json()
    return decodeURIComponent(data.url.split('#token=')[1])
  }
  return { pedir, pase, consultas, columnas }
}

describe('el dueño entra a la app de marketers desde su panel', () => {
  afterEach(() => setSystemTime())

  test('el panel recibe un pase de dos minutos en el fragmento de la app', async () => {
    const res = await caso().pedir('/entrada', 'POST', firmar({ id: 6 }))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.url).toStartWith('https://marketing.piru.app/entrar#token=')
    const pase = jwt.verify(
      decodeURIComponent(data.url.split('#token=')[1]),
      secreto,
    ) as jwt.JwtPayload
    expect(pase).toMatchObject({
      scope: 'entrada-app-marketing',
      restauranteId: 6,
    })
    expect(pase.id).toBeUndefined()
    expect(pase.exp! - pase.iat!).toBe(120)
    expect(Date.parse(data.expira)).toBe(pase.exp! * 1000)
  })

  test('ni el marketer ni la sesión de la app emiten pases', async () => {
    const c = caso()
    expect(
      (
        await c.pedir(
          '/entrada',
          'POST',
          firmar({ id: 6, scope: 'restaurante', marketerId: 2 }),
        )
      ).status,
    ).toBe(403)
    expect((await c.pedir('/entrada', 'POST', sesionApp())).status).toBe(403)
    expect(
      (
        await c.pedir(
          '/entrada',
          'POST',
          firmar({ marketerId: 2, scope: 'marketer' }),
        )
      ).status,
    ).toBe(401)
  })

  test('el pase se canjea por una sesión de 12 horas limitada a la app', async () => {
    const c = caso()
    const res = await c.pedir('/sesion', 'POST', await c.pase())
    expect(res.status).toBe(200)
    const sesion = await res.json()
    expect(sesion.restauranteId).toBe(6)
    const payload = jwt.verify(sesion.token, secreto) as jwt.JwtPayload
    expect(payload).toMatchObject({
      id: 6,
      scope: 'restaurante',
      appMarketing: true,
    })
    expect(payload.marketerId).toBeUndefined()
    expect(payload.exp! - payload.iat!).toBeWithin(12 * 3600 - 1, 12 * 3600 + 1)
    expect(Date.parse(sesion.expira)).toBe(payload.exp! * 1000)
    // La sesión sirve para la app, no para el resto del panel.
    expect((await c.pedir('/local', 'GET', sesion.token)).status).toBe(200)
  })

  test('el pase no es un token de local y ninguna sesión se canjea como pase', async () => {
    const c = caso()
    expect((await c.pedir('/local', 'GET', await c.pase())).status).toBe(401)
    for (const token of [
      undefined,
      firmar({ id: 6 }),
      sesionApp(),
      firmar({ id: 6, scope: 'restaurante', marketerId: 2 }),
      firmar({ marketerId: 2, scope: 'marketer' }),
      jwt.sign({ scope: 'entrada-app-marketing', restauranteId: 6 }, 'otro'),
    ]) {
      const res = await c.pedir('/sesion', 'POST', token)
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ code: 'entrada_vencida' })
    }
  })

  test('un pase vencido o de un local que ya no existe no abre la app', async () => {
    const pase = firmar(
      { scope: 'entrada-app-marketing', restauranteId: 6 },
      { expiresIn: 120 },
    )
    setSystemTime(new Date(Date.now() + 3 * 60000))
    expect((await caso().pedir('/sesion', 'POST', pase)).status).toBe(401)
    setSystemTime()
    const sinLocal = caso({ ...datosCarteraEjemplo(), restaurantes: [] })
    expect(
      (await sinLocal.pedir('/sesion', 'POST', await sinLocal.pase())).status,
    ).toBe(401)
  })

  test('un acceso temporal de interno no se estira a 12 horas', async () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    const c = caso()
    const pase = await c.pase(
      firmar({ id: 6, scope: 'restaurante', accesoTemporalInterno: true, exp }),
    )
    const sesion = await (await c.pedir('/sesion', 'POST', pase)).json()
    expect((jwt.decode(sesion.token) as jwt.JwtPayload).exp).toBe(exp)
  })

  test('las sucursales del local salen con nombre y estado, nada más', async () => {
    const sucursales = [
      { id: 1, nombre: 'Centro', activo: true },
      { id: 2, nombre: 'Norte', activo: false },
    ]
    const c = caso({ ...datosCarteraEjemplo(), sucursales })
    const res = await c.pedir('/sucursales', 'GET', sesionApp())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(sucursales)
    expect(c.columnas.at(-1)).toEqual(['id', 'nombre', 'activo'])
    // El marketer no las ve: no están en su lista.
    expect(
      (
        await c.pedir(
          '/sucursales',
          'GET',
          firmar({ id: 6, scope: 'restaurante', marketerId: 2 }),
        )
      ).status,
    ).toBe(403)
  })

  test('el dueño ve la tarjeta que ve su marketer, sin vínculo ni comisión', async () => {
    setSystemTime(AHORA_CARTERA)
    const c = caso()
    const res = await c.pedir('/local', 'GET', sesionApp())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ...TARJETA_BRASA,
      desde: null,
      comisionEstimadaMensual: 0,
    })
    expect(c.consultas[0]).toBe(restaurante)
  })
})
