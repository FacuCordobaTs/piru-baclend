import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { getTableName } from 'drizzle-orm'
import * as jwt from 'jsonwebtoken'

type Actualizacion = Record<string, any>

function crearLocal(extra: Record<string, any> = {}) {
  return {
    id: 7,
    metodosPagoConfig: null,
    cardsPaymentsEnabled: null,
    mpConnected: false,
    mpPublicKey: null,
    cucuruConfigurado: false,
    cucuruEnabled: null,
    proveedorPago: null,
    taloClientId: null,
    taloClientSecret: null,
    taloUserId: null,
    transferenciaAlias: null,
    ...extra,
  }
}

let local = crearLocal()
let actualizaciones: Actualizacion[] = []

const dbFalsa = {
  select: (campos?: Record<string, any>) => {
    let tabla = ''
    const q: any = new Proxy({}, {
      get: (_t, metodo) => {
        if (metodo === 'then') {
          return (ok: any, err: any) => {
            const filas = tabla === 'restaurante' ? [local] : []
            const proyectadas = campos
              ? filas.map((f: any) => Object.fromEntries(
                Object.entries(campos).map(([clave, columna]: any) => [
                  clave,
                  f[columna.name] ?? f[clave] ?? null,
                ]),
              ))
              : filas
            return Promise.resolve(proyectadas).then(ok, err)
          }
        }
        return (...args: any[]) => {
          if (metodo === 'from') tabla = getTableName(args[0])
          return q
        }
      },
    })
    return q
  },
  update: () => {
    const q: any = new Proxy({}, {
      get: (_t, metodo) => {
        if (metodo === 'then') return (ok: any, err: any) => Promise.resolve([]).then(ok, err)
        return (...args: any[]) => {
          if (metodo === 'set') {
            actualizaciones.push(args[0])
            Object.assign(local, args[0])
          }
          return q
        }
      },
    })
    return q
  },
}

const rutaDb = resolve(import.meta.dir, '../db')
const dbReal = await import(rutaDb)
const drizzleReal = await import('drizzle-orm/mysql2')
mock.module(rutaDb, () => ({ pool: {} }))
mock.module('drizzle-orm/mysql2', () => ({ drizzle: () => dbFalsa }))
afterAll(() => {
  mock.module(rutaDb, () => dbReal)
  mock.module('drizzle-orm/mysql2', () => drizzleReal)
})

const { Hono } = await import('hono')
const { restauranteRoute } = await import('./restaruante')
const app = new Hono().route('/api/restaurante', restauranteRoute)
const token = jwt.sign({ id: 7, scope: 'restaurante' }, process.env.JWT_SECRET || 'fallback-secret')

function guardar(body: Record<string, unknown>) {
  return app.request('/api/restaurante/metodos-pago', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  local = crearLocal()
  actualizaciones = []
})

test('guardar el alias de la transferencia manual no exige ningún módulo', async () => {
  const respuesta = await guardar({ transferenciaManual: true, transferenciaAlias: 'mi.alias' })

  expect(respuesta.status).toBe(200)
  expect(actualizaciones.at(-1)?.transferenciaAlias).toBe('mi.alias')
})

test('activar Mercado Pago sin el módulo responde 403 con el código del módulo', async () => {
  const respuesta = await guardar({ mercadopagoCheckout: true })

  expect(respuesta.status).toBe(403)
  const cuerpo = await respuesta.json() as Record<string, unknown>
  expect(cuerpo).toMatchObject({
    success: false,
    moduleRequired: true,
    module: 'mercadopago',
    message: 'Activá el módulo Mercado Pago para cobrar online',
  })
  expect(cuerpo.error).toBeUndefined()
})

test('desactivar Mercado Pago no exige el módulo', async () => {
  local = crearLocal({ metodosPagoConfig: { mercadopagoCheckout: true } })

  const respuesta = await guardar({ mercadopagoCheckout: false })

  expect(respuesta.status).toBe(200)
  expect(actualizaciones.at(-1)?.metodosPagoConfig).toMatchObject({ mercadopagoCheckout: false })
})
