import { expect, test } from 'bun:test'
import { resolverEstadoPorTiempo } from './suscripcion-estado'

const AHORA = new Date('2026-08-14T12:00:00.000Z')

test('la baja de la suscripción conserva el período ya pago y luego cancela', () => {
  const base = {
    estado: 'activa' as const,
    fechaProximoCobro: new Date('2026-09-01T00:00:00.000Z'),
    graciaHasta: null,
  }
  expect(resolverEstadoPorTiempo({ ...base, fechaCancelacion: new Date('2026-09-01T00:00:00.000Z') }, AHORA).estado).toBe('activa')
  expect(resolverEstadoPorTiempo({ ...base, fechaCancelacion: new Date('2026-08-14T12:00:00.000Z') }, AHORA).estado).toBe('cancelada')
})

test('el vencimiento pasa por gracia antes de suspender', () => {
  const sub = {
    estado: 'activa' as const,
    fechaProximoCobro: new Date('2026-08-10T00:00:00.000Z'),
    graciaHasta: null,
    fechaCancelacion: null,
  }
  expect(resolverEstadoPorTiempo(sub, AHORA).estado).toBe('pago_pendiente')
  expect(resolverEstadoPorTiempo({ ...sub, graciaHasta: new Date('2026-08-12T00:00:00.000Z') }, AHORA).estado).toBe('suspendida')
})
