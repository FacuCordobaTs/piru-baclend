import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  MpError,
  aCentavos,
  armarOrdenQr,
  centavosAMonto,
  crearClienteMpQr,
  detalleErrorMp,
  esNotificacionDeOrden,
  interpretarOrdenMp,
  montoParaMp,
  montosIguales,
  normalizarCajaMp,
  normalizarOrdenMp,
  normalizarTiendaMp,
  nuevaReferenciaCobro,
  nombreCajaMp,
  nuevoExternalPosId,
  validarFirmaWebhookMp,
  type OrdenMp,
} from './mp-qr'

const orden = (parcial: Partial<OrdenMp> = {}): OrdenMp => ({
  id: 'ORD01',
  status: 'created',
  statusDetail: null,
  externalReference: 'piru-qr-1-2-abcd1234',
  totalAmount: '1500.00',
  totalPaidAmount: null,
  pagos: [],
  ...parcial,
})
const esperado = { montoCentavos: 150000, referencia: 'piru-qr-1-2-abcd1234' }

describe('montos', () => {
  test('convierte a centavos sin depender del formato y rechaza lo no numérico', () => {
    expect(aCentavos('1500.00')).toBe(150000)
    expect(aCentavos(1500.5)).toBe(150050)
    expect(aCentavos('19.99')).toBe(1999)
    expect(aCentavos('0.1')).toBe(10)
    for (const invalido of [null, undefined, '', 'abc', NaN, Infinity]) expect(aCentavos(invalido as never)).toBeNull()
    expect(centavosAMonto(150050)).toBe('1500.50')
  })

  test('monto para Mercado Pago: dos decimales y sólo positivos', () => {
    expect(montoParaMp('1500')).toBe('1500.00')
    expect(montoParaMp(2340.5)).toBe('2340.50')
    expect(montoParaMp('0')).toBeNull()
    expect(montoParaMp('-10')).toBeNull()
    expect(montoParaMp('x')).toBeNull()
    expect(montoParaMp(0.004)).toBeNull()
  })

  test('comparación de montos por centavos, tolerante a "1500" vs "1500.00"', () => {
    expect(montosIguales('1500', '1500.00')).toBe(true)
    expect(montosIguales('1500.01', '1500.00')).toBe(false)
    expect(montosIguales(null, '1500.00')).toBe(false)
  })
})

describe('identificadores', () => {
  test('la referencia cabe en 64 caracteres, usa sólo caracteres permitidos y es única por intento', () => {
    const a = nuevaReferenciaCobro(12, 345)
    const b = nuevaReferenciaCobro(12, 345)
    expect(a).toMatch(/^piru-qr-12-345-[0-9a-f]{8}$/)
    expect(a).not.toBe(b)
    expect(nuevaReferenciaCobro(1, 2, () => 'x'.repeat(200)).length).toBeLessThanOrEqual(64)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('el external_id de la caja es alfanumérico y de hasta 40 caracteres', () => {
    const id = nuevoExternalPosId(7)
    expect(id).toMatch(/^PIRU7[0-9A-F]{10}$/)
    expect(nuevoExternalPosId(7, () => 'zz-**-yy_' + 'a'.repeat(80)).length).toBeLessThanOrEqual(40)
    expect(nuevoExternalPosId(7, () => 'zz-**-yy_')).toMatch(/^[A-Za-z0-9]+$/)
  })
})

describe('nombre de la caja (POST /v2/pos)', () => {
  test('deja letras, números, guiones, guiones bajos y espacios internos', () => {
    expect(nombreCajaMp('Barra 1')).toBe('Barra 1')
    expect(nombreCajaMp('caja_2-salida')).toBe('caja_2-salida')
  })

  test('quita acentos y signos, junta espacios y recorta bordes', () => {
    expect(nombreCajaMp('  Barra del Evento Ñandú!  ')).toBe('Barra del Evento Nandu')
    expect(nombreCajaMp('Caja   #3 (norte)')).toBe('Caja 3 norte')
  })

  test('respeta el máximo de 45 caracteres sin dejar un espacio al final y nunca queda vacío', () => {
    const largo = nombreCajaMp(`${'a'.repeat(44)} bbbb`)
    expect(largo.length).toBeLessThanOrEqual(45)
    expect(largo.endsWith(' ')).toBe(false)
    expect(nombreCajaMp('!!!')).toBe('Caja Piru')
    expect(nombreCajaMp('')).toBe('Caja Piru')
  })
})

describe('orden QR (contrato del plugin de Mercado Pago)', () => {
  const cuerpo = armarOrdenQr({ monto: '1500.00', referencia: 'piru-qr-1-2-abcd1234', externalPosId: 'PIRU1ABC', descripcion: 'Pedido #2' })

  test('es una orden type qr en modo static con un único pago del mismo importe', () => {
    expect(cuerpo.type).toBe('qr')
    expect(cuerpo.config).toEqual({ qr: { external_pos_id: 'PIRU1ABC', mode: 'static' } })
    expect(cuerpo.total_amount).toBe('1500.00')
    expect(cuerpo.transactions.payments).toEqual([{ amount: '1500.00' }])
    expect(cuerpo.external_reference).toBe('piru-qr-1-2-abcd1234')
    expect(cuerpo.expiration_time).toBe('PT10M')
  })

  test('no arrastra campos prohibidos: payer, items, checkout, headers de Point', () => {
    const json = JSON.stringify(cuerpo)
    for (const prohibido of ['payer', 'items', 'currency_id', 'init_point', 'checkout_url', 'qr_data', 'redirect']) {
      expect(json).not.toContain(prohibido)
    }
  })

  test('la descripción se recorta al máximo de Mercado Pago', () => {
    const largo = armarOrdenQr({ monto: '1.00', referencia: 'r', externalPosId: 'p', descripcion: 'x'.repeat(400) })
    expect(largo.description.length).toBe(150)
  })
})

describe('normalizar respuestas', () => {
  test('orden sin id es inválida; con id se normaliza estado y pagos', () => {
    expect(normalizarOrdenMp(null)).toBeNull()
    expect(normalizarOrdenMp({ status: 'created' })).toBeNull()
    const n = normalizarOrdenMp({
      id: 'ORD9',
      status: 'PROCESSED',
      status_detail: 'accredited',
      external_reference: 'ref',
      total_amount: '10.00',
      total_paid_amount: '10.00',
      transactions: { payments: [{ id: 'PAY1', status: 'Processed', amount: '10.00', paid_amount: '10.00' }, null] },
    })
    expect(n).toEqual({
      id: 'ORD9', status: 'processed', statusDetail: 'accredited', externalReference: 'ref',
      totalAmount: '10.00', totalPaidAmount: '10.00',
      pagos: [{ id: 'PAY1', status: 'processed', statusDetail: null, amount: '10.00', paidAmount: '10.00' }],
    })
  })

  test('caja v2: ids numéricos pasan a string y el QR sale de qr_response.image', () => {
    expect(normalizarCajaMp({
      id: 1234, name: 'Caja 1', status: 'active', external_id: 'PIRU1ABC', store_id: '55', external_store_id: 'S55',
      config: { qr: { operating_mode: 'pdv' } },
      qr_response: { uuid: 'abc', image: 'https://mp/qr.png', template_document: 'https://mp/qr.pdf', template_image: 'https://mp/qr-plantilla.png' },
    })).toEqual({
      id: '1234', nombre: 'Caja 1', externalId: 'PIRU1ABC', storeId: '55', externalStoreId: 'S55',
      qrImagen: 'https://mp/qr.png', qrPlantilla: 'https://mp/qr.pdf', activa: true,
    })
  })

  test('caja con la forma anterior (qr) sigue leyéndose, y una inactiva se marca', () => {
    expect(normalizarCajaMp({ id: 7, name: 'Vieja', external_id: 'E7', store_id: 5, status: 'inactive', qr: { image: 'https://mp/viejo.png', template_image: 'https://mp/viejo-plantilla.png' } }))
      .toEqual({ id: '7', nombre: 'Vieja', externalId: 'E7', storeId: '5', externalStoreId: null, qrImagen: 'https://mp/viejo.png', qrPlantilla: 'https://mp/viejo-plantilla.png', activa: false })
  })

  test('caja sin id es inválida; tienda con calle y número arma su dirección', () => {
    expect(normalizarCajaMp({ name: 'sin id' })).toBeNull()
    expect(normalizarTiendaMp({ id: 9, name: 'Stand', location: { street_name: 'Belgrano', street_number: '10' } }))
      .toEqual({ id: '9', nombre: 'Stand', externalId: null, direccion: 'Belgrano 10' })
  })

  test('errores de Mercado Pago: formato Orders y formato clásico', () => {
    expect(detalleErrorMp({ errors: [{ code: 'already_queued_order_on_pos', message: 'cola' }] }))
      .toEqual({ code: 'already_queued_order_on_pos', message: 'cola' })
    expect(detalleErrorMp({ message: 'bad', error: 'bad_request', cause: [{ description: 'detalle' }] }))
      .toEqual({ code: 'bad_request', message: 'detalle' })
    expect(detalleErrorMp('x')).toEqual({ code: null, message: null })
  })
})

describe('interpretar la orden (sólo processed cuenta como pago)', () => {
  test('created y estados intermedios siguen esperando', () => {
    for (const status of ['created', 'processing', 'action_required', 'at_terminal', 'desconocido']) {
      expect(interpretarOrdenMp(orden({ status }), esperado).estado).toBe('creado')
    }
  })

  test('processed con referencia y monto correctos es pago', () => {
    const r = interpretarOrdenMp(orden({ status: 'processed', statusDetail: 'accredited', totalPaidAmount: '1500.00', pagos: [{ id: 'PAY1', status: 'processed', statusDetail: null, amount: '1500.00', paidAmount: '1500.00' }] }), esperado)
    expect(r).toMatchObject({ estado: 'pagado', paymentId: 'PAY1', montoPagado: '1500.00' })
  })

  test('processed sin detalle de montos usa el total de la orden', () => {
    expect(interpretarOrdenMp(orden({ status: 'processed' }), esperado)).toMatchObject({ estado: 'pagado', montoPagado: '1500.00', paymentId: null })
  })

  test('suma los pagos acreditados cuando falta total_paid_amount', () => {
    const r = interpretarOrdenMp(orden({ status: 'processed', pagos: [
      { id: 'A', status: 'processed', statusDetail: null, amount: '1000.00', paidAmount: '1000.00' },
      { id: 'B', status: 'processed', statusDetail: null, amount: '500.00', paidAmount: null },
      { id: 'C', status: 'failed', statusDetail: null, amount: '999.00', paidAmount: null },
    ] }), esperado)
    expect(r).toMatchObject({ estado: 'pagado', montoPagado: '1500.00', paymentId: 'A' })
  })

  test('una orden de otra referencia, otro monto o pagada de menos NO se acredita', () => {
    expect(interpretarOrdenMp(orden({ status: 'processed', externalReference: 'piru-qr-9-9-ffff0000' }), esperado).estado).toBe('error')
    expect(interpretarOrdenMp(orden({ status: 'processed', totalAmount: '1400.00' }), esperado).estado).toBe('error')
    expect(interpretarOrdenMp(orden({ status: 'processed', totalPaidAmount: '1499.99' }), esperado).estado).toBe('error')
  })

  test('cancelada, vencida, reembolsada y fallida son terminales sin pago', () => {
    expect(interpretarOrdenMp(orden({ status: 'canceled' }), esperado).estado).toBe('cancelado')
    expect(interpretarOrdenMp(orden({ status: 'cancelled' }), esperado).estado).toBe('cancelado')
    expect(interpretarOrdenMp(orden({ status: 'expired' }), esperado).estado).toBe('vencido')
    expect(interpretarOrdenMp(orden({ status: 'refunded' }), esperado).estado).toBe('reembolsado')
    expect(interpretarOrdenMp(orden({ status: 'failed' }), esperado).estado).toBe('error')
  })

  test('una orden sin external_reference no se descarta por eso (lo decide el monto)', () => {
    expect(interpretarOrdenMp(orden({ status: 'processed', externalReference: null }), esperado).estado).toBe('pagado')
  })
})

// ───────────────────────────── Cliente HTTP ─────────────────────────────

interface Llamada { url: string; init: RequestInit }
function fetchFalso(respuestas: Array<Response | Error | ((llamada: Llamada) => Response)>) {
  const llamadas: Llamada[] = []
  const fn = (async (url: string, init: RequestInit) => {
    const llamada = { url, init }
    llamadas.push(llamada)
    const siguiente = respuestas.shift()
    if (!siguiente) throw new Error('sin respuesta preparada')
    if (siguiente instanceof Error) throw siguiente
    return typeof siguiente === 'function' ? siguiente(llamada) : siguiente
  }) as unknown as typeof fetch
  return { fn, llamadas }
}
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })

function cliente(respuestas: Parameters<typeof fetchFalso>[0], token: string | null = 'TOKEN-A', renovado: string | null = null) {
  const { fn, llamadas } = fetchFalso(respuestas)
  const refrescos: Array<[number, string]> = []
  const mp = crearClienteMpQr({
    obtenerToken: async () => token,
    refrescarToken: async (id, fallido) => { refrescos.push([id, fallido]); return renovado },
    fetch: fn,
  })
  return { mp, llamadas, refrescos }
}

describe('cliente de Mercado Pago', () => {
  test('crea la orden con token del vendedor, idempotencia por referencia y cuerpo del contrato', async () => {
    const { mp, llamadas } = cliente([json({ id: 'ORD1', status: 'created', external_reference: 'ref-1', total_amount: '10.00' }, 201)])
    const resultado = await mp.crearOrdenQr(5, { monto: '10.00', referencia: 'ref-1', externalPosId: 'PIRU5X', descripcion: 'Pedido #1' })
    expect(resultado).toMatchObject({ id: 'ORD1', status: 'created' })
    expect(llamadas).toHaveLength(1)
    expect(llamadas[0].url).toBe('https://api.mercadopago.com/v1/orders')
    expect(llamadas[0].init.method).toBe('POST')
    const headers = llamadas[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer TOKEN-A')
    expect(headers['X-Idempotency-Key']).toBe('ref-1')
    expect(headers['X-Allow-Cancelable-Status']).toBeUndefined()
    expect(JSON.parse(String(llamadas[0].init.body))).toEqual(armarOrdenQr({ monto: '10.00', referencia: 'ref-1', externalPosId: 'PIRU5X', descripcion: 'Pedido #1' }))
  })

  test('sin Mercado Pago conectado falla antes de llamar a la red', async () => {
    const { mp, llamadas } = cliente([], null)
    await expect(mp.obtenerOrden(5, 'ORD1')).rejects.toMatchObject({ name: 'MpError', code: 'mp_no_conectado', status: 401 })
    expect(llamadas).toHaveLength(0)
  })

  test('ante un 401 renueva el token y reintenta una sola vez', async () => {
    const { mp, llamadas, refrescos } = cliente([json({ message: 'unauthorized' }, 401), json({ id: 'ORD1', status: 'created' })], 'VIEJO', 'NUEVO')
    const o = await mp.obtenerOrden(5, 'ORD1')
    expect(o.id).toBe('ORD1')
    // La renovación recibe el token que falló: así no se gasta el refresh_token si otro ya lo renovó.
    expect(refrescos).toEqual([[5, 'VIEJO']])
    expect((llamadas[0].init.headers as Record<string, string>).Authorization).toBe('Bearer VIEJO')
    expect((llamadas[1].init.headers as Record<string, string>).Authorization).toBe('Bearer NUEVO')
  })

  test('si renovar no cambia el token, el 401 se informa sin reintentar', async () => {
    const { mp, llamadas } = cliente([json({ message: 'unauthorized' }, 401)], 'MISMO', 'MISMO')
    await expect(mp.obtenerOrden(5, 'ORD1')).rejects.toMatchObject({ status: 401 })
    expect(llamadas).toHaveLength(1)
  })

  test('un error de red queda marcado como ambiguo', async () => {
    const { mp } = cliente([new Error('socket hang up')])
    const error = await mp.crearOrdenQr(5, { monto: '1.00', referencia: 'r', externalPosId: 'p', descripcion: 'd' }).catch((e) => e)
    expect(error).toBeInstanceOf(MpError)
    expect(error.red).toBe(true)
  })

  test('caja ocupada: el código de Mercado Pago llega como propiedad', async () => {
    const { mp } = cliente([json({ errors: [{ code: 'already_queued_order_on_pos', message: 'ya hay una orden' }] }, 409)])
    const error = await mp.crearOrdenQr(5, { monto: '1.00', referencia: 'r', externalPosId: 'p', descripcion: 'd' }).catch((e) => e)
    expect(error).toBeInstanceOf(MpError)
    expect(error.cajaOcupada).toBe(true)
    expect(error.message).toBe('ya hay una orden')
    expect(error.status).toBe(409)
  })

  test('cancela por id con una clave de idempotencia nueva en cada intento y sin headers de Point', async () => {
    const { mp, llamadas } = cliente([json({ id: 'ORD1', status: 'canceled' }), json({ id: 'ORD1', status: 'canceled' })])
    const o = await mp.cancelarOrden(5, 'ORD1')
    await mp.cancelarOrden(5, 'ORD1')
    expect(o.status).toBe('canceled')
    expect(llamadas[0].url).toBe('https://api.mercadopago.com/v1/orders/ORD1/cancel')
    expect(llamadas[0].init.method).toBe('POST')
    const claves = llamadas.map((l) => (l.init.headers as Record<string, string>)['X-Idempotency-Key'])
    expect(claves[0]).toMatch(/^[0-9a-f-]{36}$/)
    // Con una clave fija, el reintento tras un cancelar fallido devolvería idempotency_key_already_used.
    expect(claves[1]).not.toBe(claves[0])
    expect((llamadas[0].init.headers as Record<string, string>)['X-Allow-Cancelable-Status']).toBeUndefined()
  })

  test('el id de la orden se escapa en la URL', async () => {
    const { mp, llamadas } = cliente([json({ id: 'ORD1', status: 'created' })])
    await mp.obtenerOrden(5, 'ORD/1?x=1')
    expect(llamadas[0].url).toBe('https://api.mercadopago.com/v1/orders/ORD%2F1%3Fx%3D1')
  })

  test('lista las cajas de /v2/pos de a 30, leyendo data, hasta agotar los resultados', async () => {
    const pagina = (desde: number, cuantos: number) => json({
      paging: { total: 33, offset: desde - 1, limit: 30 },
      data: Array.from({ length: cuantos }, (_, i) => ({ id: desde + i, name: `Caja ${desde + i}`, external_id: `E${desde + i}`, qr_response: { image: `https://mp/${desde + i}.png` } })),
    })
    const { mp, llamadas } = cliente([pagina(1, 30), pagina(31, 3)])
    const cajas = await mp.listarCajas(5)
    expect(cajas).toHaveLength(33)
    expect(cajas[32]).toMatchObject({ id: '33', qrImagen: 'https://mp/33.png', activa: true })
    expect(llamadas.map((l) => l.url)).toEqual([
      'https://api.mercadopago.com/v2/pos?limit=30&offset=0',
      'https://api.mercadopago.com/v2/pos?limit=30&offset=30',
    ])
  })

  test('obtener una caja que no existe o no es del vendedor devuelve null; otros errores se propagan', async () => {
    const consulta = cliente([json({ errors: [{ code: 'pos_not_found' }] }, 404)])
    expect(await consulta.mp.obtenerCaja(5, '1')).toBeNull()
    expect(consulta.llamadas[0].url).toBe('https://api.mercadopago.com/v2/pos/1')
    expect(await cliente([json({ errors: [{ code: 'bad_request' }] }, 400)]).mp.obtenerCaja(5, '1')).toBeNull()
    await expect(cliente([json({ message: 'boom' }, 500)]).mp.obtenerCaja(5, '1')).rejects.toMatchObject({ status: 500 })
  })

  test('lista las tiendas del vendedor (también si la página viene envuelta en un arreglo)', async () => {
    const pagina = { paging: { total: 2 }, results: [{ id: 10, name: 'Stand Feria', external_id: 'S1' }, { name: 'sin id' }] }
    const { mp, llamadas } = cliente([json(pagina), json([pagina])])
    const esperadas = [{ id: '10', nombre: 'Stand Feria', externalId: 'S1', direccion: null }]
    expect(await mp.listarTiendas(5, '777')).toEqual(esperadas)
    expect(await mp.listarTiendas(5, '777')).toEqual(esperadas)
    expect(llamadas[0].url).toBe('https://api.mercadopago.com/users/777/stores/search?limit=30&offset=0')
  })

  test('crea la caja con POST /v2/pos, modo atendido, nombre válido y clave de idempotencia', async () => {
    const { mp, llamadas } = cliente([json({
      id: 88, name: 'Caja Feria', status: 'active', external_id: 'PIRU5AAA', store_id: '10',
      qr_response: { image: 'https://mp/qr.png', template_document: 'https://mp/qr.pdf' },
    }, 201)])
    const caja = await mp.crearCaja(5, { nombre: 'Caja Feria ñandú', tiendaId: '10', externalPosId: 'PIRU5AAA' })
    expect(caja).toMatchObject({ id: '88', externalId: 'PIRU5AAA', qrImagen: 'https://mp/qr.png', qrPlantilla: 'https://mp/qr.pdf' })
    expect(llamadas[0].url).toBe('https://api.mercadopago.com/v2/pos')
    expect(llamadas[0].init.method).toBe('POST')
    expect((llamadas[0].init.headers as Record<string, string>)['X-Idempotency-Key']).toBe('PIRU5AAA')
    // Sin fixed_amount (API anterior), sin external_store_id: la tienda se identifica sólo por store_id.
    expect(JSON.parse(String(llamadas[0].init.body))).toEqual({
      name: 'Caja Feria nandu', store_id: '10', external_id: 'PIRU5AAA', config: { qr: { operating_mode: 'pdv' } },
    })
  })

  test('no crea la caja con una tienda no numérica ni sin llamar a la red', async () => {
    const { mp, llamadas } = cliente([])
    await expect(mp.crearCaja(5, { nombre: 'x', tiendaId: 'abc', externalPosId: 'P' })).rejects.toMatchObject({ code: 'tienda_invalida' })
    expect(llamadas).toHaveLength(0)
  })
})

describe('notificaciones de la Orders API', () => {
  test('reconoce el tópico order/orders o la acción order.* y deja pasar los pagos clásicos', () => {
    expect(esNotificacionDeOrden('order', undefined, undefined)).toBe(true)
    expect(esNotificacionDeOrden(undefined, 'orders', undefined)).toBe(true)
    expect(esNotificacionDeOrden('ORDER', undefined, undefined)).toBe(true)
    expect(esNotificacionDeOrden(undefined, undefined, 'order.processed')).toBe(true)
    expect(esNotificacionDeOrden('payment', 'payment', undefined)).toBe(false)
    expect(esNotificacionDeOrden('payment', undefined, 'payment.updated')).toBe(false)
    expect(esNotificacionDeOrden(undefined, 'merchant_order', undefined)).toBe(false)
    expect(esNotificacionDeOrden(undefined, undefined, undefined)).toBe(false)
  })
})

describe('firma del webhook', () => {
  const secreto = 'secreto-de-prueba'
  const firmar = (dataId: string, requestId: string, ts: string) =>
    `ts=${ts},v1=${createHmac('sha256', secreto).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex')}`

  test('acepta una firma válida y normaliza a minúsculas el id alfanumérico', () => {
    const firma = firmar('ord01abc', 'req-1', '1742505638683')
    expect(validarFirmaWebhookMp({ secreto, firma, requestId: 'req-1', dataId: 'ORD01ABC' })).toBe(true)
    expect(validarFirmaWebhookMp({ secreto, firma, requestId: 'req-1', dataId: 'ord01abc' })).toBe(true)
  })

  test('rechaza firmas alteradas, secretos distintos y firmas ausentes o ilegibles', () => {
    const firma = firmar('ord01abc', 'req-1', '1742505638683')
    expect(validarFirmaWebhookMp({ secreto, firma, requestId: 'req-2', dataId: 'ord01abc' })).toBe(false)
    expect(validarFirmaWebhookMp({ secreto, firma, requestId: 'req-1', dataId: 'otro' })).toBe(false)
    expect(validarFirmaWebhookMp({ secreto: 'otro', firma, requestId: 'req-1', dataId: 'ord01abc' })).toBe(false)
    expect(validarFirmaWebhookMp({ secreto, firma: firma.replace('v1=', 'v1=00'), requestId: 'req-1', dataId: 'ord01abc' })).toBe(false)
    expect(validarFirmaWebhookMp({ secreto, firma: undefined, requestId: 'req-1', dataId: 'ord01abc' })).toBe(false)
    expect(validarFirmaWebhookMp({ secreto: '', firma, requestId: 'req-1', dataId: 'ord01abc' })).toBe(false)
    expect(validarFirmaWebhookMp({ secreto, firma: 'basura', requestId: 'req-1', dataId: 'ord01abc' })).toBe(false)
    expect(validarFirmaWebhookMp({ secreto, firma: 'ts=1742505638683', requestId: 'req-1', dataId: 'ord01abc' })).toBe(false)
  })

  test('si data.id o x-request-id no llegaron, se omiten del manifiesto (regla oficial)', () => {
    const ts = '1742505638683'
    const sinRequestId = `ts=${ts},v1=${createHmac('sha256', secreto).update(`id:ord01abc;ts:${ts};`).digest('hex')}`
    expect(validarFirmaWebhookMp({ secreto, firma: sinRequestId, requestId: undefined, dataId: 'ORD01ABC' })).toBe(true)
    // Con el request-id presente la firma anterior ya no sirve: el manifiesto cambia.
    expect(validarFirmaWebhookMp({ secreto, firma: sinRequestId, requestId: 'req-1', dataId: 'ORD01ABC' })).toBe(false)

    const sinDataId = `ts=${ts},v1=${createHmac('sha256', secreto).update(`request-id:req-1;ts:${ts};`).digest('hex')}`
    expect(validarFirmaWebhookMp({ secreto, firma: sinDataId, requestId: 'req-1', dataId: undefined })).toBe(true)
    expect(validarFirmaWebhookMp({ secreto, firma: sinDataId, requestId: 'req-1', dataId: '' })).toBe(true)
  })
})
