import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'
import { createMarketingLocalRoute } from './marketing-local'
import { createAuthMiddleware } from '../middleware/auth'
import { restaurante } from '../db/schema'
import {
  AHORA_LOCAL,
  TARJETA_BRASA,
  datosLocalEjemplo,
  dbLocalFalsa,
  type DatosLocalFalsos,
} from '../lib/marketing-local.fakes'

const secreto = process.env.JWT_SECRET || 'fallback-secret'
const firmar = (payload: object) => jwt.sign(payload, secreto)
const sesion = () => firmar({ id: 6, scope: 'restaurante' })

/** authMiddleware real contra una base mínima: el local existe. */
const dbAuth = {
  select: () => {
    const query: any = {
      from: () => query,
      where: () => query,
      limit: async () => [{ id: 6, email: null, nombre: 'Brasa', rapiboyToken: null }],
    }
    return query
  },
}

function caso(datos: DatosLocalFalsos = datosLocalEjemplo()) {
  const { db, consultas, columnas } = dbLocalFalsa(datos)
  const app = new Hono().route(
    '/api/marketing-local',
    createMarketingLocalRoute(() => db, createAuthMiddleware(() => dbAuth as any)),
  )
  const pedir = (path: string, token?: string) =>
    app.request(`/api/marketing-local${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  return { pedir, consultas, columnas }
}

describe('Marketing del panel lee la tarjeta y las sucursales del local', () => {
  afterEach(() => setSystemTime())

  test('sin sesión no responde', async () => {
    expect((await caso().pedir('')).status).toBe(401)
  })

  test('la tarjeta del local con ventas, módulos y día flojo', async () => {
    setSystemTime(AHORA_LOCAL)
    const c = caso()
    const res = await c.pedir('', sesion())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(TARJETA_BRASA)
    expect(c.consultas[0]).toBe(restaurante)
  })

  test('las sucursales salen con nombre y estado, nada más', async () => {
    const sucursales = [
      { id: 1, nombre: 'Centro', activo: true },
      { id: 2, nombre: 'Norte', activo: false },
    ]
    const c = caso({ ...datosLocalEjemplo(), sucursales })
    const res = await c.pedir('/sucursales', sesion())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(sucursales)
    expect(c.columnas.at(-1)).toEqual(['id', 'nombre', 'activo'])
  })
})
