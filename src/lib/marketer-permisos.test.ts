import { describe, expect, test } from 'bun:test'
import {
  duenioAppMarketingPuede,
  marketerPuede,
  marketerPuedeSocketAdmin,
} from './marketer-permisos'

describe('permisos delegados del marketer', () => {
  test('autoriza sólo la superficie acordada', () => {
    for (const [method, path] of [
      ['GET', '/api/metricas?from=2026-10-01'],
      ['GET', '/api/producto'],
      ['GET', '/api/categoria'],
      ['GET', '/api/modulos/catalogo'],
      ['GET', '/api/modulos/mis-modulos'],
      ['PUT', '/api/modulos/crecimiento/activar'],
      ['POST', '/api/modulos/motor_recompra/pago-link-whatsapp'],
      ['GET', '/api/clientes/list'],
      ['GET', '/api/clientes/7'],
      ['POST', '/api/clientes/recompra/programar'],
      ['DELETE', '/api/clientes/recompra/programaciones/8/cancelar'],
      ['POST', '/api/marketing/campanas'],
      ['DELETE', '/api/marketing/campanas/5'],
      ['PUT', '/api/codigo-descuento/5'],
      ['PUT', '/api/puntos/productos/3'],
    ]) {
      expect(marketerPuede(method, path)).toBe(true)
    }
  })
  test('protege secretos, clientes, precios, cobros y prefijos ambiguos', () => {
    for (const [method, path] of [
      ['DELETE', '/api/clientes/7'],
      ['DELETE', '/api/clientes/7/pedidos/4'],
      ['GET', '/api/clientes/indice-pos'],
      ['GET', '/api/restaurante/profile'],
      ['GET', '/api/sucursales/list'],
      ['PUT', '/api/producto/update'],
      ['POST', '/api/producto'],
      ['GET', '/api/pedido-unificado'],
      ['PUT', '/api/modulos/motor_recompra/desactivar'],
      ['GET', '/api/marketing-interno'],
      ['GET', '/api/marketing/../restaurante/profile'],
      ['GET', '/api/clientes/%69ndice-pos'],
      ['GET', '/api//clientes/list'],
      ['HEAD', '/api/clientes/list'],
      ['GET', '/api/mi-marketer'],
      // Lo que sólo le toca al dueño en la app de marketers.
      ['GET', '/api/marketing-duenio/local'],
      ['GET', '/api/marketing-duenio/sucursales'],
      ['POST', '/api/marketing-duenio/entrada'],
      ['POST', '/api/modulos/motor_recompra/checkout'],
    ]) {
      expect(marketerPuede(method, path)).toBe(false)
    }
  })
  test('el feed de pedidos rechaza sesión y token de local del marketer', () => {
    expect(marketerPuedeSocketAdmin({ id: 6 })).toBe(true)
    expect(
      marketerPuedeSocketAdmin({ id: 6, scope: 'restaurante', marketerId: 2 }),
    ).toBe(false)
    expect(marketerPuedeSocketAdmin({ scope: 'marketer', marketerId: 2 })).toBe(
      false,
    )
    expect(marketerPuedeSocketAdmin({ id: -1 })).toBe(false)
    expect(
      marketerPuedeSocketAdmin({ id: 6, scope: 'restaurante', appMarketing: true }),
    ).toBe(false)
  })
})

describe('sesión del dueño en la app de marketers', () => {
  test('alcanza lo mismo que el marketer, su tarjeta, sus sucursales, pagar un módulo y borrar clientes', () => {
    for (const [method, path] of [
      ['GET', '/api/clientes/list'],
      ['POST', '/api/clientes/recompra/programar'],
      ['POST', '/api/marketing/campanas'],
      ['PUT', '/api/puntos/productos/3'],
      ['PUT', '/api/modulos/crecimiento/activar'],
      ['POST', '/api/modulos/motor_recompra/pago-link-whatsapp'],
      ['GET', '/api/marketing-duenio/local'],
      ['GET', '/api/marketing-duenio/sucursales'],
      ['POST', '/api/modulos/motor_recompra/checkout'],
      ['DELETE', '/api/clientes/7'],
      ['DELETE', '/api/clientes/7/pedidos/4'],
      ['DELETE', '/api/marketing/campanas/5'],
      ['DELETE', '/api/codigo-descuento/5'],
      ['POST', '/api/clientes/recompra/pausar'],
      ['POST', '/api/clientes/recompra/reanudar'],
      ['GET', '/api/puntos/cliente/7/historial'],
    ]) {
      expect(duenioAppMarketingPuede(method, path)).toBe(true)
    }
  })
  test('el resto del panel, emitir pases y los paths ambiguos quedan afuera', () => {
    for (const [method, path] of [
      ['GET', '/api/restaurante/profile'],
      ['GET', '/api/sucursales/list'],
      ['PUT', '/api/producto/update'],
      ['GET', '/api/pedido-unificado'],
      ['GET', '/api/mi-marketer'],
      ['GET', '/api/clientes/indice-pos'],
      // Borrar es sólo de un cliente o un pedido por id; nada de rutas hermanas.
      ['DELETE', '/api/clientes/indice-pos'],
      ['DELETE', '/api/clientes/recompra'],
      ['DELETE', '/api/clientes/abc/pedidos/4'],
      ['DELETE', '/api/clientes/%37'],
      ['DELETE', '/api/marketing-duenio/sucursales'],
      ['PUT', '/api/modulos/motor_recompra/desactivar'],
      ['POST', '/api/modulos/motor_recompra/reactivar'],
      ['POST', '/api/marketing-duenio/entrada'],
      ['POST', '/api/marketing-duenio/sesion'],
      ['GET', '/api/marketing-duenio/local/../entrada'],
      ['GET', '/api//marketing-duenio/local'],
      ['POST', '/api/modulos/motor_recompra/checkout/../../../suscripcion'],
      ['HEAD', '/api/marketing-duenio/local'],
    ]) {
      expect(duenioAppMarketingPuede(method, path)).toBe(false)
    }
  })
})
