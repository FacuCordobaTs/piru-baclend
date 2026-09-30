import { describe, expect, test } from 'bun:test'
import { MpError } from './mp-qr'
import { RESTAURANTE, T0, montar } from './pos-cobros-qr.fakes'

const iniciar = (s: ReturnType<typeof montar>, pedidoId = 100, cajaId = 1) => s.servicio.iniciarCobro({ restauranteId: RESTAURANTE, pedidoId, cajaId })

describe('iniciar el cobro', () => {
  test('crea la orden con el total del pedido, la referencia del cobro y la caja elegida', async () => {
    const s = montar()
    const r = await iniciar(s)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('inesperado')
    expect(r.data).toMatchObject({ pedidoId: 100, cajaId: 1, cajaNombre: 'Caja 1', qrUrl: 'https://mp/qr1.png', monto: '1500.00', estado: 'creado', mpStatus: 'created' })
    expect(r.data.expiraAt).toBe(new Date(T0.getTime() + 10 * 60_000).toISOString())
    expect(s.mp.creadas).toHaveLength(1)
    expect(s.mp.creadas[0].entrada).toMatchObject({ monto: '1500.00', externalPosId: 'PIRU7CAJA1', descripcion: 'Pedido #100' })
    expect(s.mp.creadas[0].entrada.referencia).toBe(s.cobros[0].externalReference)
    expect(s.cobros[0].mpOrderId).toBe('ORD1')
  })

  test('es idempotente: repetir la llamada retoma el mismo cobro sin crear otra orden', async () => {
    const s = montar()
    await iniciar(s)
    const segunda = await iniciar(s)
    expect(segunda.ok).toBe(true)
    expect(s.mp.creadas).toHaveLength(1)
    expect(s.cobros).toHaveLength(1)
  })

  test('el monto sale de la base: el cliente no puede imponerlo', async () => {
    const s = montar({ pedidos: [{ id: 100, total: '2340.50' }] })
    await iniciar(s)
    expect(s.mp.creadas[0].entrada.monto).toBe('2340.50')
  })

  test('sin módulo, sin conexión, caja inválida o pedido ajeno se rechaza antes de tocar Mercado Pago', async () => {
    const sinModulo = montar({ conexion: { moduloActivo: false } })
    expect(await iniciar(sinModulo)).toMatchObject({ ok: false, codigo: 'MODULO_MP_INACTIVO', status: 403 })
    const sinConexion = montar({ conexion: { conectado: false } })
    expect(await iniciar(sinConexion)).toMatchObject({ ok: false, codigo: 'MP_NO_CONECTADO', status: 409 })
    const sinCaja = montar()
    expect(await iniciar(sinCaja, 100, 99)).toMatchObject({ ok: false, codigo: 'CAJA_NO_ENCONTRADA', status: 404 })
    const cajaInactiva = montar({ cajas: [{ id: 1, activo: false }] })
    expect(await iniciar(cajaInactiva)).toMatchObject({ ok: false, codigo: 'CAJA_NO_ENCONTRADA' })
    const otroTenant = montar({ pedidos: [{ id: 100, restauranteId: 999 }] })
    expect(await iniciar(otroTenant)).toMatchObject({ ok: false, codigo: 'PEDIDO_NO_ENCONTRADO', status: 404 })
    for (const s of [sinModulo, sinConexion, sinCaja, cajaInactiva, otroTenant]) expect(s.mp.creadas).toHaveLength(0)
  })

  test('no cobra pedidos pagados, cerrados ni sin importe', async () => {
    expect(await iniciar(montar({ pedidos: [{ id: 100, pagado: true }] }))).toMatchObject({ ok: false, codigo: 'PEDIDO_YA_PAGADO' })
    for (const estado of ['cancelled', 'archived', 'delivered']) {
      expect(await iniciar(montar({ pedidos: [{ id: 100, estado }] }))).toMatchObject({ ok: false, codigo: 'PEDIDO_NO_COBRABLE' })
    }
    expect(await iniciar(montar({ pedidos: [{ id: 100, total: '0.00' }] }))).toMatchObject({ ok: false, codigo: 'MONTO_INVALIDO', status: 422 })
  })
})

describe('caja con un solo cobro pendiente', () => {
  test('si otro pedido la ocupa, informa cuál', async () => {
    const s = montar({ pedidos: [{ id: 100 }, { id: 101 }] })
    await iniciar(s, 100)
    const r = await iniciar(s, 101)
    expect(r).toMatchObject({ ok: false, codigo: 'CAJA_OCUPADA', status: 409, datos: { pedidoId: 100 } })
    expect(s.mp.creadas).toHaveLength(1)
  })

  test('si quien la ocupaba ya pagó en Mercado Pago, se acredita y la caja queda libre', async () => {
    const s = montar({ pedidos: [{ id: 100 }, { id: 101 }] })
    await iniciar(s, 100)
    s.mp.pagar('ORD1')
    const r = await iniciar(s, 101)
    expect(r.ok).toBe(true)
    expect(s.pedidos.get(100)!.pagado).toBe(true)
    expect(s.efectosPagados).toEqual([100])
    expect(s.mp.creadas).toHaveLength(2)
  })

  test('si la orden anterior venció en Mercado Pago, la caja se libera', async () => {
    const s = montar({ pedidos: [{ id: 100 }, { id: 101 }] })
    await iniciar(s, 100)
    s.mp.mutar('ORD1', { status: 'expired' })
    expect((await iniciar(s, 101)).ok).toBe(true)
    expect(s.cobros[0].estado).toBe('vencido')
  })

  test('el mismo pedido no puede tener cobros activos en dos cajas', async () => {
    const s = montar({ cajas: [{ id: 1 }, { id: 2 }] })
    await iniciar(s, 100, 1)
    const r = await iniciar(s, 100, 2)
    expect(r).toMatchObject({ ok: false, codigo: 'COBRO_EN_OTRA_CAJA', status: 409 })
    expect(s.mp.creadas).toHaveLength(1)
  })

  test('un cobro que quedó en "creando" sin orden se da por fallido y no traba la caja', async () => {
    const s = montar({ pedidos: [{ id: 100 }, { id: 101 }] })
    s.mp.cfg.falloCrear = new MpError('No se pudo comunicar con Mercado Pago', { red: true })
    await iniciar(s, 100)
    expect(s.cobros[0].estado).toBe('creando')
    s.mp.cfg.falloCrear = null
    // Sin pasar el tiempo, la caja sigue reservada para el pedido 100…
    expect(await iniciar(s, 101)).toMatchObject({ ok: false, codigo: 'CAJA_OCUPADA' })
    // …pero tras la vigencia se descarta.
    s.avanzar(3 * 60_000)
    expect((await iniciar(s, 101)).ok).toBe(true)
    expect(s.cobros[0].estado).toBe('error')
  })
})

describe('errores de Mercado Pago al crear la orden', () => {
  test('un rechazo definitivo deja el cobro en error y se informa', async () => {
    const s = montar()
    s.mp.cfg.falloCrear = new MpError('external_pos_id inválido', { status: 400, code: 'invalid_external_pos_id' })
    const r = await iniciar(s)
    expect(r).toMatchObject({ ok: false, codigo: 'MP_ERROR', status: 502, mensaje: 'external_pos_id inválido' })
    expect(r.ok === false && r.reintentable).toBeFalsy()
    expect(s.cobros[0]).toMatchObject({ estado: 'error', mensaje: 'external_pos_id inválido' })
  })

  test('la cola de Mercado Pago se traduce a caja ocupada', async () => {
    const s = montar()
    s.mp.cfg.falloCrear = new MpError('ya hay una orden', { status: 409, code: 'already_queued_order_on_pos' })
    expect(await iniciar(s)).toMatchObject({ ok: false, codigo: 'CAJA_OCUPADA', status: 409 })
    expect(s.cobros[0].estado).toBe('error')
  })

  test('una credencial rechazada pide reconectar la cuenta', async () => {
    const s = montar()
    s.mp.cfg.falloCrear = new MpError('invalid token', { status: 401 })
    expect(await iniciar(s)).toMatchObject({ ok: false, codigo: 'MP_NO_CONECTADO' })
  })

  test('un corte de red no deja claro si se creó: el cobro queda para retomarlo con la misma referencia', async () => {
    const s = montar()
    s.mp.cfg.falloCrear = new MpError('No se pudo comunicar con Mercado Pago', { red: true })
    const primero = await iniciar(s)
    expect(primero).toMatchObject({ ok: false, codigo: 'MP_ERROR', reintentable: true })
    expect(s.cobros[0].estado).toBe('creando')
    const referencia = s.cobros[0].externalReference

    s.mp.cfg.falloCrear = null
    const segundo = await iniciar(s)
    expect(segundo.ok).toBe(true)
    expect(s.cobros).toHaveLength(1)
    expect(s.mp.creadas.at(-1)!.entrada.referencia).toBe(referencia)
    expect(s.cobros[0]).toMatchObject({ estado: 'creado', mpOrderId: 'ORD1' })
  })

  test('un 5xx también se trata como ambiguo y reintentable', async () => {
    const s = montar()
    s.mp.cfg.falloCrear = new MpError('bad gateway', { status: 502 })
    expect(await iniciar(s)).toMatchObject({ ok: false, reintentable: true })
    expect(s.cobros[0].estado).toBe('creando')
  })
})

describe('confirmación del pago (lo decide el servidor)', () => {
  test('mientras Mercado Pago no acredita, el cobro sigue esperando', async () => {
    const s = montar()
    await iniciar(s)
    expect(await s.servicio.consultarCobro(RESTAURANTE, 100)).toMatchObject({ estado: 'creado' })
    expect(s.pedidos.get(100)!.pagado).toBe(false)
    expect(s.efectosPagados).toEqual([])
  })

  test('cuando la orden queda processed acredita el pedido y dispara los efectos una sola vez', async () => {
    const s = montar()
    await iniciar(s)
    s.mp.pagar('ORD1')
    const c = await s.servicio.consultarCobro(RESTAURANTE, 100)
    expect(c).toMatchObject({ estado: 'pagado', mpStatus: 'processed' })
    expect(c!.pagadoAt).toBe(T0.toISOString())
    expect(s.pedidos.get(100)!.pagado).toBe(true)
    expect(s.pagos).toEqual([{ pedidoId: 100, monto: '1500.00', mpPaymentId: 'PAY-ORD1' }])
    expect(s.efectosPagados).toEqual([100])

    await s.servicio.consultarCobro(RESTAURANTE, 100)
    expect(s.efectosPagados).toEqual([100])
    expect(s.pagos).toHaveLength(1)
  })

  test('el webhook y la consulta a la vez acreditan una sola vez', async () => {
    const s = montar()
    await iniciar(s)
    s.mp.pagar('ORD1')
    await Promise.all([
      s.servicio.consultarCobro(RESTAURANTE, 100),
      s.servicio.procesarNotificacionOrden('ORD1'),
      s.servicio.consultarCobro(RESTAURANTE, 100),
    ])
    expect(s.efectosPagados).toEqual([100])
    expect(s.pagos).toHaveLength(1)
  })

  test('un monto distinto al del pedido NO lo marca pagado: queda en error para revisión', async () => {
    const s = montar()
    await iniciar(s)
    s.mp.pagar('ORD1', '1200.00')
    const c = await s.servicio.consultarCobro(RESTAURANTE, 100)
    expect(c).toMatchObject({ estado: 'error' })
    expect(c!.mensaje).toContain('menos')
    expect(s.pedidos.get(100)!.pagado).toBe(false)
    expect(s.efectosPagados).toEqual([])
  })

  test('una orden con otra referencia no acredita el pedido', async () => {
    const s = montar()
    await iniciar(s)
    s.mp.pagar('ORD1')
    s.mp.mutar('ORD1', { externalReference: 'piru-qr-7-999-deadbeef' })
    expect(await s.servicio.consultarCobro(RESTAURANTE, 100)).toMatchObject({ estado: 'error' })
    expect(s.pedidos.get(100)!.pagado).toBe(false)
  })

  test('vencida o cancelada desde fuera quedan como terminales sin pago', async () => {
    const a = montar()
    await iniciar(a)
    a.mp.mutar('ORD1', { status: 'expired' })
    expect(await a.servicio.consultarCobro(RESTAURANTE, 100)).toMatchObject({ estado: 'vencido', mensaje: 'El cobro venció sin pagarse' })
    const b = montar()
    await iniciar(b)
    b.mp.mutar('ORD1', { status: 'canceled' })
    expect(await b.servicio.consultarCobro(RESTAURANTE, 100)).toMatchObject({ estado: 'cancelado' })
    expect(a.pedidos.get(100)!.pagado || b.pedidos.get(100)!.pagado).toBe(false)
  })

  test('si Mercado Pago no responde, la consulta devuelve el estado local sin romperse', async () => {
    const s = montar()
    await iniciar(s)
    s.mp.cfg.falloObtener = new MpError('timeout', { red: true })
    expect(await s.servicio.consultarCobro(RESTAURANTE, 100)).toMatchObject({ estado: 'creado' })
    expect(s.logs.length).toBeGreaterThan(0)
  })

  test('limita la frecuencia de consultas a Mercado Pago por cobro', async () => {
    const s = montar({}, { consultaMinimaMs: 2_000 })
    await iniciar(s)
    await s.servicio.consultarCobro(RESTAURANTE, 100)
    await s.servicio.consultarCobro(RESTAURANTE, 100)
    expect(s.mp.consultas).toHaveLength(1)
    s.avanzar(2_500)
    await s.servicio.consultarCobro(RESTAURANTE, 100)
    expect(s.mp.consultas).toHaveLength(2)
  })

  test('sin cobros previos no hay nada que consultar', async () => {
    expect(await montar().servicio.consultarCobro(RESTAURANTE, 100)).toBeNull()
  })

  test('el webhook ignora órdenes desconocidas y no repite efectos con un pago ya acreditado', async () => {
    const s = montar()
    expect(await s.servicio.procesarNotificacionOrden('ORD-AJENA')).toBe('ignorado')
    await iniciar(s)
    s.mp.pagar('ORD1')
    expect(await s.servicio.procesarNotificacionOrden('ORD1')).toBe('pagado')
    expect(await s.servicio.procesarNotificacionOrden('ORD1')).toBe('pagado')
    expect(s.efectosPagados).toEqual([100])
  })

  test('un reembolso posterior queda registrado pero no des-paga el pedido', async () => {
    const s = montar()
    await iniciar(s)
    s.mp.pagar('ORD1')
    await s.servicio.procesarNotificacionOrden('ORD1')
    s.mp.mutar('ORD1', { status: 'refunded' })
    expect(await s.servicio.procesarNotificacionOrden('ORD1')).toBe('reembolsado')
    expect(s.cobros[0].estado).toBe('reembolsado')
    expect(s.pedidos.get(100)!.pagado).toBe(true)
  })

  test('el webhook no cambia cobros ya cancelados', async () => {
    const s = montar()
    await iniciar(s)
    await s.servicio.cancelarCobro({ restauranteId: RESTAURANTE, pedidoId: 100, cancelarPedido: false })
    expect(await s.servicio.procesarNotificacionOrden('ORD1')).toBe('sin_cambios')
  })
})

describe('cancelar el cobro', () => {
  const cancelar = (s: ReturnType<typeof montar>, cancelarPedido: boolean, pedidoId = 100) =>
    s.servicio.cancelarCobro({ restauranteId: RESTAURANTE, pedidoId, cancelarPedido })

  test('cancela la orden en Mercado Pago y, si se pide, el pedido impago', async () => {
    const s = montar()
    await iniciar(s)
    const r = await cancelar(s, true)
    expect(r).toMatchObject({ ok: true, data: { pedidoCancelado: true, cobro: { estado: 'cancelado' } } })
    expect(s.mp.cancelaciones).toEqual(['ORD1'])
    expect(s.pedidos.get(100)!.estado).toBe('cancelled')
    expect(s.efectosCancelados).toEqual([100])
  })

  test('sin pedir cancelar el pedido, sólo se libera la caja', async () => {
    const s = montar()
    await iniciar(s)
    const r = await cancelar(s, false)
    expect(r).toMatchObject({ ok: true, data: { pedidoCancelado: false, cobro: { estado: 'cancelado' } } })
    expect(s.pedidos.get(100)!.estado).toBe('pending')
    expect(s.efectosCancelados).toEqual([])
  })

  test('si el cliente alcanzó a pagar, no se cancela el pedido y se informa el pago', async () => {
    const s = montar()
    await iniciar(s)
    s.mp.pagar('ORD1')
    const r = await cancelar(s, true)
    expect(r).toMatchObject({ ok: true, data: { pedidoCancelado: false, cobro: { estado: 'pagado' } } })
    expect(s.pedidos.get(100)).toMatchObject({ pagado: true, estado: 'pending' })
    expect(s.efectosPagados).toEqual([100])
  })

  test('si Mercado Pago no puede cancelar y la orden sigue viva, no se cancela nada', async () => {
    const s = montar()
    await iniciar(s)
    s.mp.cfg.falloCancelar = new MpError('boom', { status: 500 })
    const r = await cancelar(s, true)
    expect(r).toMatchObject({ ok: false, codigo: 'MP_ERROR' })
    expect(s.pedidos.get(100)!.estado).toBe('pending')
    expect(s.cobros[0].estado).toBe('creado')
  })

  test('si ya había vencido, cancelar igual cierra el cobro y el pedido', async () => {
    const s = montar()
    await iniciar(s)
    s.mp.mutar('ORD1', { status: 'expired' })
    const r = await cancelar(s, true)
    expect(r).toMatchObject({ ok: true, data: { pedidoCancelado: true, cobro: { estado: 'vencido' } } })
  })

  test('es idempotente y también cancela un pedido sin cobro', async () => {
    const s = montar()
    await iniciar(s)
    await cancelar(s, true)
    const otra = await cancelar(s, true)
    expect(otra).toMatchObject({ ok: true, data: { pedidoCancelado: false } })
    expect(s.mp.cancelaciones).toEqual(['ORD1'])
    const sinCobro = montar()
    expect(await cancelar(sinCobro, true)).toMatchObject({ ok: true, data: { cobro: null, pedidoCancelado: true } })
  })

  test('un cobro que nunca llegó a crearse se cancela sin llamar a Mercado Pago', async () => {
    const s = montar()
    s.mp.cfg.falloCrear = new MpError('sin red', { red: true })
    await iniciar(s)
    const r = await cancelar(s, true)
    expect(r).toMatchObject({ ok: true, data: { pedidoCancelado: true, cobro: { estado: 'cancelado' } } })
    expect(s.mp.cancelaciones).toEqual([])
  })

  test('nunca cancela un pedido ya pagado', async () => {
    const s = montar({ pedidos: [{ id: 100, pagado: true }] })
    expect(await cancelar(s, true)).toMatchObject({ ok: true, data: { pedidoCancelado: false } })
    expect(s.pedidos.get(100)!.estado).toBe('pending')
  })
})

describe('cajas', () => {
  test('el estado expone las cajas activas sólo si el módulo está activo', async () => {
    const s = montar()
    expect(await s.servicio.estado(RESTAURANTE)).toMatchObject({ moduloMercadoPago: true, mpConectado: true, cajas: [{ id: 1, nombre: 'Caja 1', qrUrl: 'https://mp/qr1.png' }] })
    const sin = montar({ conexion: { moduloActivo: false } })
    expect(await sin.servicio.estado(RESTAURANTE)).toEqual({ moduloMercadoPago: false, mpConectado: true, cajas: [] })
  })

  test('lista las cajas de Mercado Pago marcando las ya vinculadas', async () => {
    const s = montar()
    s.mp.cfg.cajasRemotas = [
      { id: 'MP1', nombre: 'Caja 1', externalId: 'PIRU7CAJA1', storeId: '10', externalStoreId: null, qrImagen: 'https://mp/qr1.png', qrPlantilla: null },
      { id: 'MP77', nombre: 'Otra', externalId: null, storeId: '10', externalStoreId: null, qrImagen: null, qrPlantilla: null },
    ]
    const r = await s.servicio.listarCajasMp(RESTAURANTE)
    expect(r).toMatchObject({ ok: true, data: [{ mpPosId: 'MP1', vinculada: true }, { mpPosId: 'MP77', vinculada: false, externalId: null }] })
  })

  test('vincular exige que la caja exista y traiga ID externo', async () => {
    const s = montar({ cajas: [] })
    s.mp.cfg.cajasRemotas = [
      { id: 'MP5', nombre: 'Feria', externalId: 'FERIA5', storeId: '10', externalStoreId: null, qrImagen: 'https://mp/f.png', qrPlantilla: null },
      { id: 'MP6', nombre: 'Sin id', externalId: null, storeId: '10', externalStoreId: null, qrImagen: null, qrPlantilla: null },
    ]
    expect(await s.servicio.vincularCaja(RESTAURANTE, 'MP404')).toMatchObject({ ok: false, codigo: 'CAJA_NO_ENCONTRADA' })
    expect(await s.servicio.vincularCaja(RESTAURANTE, 'MP6')).toMatchObject({ ok: false, codigo: 'CAJA_SIN_ID_EXTERNO', status: 422 })
    const ok = await s.servicio.vincularCaja(RESTAURANTE, 'MP5')
    expect(ok).toMatchObject({ ok: true, data: { nombre: 'Feria', externalPosId: 'FERIA5', qrUrl: 'https://mp/f.png' } })
    expect(s.cajas).toHaveLength(1)
    // Vincular dos veces la misma caja no la duplica.
    await s.servicio.vincularCaja(RESTAURANTE, 'MP5')
    expect(s.cajas).toHaveLength(1)
  })

  test('crear una caja usa una tienda real del vendedor y guarda el QR que devuelve Mercado Pago', async () => {
    const s = montar({ cajas: [] })
    s.mp.cfg.tiendas = [{ id: '10', nombre: 'Stand Feria', externalId: 'S10', direccion: 'Belgrano 10' }]
    s.mp.cfg.cajasRemotas = [{ id: '900', nombre: 'Caja Feria', externalId: 'PIRU7X', storeId: '10', externalStoreId: 'S10', qrImagen: 'https://mp/900.png', qrPlantilla: 'https://mp/900.pdf' }]
    const r = await s.servicio.crearCajaNueva(RESTAURANTE, { nombre: 'Caja Feria', tiendaId: '10' })
    expect(r).toMatchObject({ ok: true, data: { nombre: 'Caja Feria', externalPosId: expect.stringMatching(/^PIRU7/), qrUrl: 'https://mp/900.png' } })
    expect(s.mp.cfg.cajasCreadas).toHaveLength(1)
    expect(s.mp.cfg.cajasCreadas[0]).toMatchObject({ tiendaId: '10', tiendaExternalId: 'S10' })
    expect(s.mp.cfg.cajasCreadas[0].externalPosId).toMatch(/^PIRU7[0-9A-F]{10}$/)
  })

  test('no crea cajas sobre tiendas que no son del vendedor', async () => {
    const s = montar({ cajas: [] })
    s.mp.cfg.tiendas = [{ id: '10', nombre: 'Stand', externalId: null, direccion: null }]
    expect(await s.servicio.crearCajaNueva(RESTAURANTE, { nombre: 'x', tiendaId: '999' })).toMatchObject({ ok: false, codigo: 'TIENDA_INVALIDA' })
    expect(s.mp.cfg.cajasCreadas).toHaveLength(0)
  })

  test('desvincular oculta la caja sin borrarla y falla si no estaba vinculada', async () => {
    const s = montar()
    expect(await s.servicio.desvincularCaja(RESTAURANTE, 1)).toMatchObject({ ok: true })
    expect((await s.servicio.estado(RESTAURANTE)).cajas).toEqual([])
    expect(await s.servicio.desvincularCaja(RESTAURANTE, 1)).toMatchObject({ ok: false, codigo: 'CAJA_NO_ENCONTRADA' })
    expect(await iniciar(s)).toMatchObject({ ok: false, codigo: 'CAJA_NO_ENCONTRADA' })
  })

  test('un error de Mercado Pago al listar se traduce sin exponer detalles internos', async () => {
    const s = montar()
    s.mp.cliente.listarCajas = async () => { throw new MpError('down', { status: 503 }) }
    expect(await s.servicio.listarCajasMp(RESTAURANTE)).toMatchObject({ ok: false, codigo: 'MP_ERROR', reintentable: true })
  })
})
