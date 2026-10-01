import { describe, expect, test } from 'bun:test'
import type { MiddlewareHandler } from 'hono'
import { LOCAL, json, montar as montarConexion, tokensMp } from '../lib/mp-conexion-qr.fakes'
import { RESTAURANTE, montar } from '../lib/pos-cobros-qr.fakes'
import { crearMpQrCallbackRoute, crearPosQrRoute } from './pos-qr'

// Auth de prueba: fija el restaurante como lo hace `authMiddleware` (`c.user`).
const comoDueno = (id = RESTAURANTE): MiddlewareHandler => async (c, next) => {
  ;(c as any).user = { id }
  await next()
}
const sinPermiso: MiddlewareHandler = async (c) => c.json({ error: 'Authorization header required' }, 401)
const pasaPos: MiddlewareHandler = async (_c, next) => { await next() }

function app(
  opciones: Parameters<typeof montar>[0] = {},
  middlewares: { auth?: MiddlewareHandler; pos?: MiddlewareHandler } = {},
  conexionOpciones: Parameters<typeof montarConexion>[0] = {},
) {
  const s = montar(opciones)
  const conexion = montarConexion(conexionOpciones)
  const route = crearPosQrRoute({
    servicio: s.servicio,
    conexion: conexion.servicio,
    autenticacion: middlewares.auth ?? comoDueno(),
    posDelPedido: middlewares.pos ?? pasaPos,
  })
  const pedir = (ruta: string, init?: { metodo?: string; cuerpo?: unknown }) =>
    route.request(ruta, {
      method: init?.metodo ?? (init?.cuerpo === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json' },
      body: init?.cuerpo === undefined ? undefined : JSON.stringify(init.cuerpo),
    })
  return { ...s, conexion, pedir }
}

describe('POST /pedidos/:id/cobro', () => {
  test('crea el cobro con el total del pedido y responde el estado para el POS', async () => {
    const a = app()
    const res = await a.pedir('/pedidos/100/cobro', { cuerpo: { cajaId: 1 } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      success: true,
      data: { pedidoId: 100, cajaId: 1, cajaNombre: 'Caja 1', qrUrl: 'https://mp/qr1.png', monto: '1500.00', estado: 'creado' },
    })
    expect(a.mp.creadas).toHaveLength(1)
  })

  test('ignora montos o restaurantes que el cliente intente imponer en el cuerpo', async () => {
    const a = app({ pedidos: [{ id: 100, total: '999.00' }] })
    const res = await a.pedir('/pedidos/100/cobro', { cuerpo: { cajaId: 1, monto: '1.00', restauranteId: 999 } })
    expect(res.status).toBe(200)
    expect(a.mp.creadas[0].entrada.monto).toBe('999.00')
    expect(a.mp.creadas[0].restauranteId).toBe(RESTAURANTE)
  })

  test('un pedido de otro local se comporta como inexistente', async () => {
    const a = app({ pedidos: [{ id: 100, restauranteId: 999 }] })
    const res = await a.pedir('/pedidos/100/cobro', { cuerpo: { cajaId: 1 } })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ success: false, code: 'PEDIDO_NO_ENCONTRADO' })
    expect(a.mp.creadas).toHaveLength(0)
  })

  test('valida el cuerpo antes de tocar nada', async () => {
    const a = app()
    for (const cuerpo of [{}, { cajaId: 'uno' }, { cajaId: 0 }, { cajaId: -3 }, { cajaId: 1.5 }]) {
      expect((await a.pedir('/pedidos/100/cobro', { cuerpo })).status).toBe(400)
    }
    expect((await a.pedir('/pedidos/abc/cobro', { cuerpo: { cajaId: 1 } })).status).toBe(404)
    expect(a.mp.creadas).toHaveLength(0)
  })

  test('sin el módulo Mercado Pago responde el mismo contrato que requireModulo', async () => {
    const a = app({ conexion: { moduloActivo: false } })
    const res = await a.pedir('/pedidos/100/cobro', { cuerpo: { cajaId: 1 } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ success: false, moduleRequired: true, module: 'mercadopago', upgradeRequired: true, code: 'MODULO_MP_INACTIVO' })
  })

  test('caja ocupada: 409 con el pedido que la ocupa', async () => {
    const a = app({ pedidos: [{ id: 100 }, { id: 101 }] })
    await a.pedir('/pedidos/100/cobro', { cuerpo: { cajaId: 1 } })
    const res = await a.pedir('/pedidos/101/cobro', { cuerpo: { cajaId: 1 } })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, code: 'CAJA_OCUPADA', data: { pedidoId: 100 } })
  })

  test('los errores reintentables de Mercado Pago lo avisan al POS', async () => {
    const a = app()
    const { MpError } = await import('../lib/mp-qr')
    a.mp.cfg.falloCrear = new MpError('sin red', { red: true })
    const res = await a.pedir('/pedidos/100/cobro', { cuerpo: { cajaId: 1 } })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ success: false, code: 'MP_ERROR', reintentable: true })
  })

  test('respeta el gate del POS sobre el pedido', async () => {
    const rechazo: MiddlewareHandler = async (c) => c.json({ success: false, moduleRequired: true, module: 'pos' }, 403)
    const a = app({}, { pos: rechazo })
    expect((await a.pedir('/pedidos/100/cobro', { cuerpo: { cajaId: 1 } })).status).toBe(403)
    expect((await a.pedir('/pedidos/100/cobro')).status).toBe(403)
    expect((await a.pedir('/pedidos/100/cobro/cancelar', { cuerpo: {} })).status).toBe(403)
    expect(a.mp.creadas).toHaveLength(0)
  })
})

describe('GET /pedidos/:id/cobro', () => {
  test('sin cobro devuelve data null', async () => {
    const res = await app().pedir('/pedidos/100/cobro')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: null })
  })

  test('consulta a Mercado Pago y acredita el pedido cuando el cliente pagó', async () => {
    const a = app()
    await a.pedir('/pedidos/100/cobro', { cuerpo: { cajaId: 1 } })
    expect(await (await a.pedir('/pedidos/100/cobro')).json()).toMatchObject({ data: { estado: 'creado' } })
    a.mp.pagar('ORD1')
    const res = await a.pedir('/pedidos/100/cobro')
    expect(await res.json()).toMatchObject({ success: true, data: { estado: 'pagado', monto: '1500.00' } })
    expect(a.pedidos.get(100)!.pagado).toBe(true)
    expect(a.efectosPagados).toEqual([100])
  })

  test('no revela cobros de otros locales', async () => {
    const a = app()
    await a.pedir('/pedidos/100/cobro', { cuerpo: { cajaId: 1 } })
    const otro = crearPosQrRoute({ servicio: a.servicio, conexion: a.conexion.servicio, autenticacion: comoDueno(999), posDelPedido: pasaPos })
    const res = await otro.request('/pedidos/100/cobro')
    expect(await res.json()).toEqual({ success: true, data: null })
  })
})

describe('POST /pedidos/:id/cobro/cancelar', () => {
  test('cancela el cobro y el pedido impago', async () => {
    const a = app()
    await a.pedir('/pedidos/100/cobro', { cuerpo: { cajaId: 1 } })
    const res = await a.pedir('/pedidos/100/cobro/cancelar', { cuerpo: { cancelarPedido: true } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: { pedidoCancelado: true, cobro: { estado: 'cancelado' } } })
    expect(a.pedidos.get(100)!.estado).toBe('cancelled')
  })

  test('cancelarPedido es opcional y por defecto no toca el pedido', async () => {
    const a = app()
    await a.pedir('/pedidos/100/cobro', { cuerpo: { cajaId: 1 } })
    const res = await a.pedir('/pedidos/100/cobro/cancelar', { cuerpo: {} })
    expect(await res.json()).toMatchObject({ data: { pedidoCancelado: false, cobro: { estado: 'cancelado' } } })
    expect(a.pedidos.get(100)!.estado).toBe('pending')
  })
})

describe('cajas', () => {
  test('el estado informa módulo, conexión y cajas', async () => {
    const res = await app().pedir('/estado')
    expect(await res.json()).toMatchObject({ success: true, data: { moduloMercadoPago: true, mpConectado: true, cajas: [{ id: 1, nombre: 'Caja 1' }] } })
  })

  test('vincula, crea y desvincula cajas con validación de entrada', async () => {
    const a = app({ cajas: [] })
    a.mp.cfg.cajasRemotas = [{ id: 'MP5', nombre: 'Feria', externalId: 'FERIA5', storeId: '10', externalStoreId: null, qrImagen: 'https://mp/f.png', qrPlantilla: null }]
    a.mp.cfg.tiendas = [{ id: '10', nombre: 'Stand', externalId: null, direccion: null }]

    expect((await a.pedir('/cajas', { cuerpo: {} })).status).toBe(400)
    const vinculada = await a.pedir('/cajas', { cuerpo: { mpPosId: 'MP5' } })
    expect(await vinculada.json()).toMatchObject({ success: true, data: { nombre: 'Feria', qrUrl: 'https://mp/f.png' } })

    expect((await a.pedir('/cajas/nueva', { cuerpo: { nombre: 'X', tiendaId: 'no-numerica' } })).status).toBe(400)
    expect((await a.pedir('/cajas/nueva', { cuerpo: { nombre: '', tiendaId: '10' } })).status).toBe(400)
    const noEsSuya = await a.pedir('/cajas/nueva', { cuerpo: { nombre: 'X', tiendaId: '999' } })
    expect(noEsSuya.status).toBe(422)
    expect(await noEsSuya.json()).toMatchObject({ code: 'TIENDA_INVALIDA' })

    const id = a.cajas[0].id
    expect((await a.pedir(`/cajas/${id}`, { metodo: 'DELETE' })).status).toBe(200)
    expect((await a.pedir(`/cajas/${id}`, { metodo: 'DELETE' })).status).toBe(404)
  })

  test('lista las cajas y tiendas de Mercado Pago', async () => {
    const a = app()
    a.mp.cfg.cajasRemotas = [{ id: 'MP1', nombre: 'Caja 1', externalId: 'PIRU7CAJA1', storeId: '10', externalStoreId: null, qrImagen: null, qrPlantilla: null }]
    a.mp.cfg.tiendas = [{ id: '10', nombre: 'Stand', externalId: null, direccion: 'Belgrano 10' }]
    expect(await (await a.pedir('/mp/cajas')).json()).toMatchObject({ success: true, data: [{ mpPosId: 'MP1', vinculada: true }] })
    expect(await (await a.pedir('/mp/tiendas')).json()).toEqual({ success: true, data: [{ id: '10', nombre: 'Stand', direccion: 'Belgrano 10' }] })
  })

  test('sin Mercado Pago conectado se pide conectar la cuenta', async () => {
    const a = app({ conexion: { conectado: false } })
    const res = await a.pedir('/mp/cajas')
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'MP_NO_CONECTADO' })
  })
})

describe('autenticación', () => {
  test('ninguna ruta responde sin dueño autenticado', async () => {
    const a = app({}, { auth: sinPermiso })
    const pedidos: Array<[string, { metodo?: string; cuerpo?: unknown }?]> = [
      ['/estado'], ['/mp/cajas'], ['/mp/tiendas'],
      ['/cajas', { cuerpo: { mpPosId: 'x' } }],
      ['/cajas/nueva', { cuerpo: { nombre: 'x', tiendaId: '1' } }],
      ['/cajas/1', { metodo: 'DELETE' }],
      ['/pedidos/100/cobro', { cuerpo: { cajaId: 1 } }],
      ['/pedidos/100/cobro'],
      ['/pedidos/100/cobro/cancelar', { cuerpo: {} }],
    ]
    for (const [ruta, init] of pedidos) expect((await a.pedir(ruta, init)).status).toBe(401)
    expect(a.mp.creadas).toHaveLength(0)
  })
})

describe('conexión con la aplicación de Mercado Pago para QR', () => {
  test('POST /conexion/iniciar devuelve la URL de autorización de la aplicación de QR con un state propio', async () => {
    const a = app()
    const res = await a.pedir('/conexion/iniciar', { metodo: 'POST' })
    expect(res.status).toBe(200)
    const { success, data } = await res.json() as { success: boolean; data: { url: string } }
    expect(success).toBe(true)
    const url = new URL(data.url)
    expect(url.hostname).toBe('auth.mercadopago.com.ar')
    expect(url.searchParams.get('client_id')).toBe('7364289770550796')
    expect(url.searchParams.get('state')).toMatch(new RegExp(`^${RESTAURANTE}\\.\\d+\\.[0-9a-f]+\\.[0-9a-f]{64}$`))
    expect(data.url).not.toContain('secreto-de-la-app')
  })

  test('sin la aplicación de QR configurada en el servidor responde 503 con un código estable', async () => {
    const a = app({}, {}, { config: null })
    const res = await a.pedir('/conexion/iniciar', { metodo: 'POST' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ success: false, code: 'APP_QR_NO_CONFIGURADA' })
  })

  test('sin el módulo Mercado Pago responde el mismo contrato que requireModulo', async () => {
    const a = app({}, {}, { repo: { modulo: false } })
    const res = await a.pedir('/conexion/iniciar', { metodo: 'POST' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ success: false, moduleRequired: true, module: 'mercadopago', upgradeRequired: true, code: 'MODULO_MP_INACTIVO' })
  })

  test('DELETE /conexion desconecta sólo el local autenticado', async () => {
    const a = app()
    const res = await a.pedir('/conexion', { metodo: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(a.conexion.registro.desconexiones).toEqual([RESTAURANTE])
  })

  test('las rutas de conexión exigen autenticación', async () => {
    const a = app({}, { auth: sinPermiso })
    expect((await a.pedir('/conexion/iniciar', { metodo: 'POST' })).status).toBe(401)
    expect((await a.pedir('/conexion', { metodo: 'DELETE' })).status).toBe(401)
    expect(a.conexion.registro.desconexiones).toHaveLength(0)
  })
})

describe('callback público del OAuth (GET /mp-qr/callback)', () => {
  const ADMIN = 'https://admin.example'
  async function montarCallback(opciones: Parameters<typeof montarConexion>[0] = {}) {
    const c = montarConexion({ repo: { conexion: null }, ...opciones })
    const route = crearMpQrCallbackRoute({ conexion: c.servicio, adminUrl: ADMIN })
    const iniciada = await c.servicio.iniciar(LOCAL)
    const state = iniciada.ok ? new URL(iniciada.data.url).searchParams.get('state')! : ''
    const volver = (consulta: string) => route.request(`/callback?${consulta}`, { redirect: 'manual' })
    return { ...c, state, volver }
  }

  test('con un state propio guarda la conexión y vuelve al admin con éxito', async () => {
    const c = await montarCallback({ respuestas: [json(tokensMp())] })
    const res = await c.volver(`code=TG-CODIGO&state=${encodeURIComponent(c.state)}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${ADMIN}/dashboard?mp_qr_status=success`)
    expect(c.registro.guardados).toHaveLength(1)
    expect(c.filas.get(LOCAL)).toMatchObject({ conectado: true, mpUserId: '555' })
  })

  test('un state que no emitió este servidor vuelve con error y no llega a Mercado Pago', async () => {
    const c = await montarCallback({ respuestas: [json(tokensMp())] })
    for (const state of ['42', `7${c.state.slice(2)}`, 'cualquier-cosa']) {
      const res = await c.volver(`code=TG-CODIGO&state=${encodeURIComponent(state)}`)
      expect(res.headers.get('location')).toBe(`${ADMIN}/dashboard?mp_qr_status=error&mp_qr_error=estado_invalido`)
    }
    expect(c.llamadas).toHaveLength(0)
    expect(c.registro.guardados).toHaveLength(0)
  })

  test('si el vendedor no autoriza o faltan parámetros, vuelve con el motivo', async () => {
    const c = await montarCallback()
    expect((await c.volver('error=access_denied')).headers.get('location')).toContain('mp_qr_error=denegado')
    expect((await c.volver('')).headers.get('location')).toContain('mp_qr_error=faltan_parametros')
  })

  test('si Mercado Pago rechaza el código vuelve con error y no guarda nada', async () => {
    const c = await montarCallback({ respuestas: [json({ error: 'invalid_grant', message: 'Invalid code' }, 400)] })
    const res = await c.volver(`code=MAL&state=${encodeURIComponent(c.state)}`)
    expect(res.headers.get('location')).toBe(`${ADMIN}/dashboard?mp_qr_status=error&mp_qr_error=oauth_fallido`)
    expect(c.registro.guardados).toHaveLength(0)
  })

  test('un fallo inesperado no deja la pantalla en blanco ni filtra datos: vuelve con error servidor', async () => {
    const c = await montarCallback({ respuestas: [json(tokensMp())] })
    c.repo.guardar = async () => { throw new Error('ER_LOCK_DEADLOCK con TOKEN-SECRETO') }
    const original = console.error
    const registrado: unknown[][] = []
    console.error = (...args: unknown[]) => { registrado.push(args) }
    try {
      const res = await c.volver(`code=TG&state=${encodeURIComponent(c.state)}`)
      expect(res.headers.get('location')).toBe(`${ADMIN}/dashboard?mp_qr_status=error&mp_qr_error=servidor`)
    } finally {
      console.error = original
    }
    expect(registrado).toHaveLength(1)
  })
})
