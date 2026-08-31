import { describe, expect, test } from 'bun:test'
import { resumirResultadosMarketing, type DatosResultadosMarketing } from './marketing-resultados'

const fecha = (dia: number) => new Date(`2026-08-${String(dia).padStart(2, '0')}T12:00:00.000Z`)
const datos: DatosResultadosMarketing = {
  pedidos: [
    { id: 1, clienteId: 10, sucursalId: 1, total: '100', montoDescuento: '10', createdAt: fecha(1), pagado: true },
    { id: 2, clienteId: 10, sucursalId: 1, total: '200', montoDescuento: '0', createdAt: fecha(2), pagado: true },
    { id: 3, clienteId: 11, sucursalId: 2, total: '300', montoDescuento: '20', createdAt: fecha(2), pagado: true },
    { id: 4, clienteId: 12, sucursalId: 1, total: '900', montoDescuento: '0', createdAt: fecha(2), pagado: false },
  ],
  campanas: [{ id: 7, nombre: 'Instagram', slug: 'ig', tipo: 'adquisicion', productoId: 50, inversionManual: '50', usaGrupoControl: true }],
  atribuciones: [
    { pedidoUnificadoId: 1, campanaId: 7, recetaCodigo: null, revenueAtribuido: '100', descuentoAtribuido: '10', createdAt: fecha(1) },
    { pedidoUnificadoId: 2, campanaId: 7, recetaCodigo: 'segunda_compra', revenueAtribuido: '200', descuentoAtribuido: '0', createdAt: fecha(2) },
  ],
  sesiones: [
    { id: 1, firstTouchTipo: 'campana', lastTouchTipo: 'campana', firstTouchCampanaId: 7, lastTouchCampanaId: 7, createdAt: fecha(1) },
    { id: 2, firstTouchTipo: 'directo', lastTouchTipo: 'directo', firstTouchCampanaId: null, lastTouchCampanaId: null, createdAt: fecha(2) },
  ],
  eventos: [
    { id: 1, marketingSesionId: 1, tipo: 'session_start', ocurridoAt: fecha(1) }, { id: 2, marketingSesionId: 1, tipo: 'purchase', ocurridoAt: fecha(1) },
    { id: 3, marketingSesionId: 2, tipo: 'session_start', ocurridoAt: fecha(2) },
    { id: 4, marketingSesionId: 2, tipo: 'purchase', pedidoUnificadoId: 3, ocurridoAt: fecha(2) },
    { id: 5, marketingSesionId: 1, tipo: 'add_to_cart', productoId: 50, ocurridoAt: fecha(1) },
    { id: 6, marketingSesionId: 1, tipo: 'add_to_cart', productoId: 51, ocurridoAt: fecha(1) },
    { id: 7, marketingSesionId: 1, tipo: 'add_to_cart', productoId: 51, ocurridoAt: fecha(1) },
  ],
  enlaces: [{ id: 1, campanaId: 7, recetaCodigo: null, createdAt: fecha(1) }],
  contactos: [{ id: 1, enlaceId: 1, canal: 'piru_whatsapp', estado: 'enviado', costoMensajes: '1', createdAt: fecha(2) }],
  oportunidades: [{ segmento: 'dormido', recetaCodigo: 'recuperar_habito' }],
}

describe('resumirResultadosMarketing', () => {
  test('concilia ventas pagadas sin contar dos veces atribución, eventos ni POS', () => {
    const resumen = resumirResultadosMarketing(datos)
    expect(resumen.metricas).toMatchObject({ ventas: 600, pedidos: 3, ticketPromedio: 200, revenueAtribuido: 300, descuentos: 30, costoMensajes: 1, inversionManual: 50, costoTotal: 61, retorno: 239 })
    // Las compras se concilian contra pedidos cobrados; no dependen de que el
    // navegador haya logrado entregar el evento analítico.
    expect(resumen.funnel).toMatchObject({ session_start: 2, purchase: 3 })
    expect(resumen.oportunidades).toMatchObject({ total: 1, porSegmento: { dormido: 1 } })
  })

  test('filtra campaña sin confundir atribuido con incremental ni incluir ventas POS/directas', () => {
    const resumen = resumirResultadosMarketing(datos, { campaniaId: 7, sucursalId: 1 })
    expect(resumen.metricas).toMatchObject({ ventas: 300, pedidos: 2, revenueAtribuido: 300, clientesNuevos: 1, clientesRecurrentes: 0 })
    expect(resumen.funnel).toMatchObject({ add_to_cart: 1, add_other_product: 1 })
    expect(resumen.incremental).toMatchObject({ disponible: false })
    expect(resumen.campanas[0]).toMatchObject({ id: 7, incremental: { disponible: false } })
  })

  test('aplica fecha a ventas y contactos sin perder el enlace creado antes', () => {
    const resumen = resumirResultadosMarketing(datos, { from: fecha(2), to: fecha(2) })
    expect(resumen.metricas).toMatchObject({ ventas: 500, pedidos: 2, contactos: 1, costoMensajes: 1 })
  })

  test('trata el tráfico orgánico como una vista virtual sin inventar una campaña', () => {
    const resumen = resumirResultadosMarketing(datos, { fuente: 'organico' })
    expect(resumen.metricas).toMatchObject({ ventas: 300, pedidos: 1, sesiones: 1, conversion: 100, revenueAtribuido: 0, inversionManual: 0 })
    expect(resumen.funnel).toMatchObject({ session_start: 1, purchase: 1 })
    expect(resumen.campanas).toEqual([])
  })

  test('arma el embudo por campana_id y sesion_uuid cuando la sesión SQL no se materializó', () => {
    const sinSesion: DatosResultadosMarketing = {
      ...datos,
      pedidos: [],
      atribuciones: [],
      sesiones: [],
      contactos: [],
      enlaces: [],
      oportunidades: [],
      eventos: [
        { id: 20, marketingSesionId: null, sesionUuid: 'fallback-1', campanaId: 7, tipo: 'session_start', ocurridoAt: fecha(1) },
        { id: 21, marketingSesionId: null, sesionUuid: 'fallback-1', campanaId: 7, tipo: 'add_to_cart', productoId: 50, ocurridoAt: fecha(1) },
        { id: 22, marketingSesionId: null, sesionUuid: 'fallback-1', campanaId: 7, tipo: 'checkout_start', ocurridoAt: fecha(1) },
      ],
    }

    const resumen = resumirResultadosMarketing(sinSesion, { campaniaId: 7 })
    expect(resumen.metricas.sesiones).toBe(1)
    expect(resumen.funnel).toMatchObject({ session_start: 1, add_to_cart: 1, checkout_start: 1 })
  })
})
