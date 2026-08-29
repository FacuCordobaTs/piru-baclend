import { describe, expect, test } from 'bun:test'
import {
  listadoHabilitaModulo,
  moduloEstaActivoAhora,
  MODULE_KEYS,
  resolverModulosFacturablesDeListado,
  resolverRepresentacionCanonicaCrecimiento,
  sumarCuposMensajesDeModulos,
} from './modulos'

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
      { codigo: MODULE_KEYS.AVISOS_AUTOMATICOS_WHATSAPP, activoAhora: true, mensajesUtilityIncluidos: 200, mensajesMarketingIncluidos: 0 },
      { codigo: MODULE_KEYS.MOTOR_RECOMPRA, activoAhora: true, mensajesUtilityIncluidos: 0, mensajesMarketingIncluidos: 100 },
      { codigo: MODULE_KEYS.POS, activoAhora: false, mensajesUtilityIncluidos: 999, mensajesMarketingIncluidos: 999 },
    ])).toEqual({ utility: 200, marketing: 100 })
  })

  test('Crecimiento acepta su entitlement directo y el alias legacy activo', () => {
    expect(listadoHabilitaModulo([
      { codigo: MODULE_KEYS.CRECIMIENTO, activoAhora: true },
    ], MODULE_KEYS.CRECIMIENTO)).toBe(true)
    expect(listadoHabilitaModulo([
      { codigo: MODULE_KEYS.MOTOR_RECOMPRA, activoAhora: true },
    ], MODULE_KEYS.CRECIMIENTO)).toBe(true)
  })

  test('el alias es unidireccional y no activa un gate legacy', () => {
    expect(listadoHabilitaModulo([
      { codigo: MODULE_KEYS.CRECIMIENTO, activoAhora: true },
    ], MODULE_KEYS.MOTOR_RECOMPRA)).toBe(false)
  })

  test('trial, suspensión y vencimiento bloquean también el acceso por alias', () => {
    for (const politica of [
      { ...BASE, estadoSuscripcion: 'trial' as const },
      { ...BASE, estadoSuscripcion: 'suspendida' as const },
      { ...BASE, estadoSuscripcion: 'activa' as const, vigenteHasta: AHORA },
    ]) {
      expect(listadoHabilitaModulo([
        {
          codigo: MODULE_KEYS.MOTOR_RECOMPRA,
          activoAhora: moduloEstaActivoAhora(politica, AHORA),
        },
      ], MODULE_KEYS.CRECIMIENTO)).toBe(false)
    }
  })

  test('dos entitlements del mismo servicio no duplican cupos ni importe mensual', () => {
    expect(listadoHabilitaModulo([
      { codigo: MODULE_KEYS.MOTOR_RECOMPRA, activoAhora: true },
      { codigo: MODULE_KEYS.CRECIMIENTO, activoAhora: true },
    ], MODULE_KEYS.CRECIMIENTO)).toBe(true)

    expect(sumarCuposMensajesDeModulos([
      { codigo: MODULE_KEYS.MOTOR_RECOMPRA, activoAhora: true, mensajesUtilityIncluidos: 0, mensajesMarketingIncluidos: 100 },
      { codigo: MODULE_KEYS.CRECIMIENTO, activoAhora: true, mensajesUtilityIncluidos: 0, mensajesMarketingIncluidos: 0 },
    ])).toEqual({ utility: 0, marketing: 0 })

    expect(resolverModulosFacturablesDeListado([
      { codigo: MODULE_KEYS.MOTOR_RECOMPRA, tipo: 'pago', estado: 'activo', precioMensual: '70000.00', precioMensualCongelado: '70000.00' },
      { codigo: MODULE_KEYS.CRECIMIENTO, tipo: 'pago', estado: 'activo', precioMensual: '70000.00', precioMensualCongelado: '70000.00' },
    ])).toEqual([{ codigo: MODULE_KEYS.CRECIMIENTO, montoMensual: 70000 }])
  })

  test('el catálogo muestra Crecimiento y oculta la representación legacy', () => {
    const crecimiento = { codigo: MODULE_KEYS.CRECIMIENTO, nombre: 'Crecimiento' }
    expect(resolverRepresentacionCanonicaCrecimiento([
      { codigo: MODULE_KEYS.MOTOR_RECOMPRA, nombre: 'Motor de Recompra' },
      crecimiento,
      { codigo: MODULE_KEYS.POS, nombre: 'Punto de venta' },
    ])).toEqual([
      crecimiento,
      { codigo: MODULE_KEYS.POS, nombre: 'Punto de venta' },
    ])
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
