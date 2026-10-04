import { expect, test } from 'bun:test'
import {
  calcularComision,
  esFacturaComisionable,
  generarComision,
  sincronizarComisiones,
  type RepositorioComisiones,
} from './comisiones-marketer'
test('comisiona base y módulos, excluye recargas y redondea centavos', () => {
  expect(
    calcularComision(
      [
        { tipo: 'base', monto: '100.03' },
        { tipo: 'modulo', monto: '50.00' },
        { tipo: 'pack_mensajes', monto: 999 },
      ],
      20,
    ),
  ).toEqual({ baseComisionable: 150.03, porcentaje: 20, monto: 30.01 })
  expect(() => calcularComision([], 101)).toThrow()
  expect(() => calcularComision([{ tipo: 'base', monto: -1 }], 20)).toThrow()
})
test('excluye facturas anteriores al vínculo, trial, marketer inactivo y acceso revocado', () => {
  const factura = { estado: 'paid', createdAt: '2026-10-03T12:00:00Z' }
  const vinculo = {
    estado: 'activo',
    activadoAt: '2026-10-01T12:00:00Z',
    marketerActivo: true,
  }
  expect(esFacturaComisionable(factura, vinculo)).toBe(true)
  expect(
    esFacturaComisionable(factura, {
      ...vinculo,
      activadoAt: '2026-10-04T12:00:00Z',
    }),
  ).toBe(false)
  expect(
    esFacturaComisionable({ ...factura, estado: 'pending' }, vinculo),
  ).toBe(false)
  expect(
    esFacturaComisionable(factura, { ...vinculo, marketerActivo: false }),
  ).toBe(false)
  expect(
    esFacturaComisionable(factura, { ...vinculo, estado: 'revocado' }),
  ).toBe(false)
  expect(esFacturaComisionable(factura, null)).toBe(false)
})
test('reintentos concurrentes y conciliación conservan un asiento congelado por factura', async () => {
  const filas = new Map<number, unknown>()
  const repo: RepositorioComisiones = {
    obtenerFuente: async (id) => ({
      factura: { id, restauranteId: 6, estado: 'paid', createdAt: new Date() },
      vinculo: {
        marketerId: 3,
        estado: 'activo',
        activadoAt: '2026-01-01',
        marketerActivo: true,
        porcentaje: 25,
      },
      items: [{ tipo: 'base', monto: 100 }],
    }),
    insertarUnica: async (asiento) => {
      if (filas.has(asiento.pagoSuscripcionId)) return false
      filas.set(asiento.pagoSuscripcionId, asiento)
      return true
    },
    pendientesDeConciliar: async () => [1, 2],
  }
  const resultados = await Promise.all([
    generarComision(repo, 1),
    generarComision(repo, 1),
  ])
  expect(resultados.filter(Boolean)).toHaveLength(1)
  expect(await sincronizarComisiones(repo)).toEqual({ creadas: 1, fallidas: 0 })
  expect(await sincronizarComisiones(repo)).toEqual({ creadas: 0, fallidas: 0 })
  expect(filas.get(1)).toMatchObject({
    porcentaje: '25.00',
    monto: '25.00',
    baseComisionable: '100.00',
  })
})
test('conciliación continúa otras facturas y avisa los fallos para reintentarlos', async () => {
  const repo: RepositorioComisiones = {
    obtenerFuente: async (id) => {
      if (id === 1) throw new Error('Fallo transitorio')
      return {
        factura: {
          id,
          restauranteId: 6,
          estado: 'paid',
          createdAt: new Date(),
        },
        vinculo: {
          marketerId: 3,
          estado: 'activo',
          activadoAt: '2026-01-01',
          marketerActivo: true,
          porcentaje: 20,
        },
        items: [{ tipo: 'base', monto: 100 }],
      }
    },
    insertarUnica: async () => true,
    pendientesDeConciliar: async () => [1, 2],
  }
  expect(await sincronizarComisiones(repo)).toEqual({ creadas: 1, fallidas: 1 })
})
