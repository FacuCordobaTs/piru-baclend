import { expect, test } from 'bun:test'
import {
  importePorCiclo,
  importeProrrateado,
  inicioPeriodoFactura,
  seleccionarModulosFacturables,
  sumarMesesCalendario,
} from './facturacion-suscripcion'

test('aplica descuento anual a cada componente y redondea al peso', () => {
  expect(importePorCiclo(20_000, 'anual', 20)).toBe(192_000)
  expect(importePorCiclo(30_000, 'anual', 20)).toBe(288_000)
})

test('prorratea por días calendario restantes del ciclo', () => {
  const desde = new Date('2026-08-16T00:00:00.000Z')
  const hasta = new Date('2026-09-01T00:00:00.000Z')
  expect(importeProrrateado(30_000, 'mensual', 20, desde, hasta)).toBe(15_484)
})

test('conserva fin de mes al calcular período', () => {
  expect(sumarMesesCalendario(new Date('2026-01-31T00:00:00.000Z'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z')
})

test('una renovación anticipada comienza al terminar el período ya pagado', () => {
  const ahora = new Date('2026-08-14T00:00:00.000Z')
  expect(inicioPeriodoFactura(ahora, {
    estado: 'activa', fechaProximoCobro: new Date('2026-09-01T00:00:00.000Z'),
  }).toISOString()).toBe('2026-09-01T00:00:00.000Z')
  expect(inicioPeriodoFactura(ahora, {
    estado: 'suspendida', fechaProximoCobro: new Date('2026-09-01T00:00:00.000Z'),
  }).toISOString()).toBe(ahora.toISOString())
  const inicioRenovacion = inicioPeriodoFactura(ahora, {
    estado: 'activa', fechaProximoCobro: new Date('2026-09-01T00:00:00.000Z'),
  })
  expect(sumarMesesCalendario(inicioRenovacion, 1).toISOString()).toBe('2026-10-01T00:00:00.000Z')
})

test('el checkout de fin de trial factura sólo la suscripción base', () => {
  const modulos = [
    { codigo: 'avisos_automaticos_whatsapp', estado: 'activo', origen: 'usuario' },
    { codigo: 'motor_recompra', estado: 'activo', origen: 'usuario' },
  ]
  expect(seleccionarModulosFacturables(modulos, { soloBase: true })).toEqual([])
  expect(seleccionarModulosFacturables(modulos, {})).toEqual(modulos)
})

test('un módulo activo migrado se incluye en el primer checkout', () => {
  const modulos = [{ codigo: 'avisos_automaticos_whatsapp', estado: 'activo', origen: 'migracion' }]
  expect(seleccionarModulosFacturables(modulos, {})).toEqual(modulos)
})

test('Crecimiento reemplaza al Motor legacy sin duplicar la factura', () => {
  const modulos = [
    { codigo: 'avisos_automaticos_whatsapp', estado: 'activo', origen: 'usuario' },
    { codigo: 'motor_recompra', estado: 'activo', origen: 'migracion' },
    { codigo: 'crecimiento', estado: 'activo', origen: 'migracion' },
  ]
  expect(seleccionarModulosFacturables(modulos, {})).toEqual([
    modulos[0],
    modulos[2],
  ])
})

test('una cuenta aún no migrada sigue facturando su Motor legacy', () => {
  const modulos = [{ codigo: 'motor_recompra', estado: 'activo', origen: 'legacy' }]
  expect(seleccionarModulosFacturables(modulos, {})).toEqual(modulos)
})
