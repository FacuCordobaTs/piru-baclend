import { describe, expect, test } from 'bun:test'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import type { SQL } from 'drizzle-orm'
import { pedidoUnificado, producto, restaurante, zonaDelivery } from '../db/schema'
import { computarInventarioClaim } from './claim'
import { AHORA_CARTERA, datosCarteraEjemplo, dbCarteraFalsa } from './marketer-cartera-db.fakes'
import { tarjetasDeCartera } from './marketer-cartera-db'
import {
  esRequestIdEjemplo,
  nuevoRequestIdEjemplo,
  pedidoReal,
  PREFIJO_REQUEST_EJEMPLO,
} from './pedido-ejemplo'
import { contarValorPiru } from './valor-piru'

const dialecto = new MySqlDialect()
const aSql = (condicion: unknown) => dialecto.sqlToQuery(condicion as SQL)

/** Una condición descarta los pedidos de ejemplo si pregunta por el prefijo, sin perder los NULL. */
function descartaEjemplo(condicion: unknown) {
  const { sql, params } = aSql(condicion)
  return /is null/i.test(sql) && /not like/i.test(sql) && params.includes(`${PREFIJO_REQUEST_EJEMPLO}%`)
}

describe('la marca de los pedidos de ejemplo', () => {
  test('cada pedido sembrado lleva un client_request_id propio que la columna admite', () => {
    const ids = Array.from({ length: 500 }, () => nuevoRequestIdEjemplo())
    expect(new Set(ids).size).toBe(500)
    for (const id of ids) {
      expect(esRequestIdEjemplo(id)).toBe(true)
      expect(id.length).toBeLessThanOrEqual(36)
    }
  })

  test('un request id de la tienda o del panel (UUID) o la ausencia de uno no son de ejemplo', () => {
    expect(esRequestIdEjemplo('8f14e45f-ceea-4672-9b2a-0f8c6a4a3c11')).toBe(false)
    expect(esRequestIdEjemplo(null)).toBe(false)
    expect(esRequestIdEjemplo(undefined)).toBe(false)
    expect(esRequestIdEjemplo('')).toBe(false)
  })

  test('pedidoReal() deja pasar los NULL (la mayoría) y descarta el prefijo', () => {
    const { sql, params } = aSql(pedidoReal())
    expect(sql).toContain('`client_request_id`')
    expect(descartaEjemplo(pedidoReal())).toBe(true)
    expect(params).toEqual([`${PREFIJO_REQUEST_EJEMPLO}%`])
  })
})

/** Una base que registra la condición de cada `select … from … where` y responde por tabla. */
function baseQueRegistra(respuestas: Map<unknown, unknown[]>) {
  const condiciones: { tabla: unknown; condicion: unknown }[] = []
  const db: any = {
    select() {
      let tabla: unknown
      const q: any = {
        from: (t: unknown) => {
          tabla = t
          return q
        },
        where: (condicion: unknown) => {
          condiciones.push({ tabla, condicion })
          return q
        },
        limit: () => q,
        then: (ok: any, ko: any) => Promise.resolve(respuestas.get(tabla) ?? []).then(ok, ko),
      }
      return q
    },
  }
  return { db, condiciones }
}

describe('lo que mide actividad real no cuenta los pedidos de ejemplo', () => {
  test('el valor de la prueba (panel y aviso por WhatsApp) los deja afuera', async () => {
    const f = baseQueRegistra(new Map([[pedidoUnificado, [{ pedidos: '3', monto: '45000.50' }]]]))
    const valor = await contarValorPiru(f.db, 7, new Date('2026-10-12T12:00:00Z'))
    expect(valor).toEqual({ pedidos: 3, monto: 45000.5 })
    expect(f.condiciones).toHaveLength(1)
    expect(descartaEjemplo(f.condiciones[0].condicion)).toBe(true)
    // Sigue siendo el contador de siempre: del local, desde el inicio del ciclo y sin lo anotado a mano.
    const { sql } = aSql(f.condiciones[0].condicion)
    expect(sql).toContain('`restaurante_id`')
    expect(sql).toContain('`anotado_manualmente`')
    expect(sql).toContain('`created_at`')
  })

  test('sin pedidos el valor es cero', async () => {
    const f = baseQueRegistra(new Map())
    expect(await contarValorPiru(f.db, 7, new Date())).toEqual({ pedidos: 0, monto: 0 })
  })

  test('el "primer pedido de prueba" del claim no se cumple con los de ejemplo', async () => {
    const respuestas = new Map<unknown, unknown[]>([
      [restaurante, [{ nombre: 'Brasa', username: 'brasa', imagenUrl: null, imagenLightUrl: null }]],
      [producto, [{ n: 8 }]],
      [zonaDelivery, [{ n: 1 }]],
      [pedidoUnificado, [{ n: 0 }]],
    ])
    const f = baseQueRegistra(respuestas)
    const inventario = await computarInventarioClaim(f.db, 7)
    expect(inventario.productos).toBe(8)
    expect(inventario.primerPedido).toBe(false)
    const deLosPedidos = f.condiciones.filter((c) => c.tabla === pedidoUnificado)
    expect(deLosPedidos).toHaveLength(1)
    expect(descartaEjemplo(deLosPedidos[0].condicion)).toBe(true)
    // Los otros conteos no cambian.
    expect(f.condiciones.filter((c) => c.tabla !== pedidoUnificado && c.tabla !== restaurante)).toHaveLength(2)
  })

  const LOCAL = {
    restauranteId: 6,
    nombre: 'Brasa',
    username: 'brasa',
    imagenUrl: null,
    colorPrimario: '#ff7a00',
    dominioTienda: null,
    whatsappConectado: 1,
    desde: null,
    porcentaje: null,
  }

  test('la cartera del marketer los deja afuera, en los pedidos y en los primeros pedidos', async () => {
    const f = dbCarteraFalsa(datosCarteraEjemplo())
    await tarjetasDeCartera(f.db, [LOCAL], 15, AHORA_CARTERA)
    const deLosPedidos = f.condiciones.filter((c: { tabla: unknown }) => c.tabla === pedidoUnificado)
    expect(deLosPedidos).toHaveLength(2)
    for (const c of deLosPedidos) expect(descartaEjemplo(c.condicion)).toBe(true)
  })

  test('el dueño que abre la app desde su panel los ve, como en el resto de su panel', async () => {
    const f = dbCarteraFalsa(datosCarteraEjemplo())
    await tarjetasDeCartera(f.db, [LOCAL], 0, AHORA_CARTERA, { incluirEjemplo: true })
    const deLosPedidos = f.condiciones.filter((c: { tabla: unknown }) => c.tabla === pedidoUnificado)
    expect(deLosPedidos).toHaveLength(2)
    for (const c of deLosPedidos) expect(aSql(c.condicion).sql).not.toMatch(/not like/i)
  })
})
