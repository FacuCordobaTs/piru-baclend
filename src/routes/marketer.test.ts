import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import * as jwt from 'jsonwebtoken'
import { createMarketerRoute } from './marketer'
import { hashActivacionMarketer } from '../lib/marketer-identidad'
import { marketer } from '../db/schema'
import {
  AHORA_CARTERA,
  TARJETA_BRASA,
  datosCarteraEjemplo,
  dbCarteraFalsa,
} from '../lib/marketer-cartera-db.fakes'

const TOKEN = 'activacion-segura-con-mas-de-32-caracteres'
function caso() {
  const row: any = {
    id: 2,
    nombre: 'Tommy',
    email: 'tommy@example.com',
    telefono: null,
    codigo: 'TOMMY',
    comisionPorcentaje: '20.00',
    datosCobro: 'alias.tommy',
    activo: true,
    passwordHash: null,
    activacionTokenHash: hashActivacionMarketer(TOKEN),
    activacionExpiraAt: new Date(Date.now() + 60000),
  }
  let consumido = false
  const db: any = {
    select: () => {
      const query: any = {
        from: () => query,
        where: () => query,
        limit: async () => (consumido ? [] : [{ ...row }]),
      }
      return query
    },
    update: (table: unknown) => ({
      set: (values: any) => ({
        where: async () => {
          expect(table).toBe(marketer)
          if (values.passwordHash) {
            if (consumido) return [{ affectedRows: 0 }]
            consumido = true
            Object.assign(row, values)
          }
          return [{ affectedRows: 1 }]
        },
      }),
    }),
  }
  const app = createMarketerRoute(() => db)
  const activar = (password = 'contraseña-segura') =>
    app.request('/activar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, password }),
    })
  return { activar, row }
}
describe('activación marketer', () => {
  test('consume el link atómicamente, entrega sólo el perfil seguro y una sesión específica', async () => {
    const c = caso()
    const respuestas = await Promise.all([c.activar(), c.activar()])
    expect(respuestas.map((r) => r.status).sort()).toEqual([200, 401])
    const body = await respuestas.find((r) => r.status === 200)!.json()
    expect(Object.keys(body.marketer).sort()).toEqual(
      [
        'codigo',
        'comisionPorcentaje',
        'datosCobro',
        'email',
        'id',
        'nombre',
        'telefono',
      ].sort(),
    )
    expect(body.marketer.comisionPorcentaje).toBe(20)
    expect(
      jwt.verify(body.token, process.env.JWT_SECRET || 'fallback-secret'),
    ).toMatchObject({ marketerId: 2, scope: 'marketer' })
    expect(c.row.activacionTokenHash).toBeNull()
    expect(c.row.activacionExpiraAt).toBeNull()
    expect(c.row.passwordHash).toStartWith('$2')
    expect((await c.activar()).status).toBe(401)
  })
  test('rechaza contraseñas cortas antes de escribir', async () => {
    const c = caso()
    expect((await c.activar('123')).status).toBe(400)
    expect(c.row.passwordHash).toBeNull()
  })
})

describe('cartera del marketer', () => {
  afterEach(() => setSystemTime())
  test('sólo campos seguros, ordenada por mensajes de hoy y con los revocados aparte', async () => {
    setSystemTime(AHORA_CARTERA)
    const { db } = dbCarteraFalsa(datosCarteraEjemplo())
    const app = createMarketerRoute(
      () => db,
      async (c, next) => {
        ;(c as any).marketer = { id: 2, comisionPorcentaje: '20.00', activo: true }
        await next()
      },
    )
    const res = await app.request('/locales')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      activos: [
        {
          restauranteId: 7,
          nombre: 'Local 7',
          username: null,
          imagenUrl: 'https://cdn.example/pizza.png',
          colorPrimario: null,
          baseTienda: 'https://pizza.example',
          desde: '2026-09-10T12:00:00.000Z',
          whatsappConectado: false,
          retencionActiva: false,
          crecimientoActivo: false,
          codigosDescuentoActivo: true,
          suscripcion: { estado: 'trial', montoMensual: 40000 },
          ventas30d: 2000,
          ventas30dAnterior: 0,
          pedidos30d: 1,
          ventasSemanales: [0, 0, 0, 0, 0, 0, 0, 2000],
          clientesNuevos30d: 1,
          diaMasFlojo: null,
          mensajesParaHoy: 3,
          comisionEstimadaMensual: 6000,
        },
        TARJETA_BRASA,
      ],
      revocados: [
        {
          restauranteId: 8,
          nombre: 'Vieja',
          imagenUrl: null,
          revocadoAt: '2026-09-20T12:00:00.000Z',
        },
      ],
    })
  })
})
