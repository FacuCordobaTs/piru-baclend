import { describe, expect, test } from 'bun:test'
import { moduloEstaActivoAhora, sumarCuposMensajesDeModulos } from './modulos'

const AHORA = new Date('2026-08-14T12:00:00.000Z')
const BASE = {
  tipo: 'pago' as const,
  estado: 'activo' as const,
  origen: 'usuario' as const,
  precioMensualCongelado: '30000.00',
  vigenteHasta: null,
}

describe('matriz de acceso de módulos', () => {
  test('los cupos de mensajes salen sólo de módulos activos', () => {
    expect(sumarCuposMensajesDeModulos([
      { activoAhora: true, mensajesUtilityIncluidos: 200, mensajesMarketingIncluidos: 0 },
      { activoAhora: true, mensajesUtilityIncluidos: 0, mensajesMarketingIncluidos: 100 },
      { activoAhora: false, mensajesUtilityIncluidos: 999, mensajesMarketingIncluidos: 999 },
    ])).toEqual({ utility: 200, marketing: 100 })
  })

  test('un entitlement legacy no evita el requisito de suscripción', () => {
    expect(moduloEstaActivoAhora({
      ...BASE,
      origen: 'legacy',
      precioMensualCongelado: '0.00',
      estadoSuscripcion: null,
    }, AHORA)).toBe(false)
    expect(moduloEstaActivoAhora({ ...BASE, estadoSuscripcion: null }, AHORA)).toBe(false)
  })

  test('el trial incluye sólo la base, incluso ante una fila paga activa', () => {
    expect(moduloEstaActivoAhora({ ...BASE, estadoSuscripcion: 'trial' }, AHORA)).toBe(false)
  })

  test.each(['activa', 'pago_pendiente'] as const)('%s habilita un módulo pago sólo con fila activa', (estadoSuscripcion) => {
    expect(moduloEstaActivoAhora({ ...BASE, estado: 'pendiente_pago', estadoSuscripcion }, AHORA)).toBe(false)
    expect(moduloEstaActivoAhora({ ...BASE, estadoSuscripcion }, AHORA)).toBe(true)
  })

  test.each(['suspendida', 'cancelada'] as const)('%s bloquea módulos pagos e incluidos cuando hay suscripción', (estadoSuscripcion) => {
    expect(moduloEstaActivoAhora({ ...BASE, estadoSuscripcion }, AHORA)).toBe(false)
    expect(moduloEstaActivoAhora({
      ...BASE,
      tipo: 'incluido',
      precioMensualCongelado: null,
      estadoSuscripcion,
    }, AHORA)).toBe(false)
  })

  test('un módulo incluido optado funciona sin suscripción para grandfathered', () => {
    expect(moduloEstaActivoAhora({
      ...BASE,
      tipo: 'incluido',
      precioMensualCongelado: null,
      estadoSuscripcion: null,
    }, AHORA)).toBe(true)
  })

  test('una cancelación programada sigue vigente hasta la fecha pagada', () => {
    expect(moduloEstaActivoAhora({
      ...BASE,
      estado: 'cancelacion_programada',
      vigenteHasta: new Date('2026-08-15T00:00:00.000Z'),
      estadoSuscripcion: 'activa',
    }, AHORA)).toBe(true)
    expect(moduloEstaActivoAhora({
      ...BASE,
      estado: 'cancelacion_programada',
      vigenteHasta: AHORA,
      estadoSuscripcion: 'activa',
    }, AHORA)).toBe(false)
    expect(moduloEstaActivoAhora({
      ...BASE,
      estado: 'cancelacion_programada',
      vigenteHasta: new Date('2026-08-13T23:59:59.000Z'),
      estadoSuscripcion: 'activa',
    }, AHORA)).toBe(false)
  })

  test('un módulo pago vencido no conserva acceso aunque la fila siga activa', () => {
    expect(moduloEstaActivoAhora({
      ...BASE,
      vigenteHasta: new Date('2026-08-13T23:59:59.000Z'),
      estadoSuscripcion: 'activa',
    }, AHORA)).toBe(false)
  })
})
