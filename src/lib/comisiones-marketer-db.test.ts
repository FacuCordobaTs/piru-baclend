import { expect, test } from 'bun:test'
import {
  acreditarComisionMarketer,
  repositorioComisiones,
} from './comisiones-marketer-db'
import { MySqlDialect } from 'drizzle-orm/mysql-core'

function baseFake(error?: unknown) {
  let consultas = 0
  const insertados: unknown[] = []
  const fuente = {
    factura: {
      id: 1,
      restauranteId: 6,
      estado: 'paid',
      createdAt: new Date('2026-10-03T12:00:00Z'),
      montoBase: '100',
      montoModulos: '0',
    },
    vinculo: {
      marketerId: 2,
      estado: 'activo',
      activadoAt: new Date('2026-10-01T12:00:00Z'),
      comisionPorcentaje: '30.00',
    },
    activo: true,
    porcentaje: '20.00',
  }
  const db = {
    select: () => {
      const rows =
        consultas++ === 0
          ? [fuente]
          : [
              { tipo: 'base', monto: '100.00' },
              { tipo: 'modulo', monto: '50.00' },
              { tipo: 'pack_mensajes', monto: '999.00' },
            ]
      const chain: any = {}
      for (const m of ['from', 'innerJoin', 'where', 'limit'])
        chain[m] = () => chain
      chain.then = (resolve: any) => Promise.resolve(rows).then(resolve)
      return chain
    },
    execute: async (query: any) => {
      if (error) throw error
      const q = new MySqlDialect().sqlToQuery(query)
      insertados.push(q)
      return [{ affectedRows: 1 }]
    },
  }
  return {
    db: db as unknown as Parameters<typeof repositorioComisiones>[0],
    insertados,
  }
}
test('repositorio congela override por local y excluye pack de la factura compuesta', async () => {
  const f = baseFake()
  await acreditarComisionMarketer(f.db, 1)
  expect(f.insertados).toHaveLength(1)
  expect(f.insertados[0]).toMatchObject({
    params: [1, 6, 2, '150.00', '30.00', '45.00', expect.any(Date), 6, 2, 1],
  })
  expect((f.insertados[0] as { sql: string }).sql).toContain(
    "rm.estado = 'activo'",
  )
})
test('índice duplicado es idempotente; cualquier otro fallo SQL se conserva', async () => {
  const asiento = {
    pagoSuscripcionId: 1,
    restauranteId: 6,
    marketerId: 2,
    baseComisionable: '100.00',
    porcentaje: '20.00',
    monto: '20.00',
    createdAt: new Date(),
  }
  const duplicado = baseFake({ cause: { code: 'ER_DUP_ENTRY' } })
  expect(await repositorioComisiones(duplicado.db).insertarUnica(asiento)).toBe(
    false,
  )
  const falla = baseFake(new Error('DB no disponible'))
  await expect(
    repositorioComisiones(falla.db).insertarUnica(asiento),
  ).rejects.toThrow('DB no disponible')
})
test('un error de asiento nunca revierte el pago aprobado', async () => {
  const f = baseFake(new Error('DB no disponible'))
  await expect(acreditarComisionMarketer(f.db, 1)).resolves.toBeUndefined()
  expect(f.insertados).toHaveLength(0)
})
test('un vínculo revocado entre lectura e inserción no crea comisión', async () => {
  const f = baseFake()
  f.db.execute = (async () => [
    { affectedRows: 0 },
  ]) as unknown as typeof f.db.execute
  const asiento = {
    pagoSuscripcionId: 1,
    restauranteId: 6,
    marketerId: 2,
    baseComisionable: '100.00',
    porcentaje: '20.00',
    monto: '20.00',
    createdAt: new Date(),
  }
  expect(await repositorioComisiones(f.db).insertarUnica(asiento)).toBe(false)
})
