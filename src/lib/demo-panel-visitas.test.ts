import { describe, expect, test } from 'bun:test'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import type { SQL } from 'drizzle-orm'
import { demoPanelVisita } from '../db/schema'
import { entradasDemo, registrarEntradaDemo } from './demo-panel-visitas'

const dialecto = new MySqlDialect()
const aSql = (valor: unknown) => dialecto.sqlToQuery(valor as SQL)

describe('las entradas al panel de la demo', () => {
  test('la primera entrada deja la fila y las siguientes suman una entrada y mueven la última', async () => {
    const ahora = new Date('2026-10-12T15:30:00-03:00')
    let tabla: unknown
    let valores: any
    let actualizacion: any
    const db: any = {
      insert: (t: unknown) => {
        tabla = t
        return {
          values: (v: unknown) => {
            valores = v
            return {
              onDuplicateKeyUpdate: async (u: unknown) => {
                actualizacion = u
              },
            }
          },
        }
      },
    }
    await registrarEntradaDemo(db, 7, ahora)
    expect(tabla).toBe(demoPanelVisita)
    expect(valores).toEqual({ restauranteId: 7, primeraEntradaAt: ahora, ultimaEntradaAt: ahora, entradas: 1 })
    // Al repetirse no pisa la primera: sólo mueve la última y suma una (en SQL, sin leer antes).
    expect(Object.keys(actualizacion.set).sort()).toEqual(['entradas', 'ultimaEntradaAt'])
    expect(actualizacion.set.ultimaEntradaAt).toBe(ahora)
    expect(aSql(actualizacion.set.entradas).sql).toMatch(/`entradas`\s*\+\s*1/)
  })

  test('devuelve las entradas por local', async () => {
    const primera = new Date('2026-10-10T12:00:00Z')
    const ultima = new Date('2026-10-12T18:00:00Z')
    const db: any = {
      select: () => ({
        from: () => ({
          where: async () => [
            { restauranteId: 7, primeraEntradaAt: primera, ultimaEntradaAt: ultima, entradas: 3 },
          ],
        }),
      }),
    }
    const r = await entradasDemo(db, [7, 8])
    expect(r.get(7)).toEqual({ primeraEntradaAt: primera, ultimaEntradaAt: ultima, entradas: 3 })
    expect(r.has(8)).toBe(false)
  })

  test('sin la tabla (migración pendiente) el listado no se cae', async () => {
    const db: any = {
      select: () => ({
        from: () => ({
          where: async () => {
            throw new Error("Table 'demo_panel_visita' doesn't exist")
          },
        }),
      }),
    }
    expect((await entradasDemo(db, [7])).size).toBe(0)
  })

  test('sin locales no consulta nada', async () => {
    const db: any = {
      select: () => {
        throw new Error('no debería consultar')
      },
    }
    expect((await entradasDemo(db, [])).size).toBe(0)
  })
})
