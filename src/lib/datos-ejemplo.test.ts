import { describe, expect, test } from 'bun:test'
import {
  MARCA_EJEMPLO,
  PORCENTAJE_CUPON,
  SEGMENTOS_ESPERADOS,
  diaSemanaAR,
  inicioDiaAR,
  planificarDatosEjemplo,
  type ProductoEjemplo,
} from './datos-ejemplo'
import { computarPerfilesRFM } from './clientes-rfm'
import { calcularDiasFlojos } from './dias-flojos'
import { normalizarTelefonoCliente } from './clientes-identidad'

const PRODUCTOS: ProductoEjemplo[] = [
  { id: 11, nombre: 'Smash simple', precio: 9500, variante: null, varianteSecundaria: null },
  { id: 12, nombre: 'Smash doble', precio: 12500, variante: { id: 101, nombre: 'Doble', precio: 12500 }, varianteSecundaria: null },
  { id: 13, nombre: 'Papas con cheddar', precio: 6500, variante: null, varianteSecundaria: null },
  { id: 14, nombre: 'Combo', precio: 15000, variante: { id: 102, nombre: 'Mediano', precio: 15000 }, varianteSecundaria: { id: 201, nombre: 'Con bacon', precio: 1500 } },
  { id: 15, nombre: 'Gaseosa 1,5 L', precio: 4000, variante: null, varianteSecundaria: null },
  { id: 16, nombre: 'Nuggets', precio: 7200, variante: null, varianteSecundaria: null },
]

const AHORA = new Date('2026-10-12T15:30:00-03:00')
const DIA_MS = 86_400_000

const plan = (ahora = AHORA, extra = {}) => planificarDatosEjemplo({ ahora, productos: PRODUCTOS, envio: 1500, ...extra })

describe('el día argentino', () => {
  test('la medianoche y el día de la semana salen de UTC-3', () => {
    // Lunes 12/10/2026, 00:30 en Argentina = 03:30 UTC.
    const ms = Date.parse('2026-10-12T03:30:00Z')
    expect(new Date(inicioDiaAR(ms)).toISOString()).toBe('2026-10-12T03:00:00.000Z')
    expect(diaSemanaAR(ms)).toBe(1)
    // Un minuto antes (domingo 23:59 AR).
    expect(diaSemanaAR(Date.parse('2026-10-12T02:59:00Z'))).toBe(0)
    expect(new Date(inicioDiaAR(Date.parse('2026-10-12T02:59:00Z'))).toISOString()).toBe('2026-10-11T03:00:00.000Z')
  })
})

describe('el plan de los datos de ejemplo', () => {
  test('todo lo que ve el dueño lleva la marca EJEMPLO', () => {
    const p = plan()
    expect(p.clientes).toHaveLength(16)
    for (const c of p.clientes) expect(c.nombre.endsWith(` ${MARCA_EJEMPLO}`), c.nombre).toBe(true)
    expect(p.clientes.map((c) => c.nombre)).toContain('Mateo EJEMPLO')
    for (const pedido of p.pedidos) expect(pedido.nombreCliente.endsWith(MARCA_EJEMPLO)).toBe(true)
    for (const campana of p.campanas) expect(campana.nombre).toContain(MARCA_EJEMPLO)
    expect(p.cupon.codigo).toBe(`${MARCA_EJEMPLO}${PORCENTAJE_CUPON}`)
  })

  test('los teléfonos no existen, no se repiten y se normalizan igual que el resto del sistema', () => {
    const p = plan()
    const normalizados = p.clientes.map((c) => c.telefonoNormalizado)
    expect(new Set(normalizados).size).toBe(16)
    for (const c of p.clientes) {
      expect(normalizarTelefonoCliente(c.telefono)).toBe(c.telefonoNormalizado)
      // Un abonado argentino no empieza con 0: nadie recibe un mensaje de la demo.
      expect(c.telefonoNormalizado.startsWith('549110000')).toBe(true)
    }
  })

  test('es determinista y nunca arma pedidos en el futuro', () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(plan()))
    const p = plan()
    for (const pedido of p.pedidos) expect(pedido.creadoAt.getTime()).toBeLessThan(AHORA.getTime())
    for (const s of p.sesiones) expect(s.creadoAt.getTime()).toBeLessThan(AHORA.getTime())
  })

  test('hoy hay pedidos en curso para mostrar en Inicio y el resto ya está despachado', () => {
    const p = plan()
    const hoy = inicioDiaAR(AHORA.getTime())
    const deHoy = p.pedidos.filter((x) => x.creadoAt.getTime() >= hoy)
    expect(deHoy.map((x) => x.estado).sort()).toEqual(['pending', 'preparing', 'received'])
    expect(deHoy.find((x) => x.estado === 'pending')?.pagado).toBe(false)
    for (const x of p.pedidos.filter((y) => y.creadoAt.getTime() < hoy)) {
      expect(x.estado).toBe('archived')
      expect(x.pagado).toBe(true)
    }
  })

  test('hoy es hoy aunque se siembre un minuto después de la medianoche', () => {
    const recien = new Date('2026-10-13T00:01:00-03:00')
    const p = plan(recien)
    const hoy = inicioDiaAR(recien.getTime())
    const deHoy = p.pedidos.filter((x) => x.creadoAt.getTime() >= hoy)
    expect(deHoy).toHaveLength(3)
    for (const x of deHoy) expect(x.creadoAt.getTime()).toBeLessThanOrEqual(recien.getTime())
  })

  test('los productos y los importes salen de la carta real', () => {
    const p = plan()
    const precios = new Map(PRODUCTOS.map((x) => [x.id, x]))
    for (const pedido of p.pedidos) {
      expect(pedido.items.length).toBeGreaterThan(0)
      for (const item of pedido.items) {
        const real = precios.get(item.productoId)!
        expect(real).toBeDefined()
        const esperado = (real.variante?.precio ?? real.precio) + (real.varianteSecundaria?.precio ?? 0)
        expect(item.precioUnitario).toBe(esperado)
        expect(item.varianteId).toBe(real.variante?.id ?? null)
      }
      const subtotal = pedido.items.reduce((s, i) => s + i.cantidad * i.precioUnitario, 0)
      expect(pedido.subtotal).toBeCloseTo(subtotal, 2)
      expect(pedido.total).toBeCloseTo(pedido.subtotal + pedido.envio - pedido.descuento, 2)
      expect(pedido.envio).toBe(pedido.tipo === 'delivery' ? 1500 : 0)
    }
  })

  test('sin productos con precio no hay con qué armar pedidos', () => {
    expect(() => planificarDatosEjemplo({ ahora: AHORA, productos: [] })).toThrow()
    expect(() =>
      planificarDatosEjemplo({ ahora: AHORA, productos: [{ ...PRODUCTOS[0], precio: 0 }] }),
    ).toThrow()
  })

  test('cada cliente cae en el segmento de su historia, cualquier día de la semana que se siembre', () => {
    for (let dia = 0; dia < 14; dia++) {
      const ahora = new Date(AHORA.getTime() + dia * DIA_MS)
      const p = plan(ahora)
      const perfiles = computarPerfilesRFM(
        p.clientes.map((c) => {
          const propios = p.pedidos.filter((x) => x.clienteClave === c.clave)
          return {
            cantidadPedidos: propios.length,
            totalGastado: propios.reduce((s, x) => s + x.total, 0),
            fechasPedidos: propios.map((x) => x.creadoAt.getTime()),
          }
        }),
        ahora.getTime(),
      )
      const obtenido = Object.fromEntries(p.clientes.map((c, i) => [c.nombre, perfiles[i].segmento]))
      for (const [nombre, esperado] of Object.entries(SEGMENTOS_ESPERADOS)) {
        // VIP y activo se distinguen por gasto, que depende de la carta de cada local.
        const ok = esperado === 'vip' || esperado === 'activo'
          ? ['vip', 'activo'].includes(obtenido[nombre])
          : obtenido[nombre] === esperado
        expect(ok, `${nombre}: esperado ${esperado}, salió ${obtenido[nombre]} (día +${dia})`).toBe(true)
      }
    }
  })

  test('la historia de Martina es la de la demo de la tienda: 7 pedidos, cada ~12 días, hace 3 semanas', () => {
    const p = plan()
    const martina = p.clientes.find((c) => c.nombre.startsWith('Martina'))!
    const propios = p.pedidos.filter((x) => x.clienteClave === martina.clave)
    expect(propios).toHaveLength(7)
    const ultimo = Math.max(...propios.map((x) => x.creadoAt.getTime()))
    const dias = (AHORA.getTime() - ultimo) / DIA_MS
    expect(dias).toBeGreaterThan(20)
    expect(dias).toBeLessThan(25)
  })

  test('hay días flojos para mostrar: los pedidos se juntan de jueves a domingo', () => {
    const p = plan()
    const analisis = calcularDiasFlojos(
      p.pedidos.map((x) => ({ createdAt: x.creadoAt, total: x.total, pagado: x.pagado, estado: x.estado })),
      { ahora: AHORA.getTime(), semanas: 8 },
    )
    expect(analisis.suficientesDatos).toBe(true)
    expect(analisis.flojos.length).toBeGreaterThan(0)
    expect(analisis.flojos.some((f) => [1, 2, 3].includes(f.diaSemana))).toBe(true)
  })

  test('las campañas, sus visitas y el cupón cierran con los pedidos', () => {
    const p = plan()
    expect(p.campanas.map((c) => c.slug)).toEqual(['ejemplo-historias-instagram', 'ejemplo-qr-mostrador'])
    for (const campana of p.campanas) {
      const atribuidos = p.pedidos.filter((x) => x.campanaClave === campana.clave)
      expect(atribuidos.length).toBeGreaterThan(0)
      expect(campana.usos).toBe(atribuidos.length)
      const sesiones = p.sesiones.filter((s) => s.campanaClave === campana.clave)
      expect(sesiones).toHaveLength(campana.visitas)
      for (const s of sesiones) {
        expect(s.creadoAt.getTime()).toBeGreaterThanOrEqual(campana.activadaAt.getTime())
      }
      // Hay más visitas que pedidos: si no, no hay conversión que mostrar.
      expect(campana.visitas).toBeGreaterThan(atribuidos.length)
    }
    const conCupon = p.pedidos.filter((x) => x.usaCupon)
    expect(p.cupon.usos).toBe(conCupon.length)
    for (const x of conCupon) expect(x.descuento).toBeCloseTo(x.subtotal * (PORCENTAJE_CUPON / 100), 1)
    for (const x of p.pedidos.filter((y) => !y.usaCupon)) expect(x.descuento).toBe(0)
  })

  test('los pedidos van del más antiguo al más nuevo y los puntos del cliente salen de ellos', () => {
    const p = plan()
    const fechas = p.pedidos.map((x) => x.creadoAt.getTime())
    expect([...fechas].sort((a, b) => a - b)).toEqual(fechas)
    for (const c of p.clientes) {
      const suma = p.pedidos.filter((x) => x.clienteClave === c.clave).reduce((s, x) => s + x.puntosGanados, 0)
      expect(c.puntos).toBe(suma)
      const primero = Math.min(...p.pedidos.filter((x) => x.clienteClave === c.clave).map((x) => x.creadoAt.getTime()))
      expect(c.creadoAt.getTime()).toBeLessThan(primero)
    }
  })

  test('los pedidos de delivery caen cerca del local', () => {
    const p = plan(AHORA, { ubicacion: { lat: -31.63, lng: -60.7 } })
    const delivery = p.pedidos.filter((x) => x.tipo === 'delivery')
    expect(delivery.length).toBeGreaterThan(0)
    for (const x of delivery) {
      expect(Math.abs(Number(x.latitud) + 31.63)).toBeLessThan(0.02)
      expect(Math.abs(Number(x.longitud) + 60.7)).toBeLessThan(0.02)
      expect(x.direccion).toBeTruthy()
    }
    for (const x of p.pedidos.filter((y) => y.tipo === 'takeaway')) expect(x.latitud).toBeNull()
  })
})
