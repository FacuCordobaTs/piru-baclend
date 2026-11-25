import { describe, expect, test } from 'bun:test'
import { decidirConfirmacion, inicioDelDiaAr, mismaLinea, VENTANA_CONFIRMACION_MS } from './whatsapp-vinculado'

const ahora = Date.parse('2026-11-25T20:00:00Z')
const pedido = (extra: Partial<Parameters<typeof decidirConfirmacion>[0] & object> = {}) => ({
  tipo: 'delivery', estado: 'pending', telefono: null, createdAt: new Date(ahora - 60_000), whatsappConfirmadoAt: null, ...extra,
})

describe('decidirConfirmacion', () => {
  test('sin número en el pedido, lo completa con el del mensaje', () => {
    expect(decidirConfirmacion(pedido(), '5491112345678', ahora)).toBe('completar')
  })
  test('con número cargado sólo confirma, no lo pisa', () => {
    expect(decidirConfirmacion(pedido({ telefono: '1199998888' }), '5491112345678', ahora)).toBe('confirmar')
  })
  test('ignora pedidos ya confirmados, viejos, cancelados, de mesa o inexistentes', () => {
    expect(decidirConfirmacion(pedido({ whatsappConfirmadoAt: new Date() }), '5491112345678', ahora)).toBe('ignorar')
    expect(decidirConfirmacion(pedido({ createdAt: new Date(ahora - VENTANA_CONFIRMACION_MS - 1) }), '5491112345678', ahora)).toBe('ignorar')
    expect(decidirConfirmacion(pedido({ estado: 'cancelled' }), '5491112345678', ahora)).toBe('ignorar')
    expect(decidirConfirmacion(pedido({ tipo: 'mesa' }), '5491112345678', ahora)).toBe('ignorar')
    expect(decidirConfirmacion(null, '5491112345678', ahora)).toBe('ignorar')
  })
})

test('mismaLinea compara los últimos 10 dígitos', () => {
  expect(mismaLinea('+54 9 11 1234-5678', '1112345678')).toBe(true)
  expect(mismaLinea('5491112345678', '5491112345679')).toBe(false)
})

test('el día del tope empieza a medianoche de Argentina', () => {
  expect(inicioDelDiaAr(Date.parse('2026-11-25T02:00:00Z')).toISOString()).toBe('2026-11-24T03:00:00.000Z')
  expect(inicioDelDiaAr(Date.parse('2026-11-25T04:00:00Z')).toISOString()).toBe('2026-11-25T03:00:00.000Z')
})
