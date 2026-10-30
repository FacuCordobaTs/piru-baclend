import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import * as jwt from 'jsonwebtoken'
import { createAuthMiddleware } from '../middleware/auth'
import { createSitiosRoute } from './sitios'
import { sitioTienda } from '../db/schema'

const secreto = process.env.JWT_SECRET || 'fallback-secret'
const firmar = (payload: object, opciones?: jwt.SignOptions) => jwt.sign(payload, secreto, opciones)

/** Base mínima: el local 42 existe (auth y canje del pase sólo leen `restaurante`). */
const db: any = {
  select: () => {
    const q: any = { from: () => q, where: () => q, innerJoin: () => q, limit: async () => [{ id: 42, email: null, nombre: 'Bronx', origen: null, claimedAt: null, telefonoVerificado: true, rapiboyToken: null }] }
    return q
  },
  insert: () => ({ values: async () => {} }),
}

function app() {
  const auth = createAuthMiddleware(() => db)
  const a = new Hono()
    .route('/api/sitios', createSitiosRoute({ getDb: () => db, auth }))
    .use('/api/restaurante/*', auth)
    .get('/api/restaurante/profile', (c) => c.json({ ok: true }))
  return (path: string, method = 'GET', token?: string) =>
    a.request(path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} })
}

describe('entrada a Páginas desde el panel', () => {
  test('el panel recibe un pase de dos minutos sin id, que se canjea por una sesión de Páginas', async () => {
    const pedir = app()
    const res = await pedir('/api/sitios/entrada', 'POST', firmar({ id: 42 }))
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.url).toStartWith('https://pages.piru.app/entrar#token=')
    const pase = decodeURIComponent(data.url.split('#token=')[1])
    const decodificado = jwt.verify(pase, secreto) as jwt.JwtPayload
    expect(decodificado).toMatchObject({ scope: 'entrada-sitios', restauranteId: 42 })
    expect(decodificado.id).toBeUndefined()
    expect(decodificado.exp! - decodificado.iat!).toBe(120)

    // El pase no sirve como token de local.
    expect((await pedir('/api/restaurante/profile', 'GET', pase)).status).toBe(401)

    const sesion = await pedir('/api/sitios/sesion', 'POST', pase)
    expect(sesion.status).toBe(200)
    const { token } = await sesion.json()
    expect(jwt.verify(token, secreto)).toMatchObject({ id: 42, scope: 'restaurante', appSitios: true })

    // La sesión de Páginas no alcanza el resto del panel ni emite pases nuevos.
    const perfil = await pedir('/api/restaurante/profile', 'GET', token)
    expect(perfil.status).toBe(403)
    expect((await perfil.json()).code).toBe('sitios_sin_permiso')
    expect((await pedir('/api/sitios/entrada', 'POST', token)).status).toBe(403)
  })

  test('un pase vencido, adulterado o de otra app no abre sesión', async () => {
    const pedir = app()
    for (const pase of [
      firmar({ scope: 'entrada-sitios', restauranteId: 42 }, { expiresIn: -10 }),
      jwt.sign({ scope: 'entrada-sitios', restauranteId: 42 }, 'otro-secreto'),
      firmar({ scope: 'entrada-app-marketing', restauranteId: 42 }),
      firmar({ id: 42 }),
    ])
      expect((await pedir('/api/sitios/sesion', 'POST', pase)).status).toBe(401)
  })

  test('la demo, el marketer y la app de marketing no pueden entrar a Páginas', async () => {
    const pedir = app()
    expect((await pedir('/api/sitios/entrada', 'POST', firmar({ id: 42, scope: 'restaurante', demo: true }))).status).toBe(403)
    expect((await pedir('/api/sitios', 'GET', firmar({ id: 42, scope: 'restaurante', demo: true }))).status).toBe(403)
    expect((await pedir('/api/sitios', 'GET', firmar({ id: 42, scope: 'restaurante', appMarketing: true }))).status).toBe(403)
    // Un token de Páginas con marcas mezcladas es inválido.
    expect((await pedir('/api/sitios', 'GET', firmar({ id: 42, scope: 'restaurante', appSitios: true, demo: true }))).status).toBe(401)
  })
})

describe('empezar de cero', () => {
  const sitio = {
    id: 7,
    restauranteId: 42,
    slug: 'bronx',
    username: 'bronx',
    nombre: 'Bronx',
    estado: 'activo',
    meta: {},
    borrador: { 'page.tsx': '// código viejo' },
    borradorActualizadoAt: new Date('2026-10-01T12:00:00Z'),
    versionPublicadaId: null,
  }

  /** Base mínima: `sitioPropio` lee `sitio_tienda`; las demás consultas devuelven el local 42. */
  function dbReinicio(alGuardar: (valores: any) => void): any {
    const local = {
      id: 42,
      nombre: 'Bronx',
      username: 'bronx',
      tienda: null,
      colorPrimario: null,
      colorSecundario: null,
      usarColorUnico: false,
      imagenUrl: null,
      imagenLightUrl: null,
    }
    const cadena = () => {
      const q: any = { tabla: null }
      q.from = (tabla: unknown) => {
        q.tabla = tabla
        return q
      }
      q.where = () => q
      q.limit = async () => [q.tabla === sitioTienda ? sitio : local]
      return q
    }
    return {
      select: () => cadena(),
      update: () => ({ set: (valores: any) => ({ where: async () => alGuardar(valores) }) }),
    }
  }

  test('reiniciar vuelve el borrador a la plantilla inicial con el contenido elegido', async () => {
    let guardado: any = null
    const db = dbReinicio((valores) => {
      guardado = valores
    })
    const a = new Hono().route('/api/sitios', createSitiosRoute({ getDb: () => db, auth: createAuthMiddleware(() => db) }))
    const res = await a.request('/api/sitios/7/reiniciar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${firmar({ id: 42, scope: 'restaurante', appSitios: true })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contenido: { plantilla: 'moderna', marca: { colorPrimario: '#112233', colorSecundario: '#ffffff', usarColorUnico: true } },
      }),
    })
    expect(res.status).toBe(200)
    const { borrador, borradorActualizadoAt } = await res.json()
    expect(Object.keys(borrador).sort()).toEqual([
      'components/Checkout.tsx',
      'components/DetalleProducto.tsx',
      'components/detalle.css',
      'contenido.ts',
      'page.tsx',
      'style.css',
    ])
    expect(borrador['contenido.ts']).toContain('"plantilla": "moderna"')
    expect(borrador['contenido.ts']).toContain('#112233')
    // El reemplazo es el borrador: la versión publicada no se toca.
    expect(guardado.borrador).toEqual(borrador)
    expect(guardado.borradorActualizadoPor).toBe(42)
    expect(guardado.borradorActualizadoAt.toISOString()).toBe(borradorActualizadoAt)
  })

  test('reiniciar un sitio ajeno o inexistente es 404', async () => {
    const db = dbReinicio(() => {})
    db.select = () => {
      const q: any = { tabla: null }
      q.from = (tabla: unknown) => {
        q.tabla = tabla
        return q
      }
      q.where = () => q
      // Sin fila de `sitio_tienda`, pero el local de la sesión sigue existiendo.
      q.limit = async () => (q.tabla === sitioTienda ? [] : [{ id: 42, email: null, nombre: 'Bronx', origen: null, claimedAt: null, telefonoVerificado: true, rapiboyToken: null }])
      return q
    }
    const a = new Hono().route('/api/sitios', createSitiosRoute({ getDb: () => db, auth: createAuthMiddleware(() => db) }))
    const res = await a.request('/api/sitios/9/reiniciar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${firmar({ id: 42, scope: 'restaurante', appSitios: true })}` },
    })
    expect(res.status).toBe(404)
  })
})
