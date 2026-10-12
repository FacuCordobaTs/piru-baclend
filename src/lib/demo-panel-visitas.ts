import { inArray, sql } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { demoPanelVisita } from '../db/schema'

type Db = MySql2Database<Record<string, never>>

export interface EntradaDemo {
  primeraEntradaAt: Date
  ultimaEntradaAt: Date
  entradas: number
}

/**
 * Anota que alguien abrió el panel de la demo de un prospecto (`POST /api/demo-panel/sesion`). Es la
 * señal que le dice al fundador a quién escribirle y cuándo: "no la vio" y "la vio y no le interesó"
 * se tratan distinto. Cuenta entradas, no personas: el mismo dueño que vuelve suma. Sólo se lee desde
 * interno; nada de esto sale del servidor hacia el prospecto.
 */
export async function registrarEntradaDemo(db: Db, restauranteId: number, ahora: Date = new Date()): Promise<void> {
  await db
    .insert(demoPanelVisita)
    .values({ restauranteId, primeraEntradaAt: ahora, ultimaEntradaAt: ahora, entradas: 1 })
    .onDuplicateKeyUpdate({
      set: { ultimaEntradaAt: ahora, entradas: sql`${demoPanelVisita.entradas} + 1` },
    })
}

/**
 * Las entradas de varios locales, para el listado de interno. Sin la tabla (migración pendiente)
 * devuelve vacío: el listado no puede caerse por una señal accesoria.
 */
export async function entradasDemo(db: Db, ids: number[]): Promise<Map<number, EntradaDemo>> {
  if (ids.length === 0) return new Map()
  try {
    const filas = await db.select().from(demoPanelVisita).where(inArray(demoPanelVisita.restauranteId, ids))
    return new Map(
      filas.map((f) => [
        f.restauranteId,
        { primeraEntradaAt: f.primeraEntradaAt, ultimaEntradaAt: f.ultimaEntradaAt, entradas: f.entradas },
      ]),
    )
  } catch (error) {
    console.warn('[demo-panel] No se pudieron leer las entradas a la demo:', (error as Error).message)
    return new Map()
  }
}
