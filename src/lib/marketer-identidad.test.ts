import { expect, test } from 'bun:test'
import { marketer, restaurante, restauranteMarketer } from '../db/schema'
import {
  generarActivacionMarketer,
  hashActivacionMarketer,
  vincularMarketer,
} from './marketer-identidad'

test('la activación guarda sólo sha256, vence en siete días y usa un fragmento', () => {
  const ahora = new Date('2026-10-03T20:00:00Z')
  const link = generarActivacionMarketer(ahora)
  expect(link.tokenHash).toBe(hashActivacionMarketer(link.token))
  expect(link.tokenHash).not.toBe(link.token)
  expect(link.expiraAt.getTime() - ahora.getTime()).toBe(7 * 86400000)
  expect(new URL(link.linkActivacion).search).toBe('')
  expect(new URL(link.linkActivacion).hash).toBe(`#token=${link.token}`)
})

function repositorio(actual: any) {
  const cambios: any[] = []
  const bloqueos: string[] = []
  const tx: any = {
    select: () => {
      let table: unknown
      const rows = () =>
        table === restaurante
          ? [{ id: 6 }]
          : table === restauranteMarketer
            ? actual
              ? [actual]
              : []
            : [{ id: 2, nombre: 'Tommy', codigo: 'TOMMY' }]
      const q: any = {
        from: (t: unknown) => {
          table = t
          return q
        },
        where: () => q,
        limit: () => q,
        for: (mode: string) => {
          bloqueos.push(mode)
          return q
        },
        then: (ok: any, fail: any) => Promise.resolve(rows()).then(ok, fail),
      }
      return q
    },
    update: () => ({
      set: (values: any) => ({
        where: async () => {
          cambios.push(values)
        },
      }),
    }),
    insert: () => ({
      values: async (values: any) => {
        cambios.push(values)
      },
    }),
  }
  return {
    db: { transaction: async (callback: any) => callback(tx) } as any,
    cambios,
    bloqueos,
  }
}
test('el dueño debe confirmar el reemplazo, y el local se bloquea para serializarlo', async () => {
  const repo = repositorio({
    id: 1,
    marketerId: 8,
    estado: 'activo',
    activadoAt: new Date(),
    comisionPorcentaje: '12.00',
  })
  await expect(
    vincularMarketer(6, 2, { origen: 'duenio' }, repo.db),
  ).rejects.toMatchObject({ status: 409, code: 'reemplazo_requerido' })
  expect(repo.cambios).toHaveLength(0)
  expect(repo.bloqueos).toEqual(['update'])
  await vincularMarketer(6, 2, { origen: 'duenio', reemplazar: true }, repo.db)
  expect(repo.cambios[0]).toMatchObject({
    marketerId: 2,
    estado: 'activo',
    revocadoAt: null,
    comisionPorcentaje: null,
  })
})
test('repetir el vínculo preserva el inicio y el override; null lo elimina explícitamente', async () => {
  const inicio = new Date('2026-09-20T20:00:00Z')
  const repo = repositorio({
    id: 1,
    marketerId: 2,
    estado: 'activo',
    activadoAt: inicio,
    comisionPorcentaje: '12.00',
  })
  await vincularMarketer(6, 2, { origen: 'duenio' }, repo.db)
  expect(repo.cambios[0]).toMatchObject({
    activadoAt: inicio,
    comisionPorcentaje: '12.00',
  })
  await vincularMarketer(
    6,
    2,
    { origen: 'interno', comisionPorcentaje: null },
    repo.db,
  )
  expect(repo.cambios[1]).toMatchObject({
    activadoAt: inicio,
    comisionPorcentaje: null,
  })
})
test('quitar acceso conserva el vínculo revocado y quién lo hizo', async () => {
  const repo = repositorio({ id: 1, marketerId: 2, estado: 'activo' })
  expect(
    await vincularMarketer(6, null, { origen: 'duenio' }, repo.db),
  ).toBeNull()
  expect(repo.cambios[0]).toMatchObject({
    estado: 'revocado',
    revocadoPor: 'duenio',
    revocadoAt: expect.any(Date),
  })
})
