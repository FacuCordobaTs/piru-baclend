import { describe, expect, test } from 'bun:test'
import { marketerPuede, marketerPuedeSocketAdmin } from './marketer-permisos'

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
  })
})
