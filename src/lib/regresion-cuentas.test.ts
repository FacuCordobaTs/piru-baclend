import { describe, expect, test } from 'bun:test'
import { moduloEstaActivoAhora, sumarCuposMensajesDeModulos } from './modulos'
import { tieneAccesoAlPanelSuscripcion, type SuscripcionUnicaResuelta } from './suscripcion'

const AHORA = new Date('2026-08-15T12:00:00.000Z')

function suscripcion(estado: SuscripcionUnicaResuelta['estado']): SuscripcionUnicaResuelta {
  const existe = estado !== null
  return {
    suscripcionId: existe ? 1 : null,
    configuracion: null,
    estado,
    ciclo: existe ? 'mensual' : null,
    fechaInicio: null,
    trialFin: null,
    fechaProximoCobro: null,
    graciaHasta: null,
    fechaCancelacion: null,
    precioBaseMensual: null,
    montoModulosMensual: null,
    montoTotalMensual: null,
    conAccesoAPago: estado === 'trial' || estado === 'activa' || estado === 'pago_pendiente',
    sinSuscripcion: !existe,
    // Los aliases no intervienen en las decisiones de esta matriz.
    planId: null,
    planCodigo: null,
    planNombre: null,
  }
}

const AVISOS = {
  tipo: 'pago' as const,
  estado: 'activo' as const,
  origen: 'usuario' as const,
  precioMensualCongelado: '30000.00',
  vigenteHasta: null,
}

const MOTOR = {
  ...AVISOS,
  precioMensualCongelado: '70000.00',
}

function activo(modulo: typeof AVISOS, estadoSuscripcion: SuscripcionUnicaResuelta['estado']) {
  return moduloEstaActivoAhora({ ...modulo, estadoSuscripcion }, AHORA)
}

describe('T41 · matriz de regresión de cuentas', () => {
  test('Alfajor migrado requiere suscripción y factura Avisos como cualquier cuenta nueva', () => {
    expect(tieneAccesoAlPanelSuscripcion(true, suscripcion(null))).toBe(false)
    expect(moduloEstaActivoAhora({
      ...AVISOS,
      origen: 'migracion',
      precioMensualCongelado: '30000.00',
      estadoSuscripcion: null,
    }, AHORA)).toBe(false)
    expect(moduloEstaActivoAhora({
      ...AVISOS,
      tipo: 'incluido',
      estado: 'inactivo',
      origen: null,
      precioMensualCongelado: null,
      estadoSuscripcion: null,
    }, AHORA)).toBe(false)
    expect(activo(MOTOR, null)).toBe(false)
    expect(sumarCuposMensajesDeModulos([
      { activoAhora: false, mensajesUtilityIncluidos: 200, mensajesMarketingIncluidos: 0 },
      { activoAhora: false, mensajesUtilityIncluidos: 0, mensajesMarketingIncluidos: 100 },
    ])).toEqual({ utility: 0, marketing: 0 })
  })

  test('una cuenta nueva sin pagar no entra al panel ni obtiene módulos', () => {
    expect(tieneAccesoAlPanelSuscripcion(true, suscripcion(null))).toBe(false)
    expect(activo(AVISOS, null)).toBe(false)
    expect(activo(MOTOR, null)).toBe(false)
  })

  test('trial habilita la base pero nunca módulos pagos', () => {
    expect(tieneAccesoAlPanelSuscripcion(true, suscripcion('trial'))).toBe(true)
    expect(activo(AVISOS, 'trial')).toBe(false)
    expect(activo(MOTOR, 'trial')).toBe(false)
  })

  test('activa sin módulos conserva sólo la base', () => {
    expect(tieneAccesoAlPanelSuscripcion(true, suscripcion('activa'))).toBe(true)
    expect(moduloEstaActivoAhora({
      ...AVISOS,
      estado: 'inactivo',
      estadoSuscripcion: 'activa',
    }, AHORA)).toBe(false)
    expect(moduloEstaActivoAhora({
      ...MOTOR,
      estado: 'inactivo',
      estadoSuscripcion: 'activa',
    }, AHORA)).toBe(false)
  })

  test('cada módulo pago aporta únicamente su cupo al estar activo', () => {
    expect(activo(AVISOS, 'activa')).toBe(true)
    expect(activo(MOTOR, 'activa')).toBe(true)
    expect(sumarCuposMensajesDeModulos([
      { activoAhora: activo(AVISOS, 'activa'), mensajesUtilityIncluidos: 200, mensajesMarketingIncluidos: 0 },
      { activoAhora: false, mensajesUtilityIncluidos: 0, mensajesMarketingIncluidos: 100 },
    ])).toEqual({ utility: 200, marketing: 0 })
    expect(sumarCuposMensajesDeModulos([
      { activoAhora: false, mensajesUtilityIncluidos: 200, mensajesMarketingIncluidos: 0 },
      { activoAhora: activo(MOTOR, 'activa'), mensajesUtilityIncluidos: 0, mensajesMarketingIncluidos: 100 },
    ])).toEqual({ utility: 0, marketing: 100 })
  })

  test('la gracia conserva base y módulos pagos vigentes', () => {
    expect(tieneAccesoAlPanelSuscripcion(true, suscripcion('pago_pendiente'))).toBe(true)
    expect(activo(AVISOS, 'pago_pendiente')).toBe(true)
    expect(activo(MOTOR, 'pago_pendiente')).toBe(true)
  })

  test.each(['suspendida', 'cancelada'] as const)('%s bloquea panel y módulos', (estado) => {
    expect(tieneAccesoAlPanelSuscripcion(true, suscripcion(estado))).toBe(false)
    expect(activo(AVISOS, estado)).toBe(false)
    expect(activo(MOTOR, estado)).toBe(false)
  })

  test('una suscripción reactivada vuelve a habilitar sólo los entitlements vigentes', () => {
    expect(tieneAccesoAlPanelSuscripcion(true, suscripcion('activa'))).toBe(true)
    expect(activo(AVISOS, 'activa')).toBe(true)
    expect(moduloEstaActivoAhora({
      ...MOTOR,
      estado: 'cancelacion_programada',
      vigenteHasta: AHORA,
      estadoSuscripcion: 'activa',
    }, AHORA)).toBe(false)
  })
})
