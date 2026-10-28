import { describe, expect, test } from 'bun:test'
import { publicStoreApiPath, publicStoreOrigin, storeSlugFromHostname } from './public-store-origin'

describe('subdominios de tienda', () => {
  test('resuelve tiendas y rechaza infraestructura, anidados y hosts parecidos', () => {
    expect(storeSlugFromHostname('burgers10.piru.app')).toBe('burgers10')
    expect(storeSlugFromHostname('che-milanesa.piru.app')).toBe('che-milanesa')
    for (const host of [
      'piru.app',
      'my.piru.app',
      'api.piru.app',
      'admin.piru.app',
      'www.piru.app',
      'marketing.piru.app',
      'x.y.piru.app',
      'burgers10.piru.app.evil.com',
      '-malo.piru.app',
      `${'x'.repeat(64)}.piru.app`,
    ]) {
      expect(storeSlugFromHostname(host)).toBeNull()
    }
  })

  test('el origen debe ser https exacto y sin credenciales', () => {
    expect(publicStoreOrigin('https://burgers10.piru.app')).toBe(true)
    for (const origin of [
      'http://burgers10.piru.app',
      'https://burgers10.piru.app:8443',
      'https://burgers10.piru.app/',
      'https://user@burgers10.piru.app',
      'https://my.piru.app',
      'https://burgers10.piru.app.evil.com',
      'null',
    ]) {
      expect(publicStoreOrigin(origin)).toBe(false)
    }
  })

  test('sólo los caminos públicos y de pago', () => {
    expect(publicStoreApiPath('/public/restaurante/burgers10')).toBe(true)
    expect(publicStoreApiPath('/api/public/delivery/create')).toBe(true)
    expect(publicStoreApiPath('/mp/process-brick')).toBe(true)
    expect(publicStoreApiPath('/api/mp/crear-preferencia-externo')).toBe(true)
    expect(publicStoreApiPath('/restaurante/profile')).toBe(false)
    expect(publicStoreApiPath('/pedido-unificado')).toBe(false)
    expect(publicStoreApiPath('/publicidad')).toBe(false)
  })
})
