import { describe, expect, test } from 'bun:test'
import { descargarImagenRemota, ipPrivada, mimePorFirma } from './imagenes-remotas'

describe('ipPrivada', () => {
  test('bloquea loopback, rangos privados, link-local y metadata', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.10', '169.254.169.254', '0.0.0.0', '100.64.0.1']) {
      expect(ipPrivada(ip)).toBe(true)
    }
    expect(ipPrivada('::1')).toBe(true)
    expect(ipPrivada('fc00::1')).toBe(true)
    expect(ipPrivada('fe80::1')).toBe(true)
    expect(ipPrivada('::ffff:127.0.0.1')).toBe(true)
    expect(ipPrivada('::ffff:7f00:1')).toBe(true)
  })

  test('deja pasar direcciones públicas', () => {
    expect(ipPrivada('8.8.8.8')).toBe(false)
    expect(ipPrivada('1.1.1.1')).toBe(false)
    expect(ipPrivada('2606:4700:4700::1111')).toBe(false)
  })
})

describe('mimePorFirma', () => {
  test('reconoce JPG, PNG y WebP por sus bytes', () => {
    expect(mimePorFirma(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg')
    expect(mimePorFirma(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
    expect(mimePorFirma(new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    ]))).toBe('image/webp')
  })

  test('rechaza cualquier otro archivo', () => {
    expect(mimePorFirma(new TextEncoder().encode('<html></html>'))).toBeNull()
    expect(mimePorFirma(new Uint8Array([]))).toBeNull()
  })
})

describe('descargarImagenRemota', () => {
  test('rechaza protocolos y destinos internos antes de salir a la red', async () => {
    await expect(descargarImagenRemota('ftp://ejemplo.com/foto.jpg')).rejects.toThrow(/http o https/)
    await expect(descargarImagenRemota('http://127.0.0.1/foto.jpg')).rejects.toThrow(/interna/)
    await expect(descargarImagenRemota('http://localhost/foto.jpg')).rejects.toThrow(/interna/)
    await expect(descargarImagenRemota('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/interna/)
  })
})
