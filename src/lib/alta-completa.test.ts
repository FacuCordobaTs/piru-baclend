import { expect, test } from 'bun:test'
import { AltaIncompletaError, completarAltaInterna } from './alta-completa'
import { restaurante } from '../db/schema'

/** Una base que registra qué tablas lee y qué escribe, y si tomó el bloqueo del local. */
function escenario(username: string | null = 'brasa') {
  const lecturas: unknown[] = []
  const escrituras: { op: 'insert' | 'update' | 'delete'; tabla: unknown; datos?: any }[] = []
  let bloqueo = false
  const tx = {
    select: () => {
      let tabla: unknown
      const query: any = {
        from(t: unknown) {
          tabla = t
          lecturas.push(t)
          return query
        },
        where: () => query,
        limit: () => query,
        for(modo: string) {
          bloqueo = modo === 'update'
          return query
        },
        then: (ok: any, ko: any) =>
          Promise.resolve(tabla === restaurante ? [{ id: 7, username }] : []).then(ok, ko),
      }
      return query
    },
    update: (tabla: unknown) => ({
      set: (datos: any) => ({ where: async () => void escrituras.push({ op: 'update', tabla, datos }) }),
    }),
    insert: (tabla: unknown) => ({ values: async (datos: any) => void escrituras.push({ op: 'insert', tabla, datos }) }),
    delete: (tabla: unknown) => ({ where: async () => void escrituras.push({ op: 'delete', tabla }) }),
  }
  return {
    db: { transaction: (fn: any) => fn(tx) } as any,
    lecturas,
    escrituras,
    get bloqueo() {
      return bloqueo
    },
  }
}

test('cierra el alta con el local bloqueado y no hace nada más', async () => {
  const s = escenario()
  await completarAltaInterna(s.db, 7)
  expect(s.bloqueo).toBe(true)
  expect(s.escrituras).toEqual([{ op: 'update', tabla: restaurante, datos: { completedOnboarding: true } }])
})

test('no inicia la prueba: no lee ni escribe la suscripción ni toca el paywall', async () => {
  const s = escenario()
  await completarAltaInterna(s.db, 7)
  // Sólo el local: ninguna suscripción que crear, reiniciar o consultar.
  expect(s.lecturas).toEqual([restaurante])
  expect(s.escrituras.every((e) => e.tabla === restaurante)).toBe(true)
  expect(s.escrituras[0].datos).not.toHaveProperty('requiereSuscripcion')
})

test('exige que la tienda tenga su alias antes de cerrarla', async () => {
  const s = escenario(null)
  await expect(completarAltaInterna(s.db, 7)).rejects.toBeInstanceOf(AltaIncompletaError)
  await expect(completarAltaInterna(s.db, 7)).rejects.toThrow('Terminá de configurar')
  expect(s.escrituras).toEqual([])
})

test('cerrarla dos veces no cambia nada más', async () => {
  const s = escenario()
  await completarAltaInterna(s.db, 7)
  await completarAltaInterna(s.db, 7)
  expect(s.escrituras).toHaveLength(2)
  for (const e of s.escrituras) expect(e.datos).toEqual({ completedOnboarding: true })
})
