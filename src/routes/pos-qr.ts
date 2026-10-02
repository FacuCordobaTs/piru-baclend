// pos-qr.ts — cobros del POS con el QR estático de una caja de Mercado Pago.
//
// Conexión con la aplicación de Mercado Pago para QR (pagos presenciales), distinta de la de pagos online:
//   POST   /conexion/iniciar               URL de autorización (state firmado) para llevar al vendedor
//   DELETE /conexion                       desconecta y desactiva las cajas
//   GET    /mp-qr/callback                 (otro router, público) vuelve Mercado Pago con el `code`
// Cajas (administración, sólo dueño autenticado):
//   GET    /estado                         módulo, conexión de QR y cajas vinculadas
//   GET    /mp/cajas                       cajas del vendedor en Mercado Pago
//   GET    /mp/tiendas                     tiendas del vendedor (para crear una caja)
//   POST   /cajas                          vincula una caja existente
//   POST   /cajas/nueva                    crea una caja sobre una tienda existente
//   DELETE /cajas/:id                      desvincula
// Cobro de un pedido del POS (gateado por `requirePosDelPedido`: POS activo o sede de evento):
//   POST   /pedidos/:id/cobro              crea o retoma el cobro (idempotente)
//   GET    /pedidos/:id/cobro              estado; sincroniza con Mercado Pago si sigue pendiente
//   POST   /pedidos/:id/cobro/cancelar     cancela la orden y, si se pide, el pedido impago
//
// La confirmación del pago la decide el servidor contra Mercado Pago: el POS sólo consulta.
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { authMiddleware } from '../middleware/auth'
import { requirePosDelPedido } from '../middleware/pos-evento'
import { MODULE_KEYS } from '../lib/modulos'
import { diagnosticoSeguroQr } from '../lib/mp-qr'
import type { ServicioConexionQr } from '../lib/mp-conexion-qr'
import { servicioCobrosQr, servicioConexionQr } from '../lib/pos-cobros-qr-prod'
import type { Resultado, ServicioCobrosQr } from '../lib/pos-cobros-qr'

export interface DependenciasPosQrRoute {
  servicio: ServicioCobrosQr
  conexion: ServicioConexionQr
  autenticacion: MiddlewareHandler
  /** Gate del POS sobre el pedido de la URL (`:id`). */
  posDelPedido: MiddlewareHandler
}

const crearCajaSchema = z.object({ mpPosId: z.string().trim().min(1).max(40) })
const nuevaCajaSchema = z.object({
  nombre: z.string().trim().min(1).max(80),
  tiendaId: z.string().trim().regex(/^\d{1,20}$/, 'La tienda no es válida'),
})
const cobroSchema = z.object({ cajaId: z.number().int().positive() })
const cancelarSchema = z.object({ cancelarPedido: z.boolean().default(false) })

export function crearPosQrRoute({ servicio, conexion, autenticacion, posDelPedido }: DependenciasPosQrRoute) {
  const route = new Hono()
  route.use('*', autenticacion)

  const restauranteIdDe = (c: Context) => Number((c as any).user.id)
  const pedidoIdDe = (c: Context) => Number(c.req.param('id'))

  const responder = <T,>(c: Context, resultado: Resultado<T>) => {
    if (resultado.ok) return c.json({ success: true, data: resultado.data })
    return c.json({
      success: false,
      code: resultado.codigo,
      message: resultado.mensaje,
      ...(resultado.reintentable ? { reintentable: true } : {}),
      ...(resultado.datos ? { data: resultado.datos } : {}),
      // Mismo contrato que `requireModulo`: los admins ya saben mostrar el aviso de módulo.
      ...(resultado.codigo === 'MODULO_MP_INACTIVO' ? { moduleRequired: true, module: MODULE_KEYS.MERCADOPAGO, upgradeRequired: true } : {}),
    }, resultado.status as 400)
  }

  // ── Conexión con la aplicación de Mercado Pago para QR ──
  route.post('/conexion/iniciar', async (c) => responder(c, await conexion.iniciar(restauranteIdDe(c))))

  route.delete('/conexion', async (c) => {
    await conexion.desconectar(restauranteIdDe(c))
    return c.json({ success: true })
  })

  // ── Cajas ──
  route.get('/estado', async (c) => c.json({ success: true, data: await servicio.estado(restauranteIdDe(c)) }))
  route.get('/mp/cajas', async (c) => responder(c, await servicio.listarCajasMp(restauranteIdDe(c))))
  route.get('/mp/tiendas', async (c) => responder(c, await servicio.listarTiendasMp(restauranteIdDe(c))))

  route.post('/cajas', zValidator('json', crearCajaSchema), async (c) =>
    responder(c, await servicio.vincularCaja(restauranteIdDe(c), c.req.valid('json').mpPosId)))

  route.post('/cajas/nueva', zValidator('json', nuevaCajaSchema), async (c) =>
    responder(c, await servicio.crearCajaNueva(restauranteIdDe(c), c.req.valid('json'))))

  route.delete('/cajas/:id{[0-9]+}', async (c) =>
    responder(c, await servicio.desvincularCaja(restauranteIdDe(c), Number(c.req.param('id')))))

  // ── Cobro de un pedido ──
  route.post('/pedidos/:id{[0-9]+}/cobro', posDelPedido, zValidator('json', cobroSchema), async (c) =>
    responder(c, await servicio.iniciarCobro({
      restauranteId: restauranteIdDe(c),
      pedidoId: pedidoIdDe(c),
      cajaId: c.req.valid('json').cajaId,
    })))

  route.get('/pedidos/:id{[0-9]+}/cobro', posDelPedido, async (c) =>
    c.json({ success: true, data: await servicio.consultarCobro(restauranteIdDe(c), pedidoIdDe(c)) }))

  route.post('/pedidos/:id{[0-9]+}/cobro/cancelar', posDelPedido, zValidator('json', cancelarSchema), async (c) =>
    responder(c, await servicio.cancelarCobro({
      restauranteId: restauranteIdDe(c),
      pedidoId: pedidoIdDe(c),
      cancelarPedido: c.req.valid('json').cancelarPedido,
    })))

  return route
}

export const posQrRoute = crearPosQrRoute({
  servicio: servicioCobrosQr,
  conexion: servicioConexionQr,
  autenticacion: authMiddleware,
  posDelPedido: requirePosDelPedido,
})

// ── Callback público del OAuth ──
// Mercado Pago redirige acá al vendedor con `code` y `state`. Va en su propio router (sin
// `autenticacion`): no hay sesión del admin en esa redirección, y la identidad la da el `state`
// firmado por este servidor. Vuelve al admin con el resultado en la URL.

export interface DependenciasCallbackQr {
  conexion: ServicioConexionQr
  /** Origen del admin, sin barra final. */
  adminUrl: string
}

export function crearMpQrCallbackRoute({ conexion, adminUrl }: DependenciasCallbackQr) {
  const route = new Hono()
  route.get('/callback', async (c) => {
    const volver = (estado: 'success' | 'error', motivo?: string) =>
      c.redirect(`${adminUrl}/dashboard?mp_qr_status=${estado}${motivo ? `&mp_qr_error=${motivo}` : ''}`)
    try {
      const resultado = await conexion.completar({
        code: c.req.query('code'),
        state: c.req.query('state'),
        error: c.req.query('error'),
      })
      return resultado.ok ? volver('success') : volver('error', resultado.motivo)
    } catch (error) {
      // Sin `code`, `state` ni tokens en el log.
      console.error('❌ [mp-qr] Error en el callback de OAuth:', diagnosticoSeguroQr(error))
      return volver('error', 'servidor')
    }
  })
  return route
}

export const mpQrCallbackRoute = crearMpQrCallbackRoute({
  conexion: servicioConexionQr,
  adminUrl: (process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, ''),
})
