import { describe, expect, test } from 'bun:test'
import {
  compensarReservaCreditoMarketing,
  confirmarReservaCreditoMarketing,
  reservarCreditoMarketing,
} from './mensajes-wallet'
import { saldoMensajes, transaccionMensajes } from '../db/schema'

function walletFake(saldoInicial: { incluidos?: number; recarga?: number } = {}) {
  const saldo: any = {
    id: 1,
    restauranteId: 7,
    marketingIncluidosRestantes: saldoInicial.incluidos ?? 0,
    marketingRecargaSaldo: saldoInicial.recarga ?? 0,
    utilityIncluidosRestantes: 0,
    utilityRecargaSaldo: 0,
  }
  const movimientos: any[] = []
  let serial = Promise.resolve()

  const db: any = {
    transaction(callback: (tx: any) => Promise<unknown>) {
      const ejecutar = serial.then(() => callback(db))
      serial = ejecutar.then(() => undefined, () => undefined)
      return ejecutar
    },
    execute: async () => [],
    select() {
      let tabla: any
      return {
        from(t: any) { tabla = t; return this },
        where() { return this },
        limit: async () => tabla === saldoMensajes
          ? [saldo]
          : movimientos.filter((m) => m.operacionId === db.operacionesBuscadas.shift()).slice(-1),
      }
    },
    update(tabla: any) {
      return {
        set(valores: any) {
          if (tabla === saldoMensajes) Object.assign(saldo, valores)
          else Object.assign(movimientos[movimientos.length - 1], valores)
          return { where: async () => [{ affectedRows: 1 }] }
        },
      }
    },
    insert(tabla: any) {
      return {
        values: async (valores: any) => {
          if (tabla === transaccionMensajes) movimientos.push({ id: movimientos.length + 1, ...valores })
          return [{ insertId: movimientos.length }]
        },
      }
    },
    operacionesBuscadas: [] as string[],
    get saldo() { return saldo },
    get movimientos() { return movimientos },
  }

  // El fake conoce la operación buscada porque la única consulta al ledger de
  // esta tarea siempre sigue al lock de saldo dentro de la misma transacción.
  const originalSelect = db.select.bind(db)
  db.select = () => {
    const chain = originalSelect()
    const originalFrom = chain.from.bind(chain)
    chain.from = (tabla: any) => {
      originalFrom(tabla)
      if (tabla === transaccionMensajes) {
        chain.limit = async () => movimientos.filter((m) => m.operacionId === db.operacionesBuscadas.shift()).slice(-1)
      }
      return chain
    }
    return chain
  }
  return db
}

// El repositorio Drizzle filtra operacionId en SQL; este wrapper conserva el
// orden de esas búsquedas en el fake serializado.
async function reservar(db: any, clave: string) { db.operacionesBuscadas.push(clave); return reservarCreditoMarketing(db, 7, clave) }
async function confirmar(db: any, clave: string) { db.operacionesBuscadas.push(clave); return confirmarReservaCreditoMarketing(db, 7, clave) }
async function compensar(db: any, clave: string) { db.operacionesBuscadas.push(clave); return compensarReservaCreditoMarketing(db, 7, clave) }

describe('reservas de crédito marketing', () => {
  test('dos reintentos concurrentes con saldo 1 retienen un único crédito', async () => {
    const db = walletFake({ incluidos: 1 })
    const [a, b] = await Promise.all([reservar(db, 'mismo-envio'), reservar(db, 'mismo-envio')])
    expect([a.estado, b.estado]).toEqual(['reservada', 'reservada'])
    expect([a.idempotente, b.idempotente].sort()).toEqual([false, true])
    expect(db.saldo.marketingIncluidosRestantes).toBe(0)
    expect(db.saldo.marketingRecargaSaldo).toBe(0)
    expect(db.movimientos).toHaveLength(1)
  })

  test('saldo 0 nunca crea deuda ni movimiento', async () => {
    const db = walletFake()
    await expect(reservar(db, 'sin-saldo')).resolves.toMatchObject({ estado: 'sin_saldo' })
    expect(db.saldo.marketingRecargaSaldo).toBe(0)
    expect(db.movimientos).toHaveLength(0)
  })

  test('confirmar dos veces conserva un único débito', async () => {
    const db = walletFake({ recarga: 1 })
    await reservar(db, 'confirmar')
    expect(await confirmar(db, 'confirmar')).toMatchObject({ estado: 'confirmada', idempotente: false })
    expect(await confirmar(db, 'confirmar')).toMatchObject({ estado: 'confirmada', idempotente: true })
    expect(db.saldo.marketingRecargaSaldo).toBe(0)
    expect(db.movimientos).toHaveLength(1)
    expect(db.movimientos[0]).toMatchObject({ tipo: 'consumo', cantidad: -1 })
  })

  test('compensar dos veces devuelve el bucket original sin sobreacreditar', async () => {
    const db = walletFake({ incluidos: 1 })
    await reservar(db, 'compensar')
    expect(await compensar(db, 'compensar')).toMatchObject({ estado: 'compensada', idempotente: false })
    expect(await compensar(db, 'compensar')).toMatchObject({ estado: 'compensada', idempotente: true })
    expect(db.saldo.marketingIncluidosRestantes).toBe(1)
    expect(db.saldo.marketingRecargaSaldo).toBe(0)
    expect(db.movimientos).toHaveLength(1)
    expect(db.movimientos[0]).toMatchObject({ tipo: 'compensacion', cantidad: 1 })
  })
})
