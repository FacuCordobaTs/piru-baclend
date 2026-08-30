import { describe, expect, test } from 'bun:test'
import { resolverDatosGrowthClientes } from './clientes-growth'

const fecha = (dia: number) => new Date(`2026-08-${String(dia).padStart(2, '0')}T12:00:00.000Z`)

describe('resolverDatosGrowthClientes', () => {
  test('expone adquisición sólo para la primera compra y acumula las acciones de receta', () => {
    const datos = resolverDatosGrowthClientes(
      [{ id: 10 }, { id: 11 }],
      [
        { id: 1, clienteId: 10, total: '120', createdAt: fecha(1) },
        { id: 2, clienteId: 10, total: '300', createdAt: fecha(5) },
        { id: 3, clienteId: 11, total: '80', createdAt: fecha(3) },
      ],
      [
        { pedidoUnificadoId: 1, campanaId: 7, origen: 'campana', recetaCodigo: null, revenueAtribuido: '120', createdAt: fecha(1) },
        { pedidoUnificadoId: 2, campanaId: null, origen: 'receta', recetaCodigo: 'mantene_ritmo', revenueAtribuido: '300', createdAt: fecha(5) },
        // Una campaña posterior no debe reescribir una adquisición orgánica.
        { pedidoUnificadoId: 3, campanaId: 7, origen: 'campana', recetaCodigo: null, revenueAtribuido: '80', createdAt: fecha(3) },
      ],
      [{ id: 7, nombre: 'Instagram agosto', slug: 'instagram-agosto' }],
      [{ cliente: { id: 10 }, receta: { codigo: 'mantene_ritmo' }, ultimoEnlacePreparado: { id: 44 } }],
      {
        pedidoIdsOrganicos: new Set([3]),
        cupones: [{ id: 5, codigo: 'VOLVE10', tipo: 'porcentaje', valor: '10' }],
      },
    )

    expect(datos.get(10)).toMatchObject({
      fuenteAdquisicion: 'campana',
      campanaAdquisicion: { id: 7, nombre: 'Instagram agosto', slug: 'instagram-agosto' },
      primeraCompra: { pedidoId: 1, revenue: 120 },
      revenueHistorico: 420,
      recetaRecomendada: { codigo: 'mantene_ritmo' },
      enlacePreparado: { id: 44 },
      revenueAcciones: 300,
    })
    expect(datos.get(11)).toMatchObject({ fuenteAdquisicion: 'campana', revenueHistorico: 80, revenueAcciones: 0, actividadOrganica: { pedidos: 1, facturacion: 80 } })
  })

  test('mantiene defaults seguros para clientes sin historial ni tracking', () => {
    const datos = resolverDatosGrowthClientes([{ id: 99 }], [], [], [], [])
    expect(datos.get(99)).toEqual({
      fuenteAdquisicion: null,
      campanaAdquisicion: null,
      primeraCompra: null,
      revenueHistorico: 0,
      recetaRecomendada: null,
      enlacePreparado: null,
      revenueAcciones: 0,
      campanasParticipadas: [],
      cuponesUsados: [],
      actividadOrganica: null,
    })
  })

  test('expone campañas, cupones y adquisición orgánica sin consultas por cliente', () => {
    const datos = resolverDatosGrowthClientes(
      [{ id: 10 }],
      [
        { id: 1, clienteId: 10, total: '90', codigoDescuentoId: 5, montoDescuento: '10', createdAt: fecha(1) },
        { id: 2, clienteId: 10, total: '200', codigoDescuentoId: 5, montoDescuento: '20', createdAt: fecha(5) },
      ],
      [{ pedidoUnificadoId: 2, campanaId: 7, origen: 'campana', recetaCodigo: null, revenueAtribuido: '200', createdAt: fecha(5) }],
      [{ id: 7, nombre: 'Instagram', slug: 'instagram' }],
      [],
      { pedidoIdsOrganicos: new Set([1]), cupones: [{ id: 5, codigo: 'BIENVENIDA', tipo: 'porcentaje', valor: '10' }] },
    )
    expect(datos.get(10)).toMatchObject({
      fuenteAdquisicion: 'organico',
      campanasParticipadas: [{ id: 7, pedidos: 1, revenueAtribuido: 200 }],
      cuponesUsados: [{ id: 5, usos: 2, facturacion: 290, montoDescontado: 30 }],
      actividadOrganica: { pedidos: 1, facturacion: 90 },
    })
  })
})
