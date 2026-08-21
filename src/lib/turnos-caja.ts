import { and, desc, eq, isNull } from 'drizzle-orm'
import { turnoCaja as TurnoCajaTable } from '../db/schema'

export interface TurnoCajaResumen {
  id: number
  aperturaAt: Date
  cierreAt: Date | null
  abierto: boolean
}

function inicioDiaActualArgentina() {
  const dia = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' })
  return new Date(`${dia}T00:00:00-03:00`)
}

export async function asegurarTurnoAbierto(db: any, restauranteId: number): Promise<TurnoCajaResumen> {
  const [abierto] = await db.select().from(TurnoCajaTable).where(and(
    eq(TurnoCajaTable.restauranteId, restauranteId), isNull(TurnoCajaTable.cierreAt),
  )).orderBy(desc(TurnoCajaTable.aperturaAt)).limit(1)
  if (abierto) return { ...abierto, abierto: true }

  // Al activar por primera vez incluye lo ya vendido durante el día calendario;
  // después de cada cierre la nueva apertura se crea en ese mismo instante.
  const inicioHoy = inicioDiaActualArgentina()
  const [ultimo] = await db.select({ cierreAt: TurnoCajaTable.cierreAt }).from(TurnoCajaTable)
    .where(eq(TurnoCajaTable.restauranteId, restauranteId))
    .orderBy(desc(TurnoCajaTable.aperturaAt)).limit(1)
  const ultimoCierre = ultimo?.cierreAt ? new Date(ultimo.cierreAt) : null
  const aperturaAt = ultimoCierre && ultimoCierre > inicioHoy ? ultimoCierre : inicioHoy
  try {
    const [insertado] = await db.insert(TurnoCajaTable).values({ restauranteId, aperturaAt }).$returningId()
    return { id: insertado.id, aperturaAt, cierreAt: null, abierto: true }
  } catch (error) {
    if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error
    const [creadoEnParalelo] = await db.select().from(TurnoCajaTable).where(and(
      eq(TurnoCajaTable.restauranteId, restauranteId), isNull(TurnoCajaTable.cierreAt),
    )).orderBy(desc(TurnoCajaTable.aperturaAt)).limit(1)
    if (!creadoEnParalelo) throw error
    return { ...creadoEnParalelo, abierto: true }
  }
}

export async function listarTurnos(db: any, restauranteId: number, limit = 90): Promise<TurnoCajaResumen[]> {
  const turnos = await db.select().from(TurnoCajaTable)
    .where(eq(TurnoCajaTable.restauranteId, restauranteId))
    .orderBy(desc(TurnoCajaTable.aperturaAt)).limit(limit)
  return turnos.map((turno: any) => ({ ...turno, abierto: turno.cierreAt == null }))
}

export async function obtenerTurno(db: any, restauranteId: number, turnoId: number) {
  const [turno] = await db.select().from(TurnoCajaTable).where(and(
    eq(TurnoCajaTable.id, turnoId), eq(TurnoCajaTable.restauranteId, restauranteId),
  )).limit(1)
  return turno ?? null
}

export async function cerrarTurnoActual(db: any, restauranteId: number) {
  return db.transaction(async (tx: any) => {
    const actual = await asegurarTurnoAbierto(tx, restauranteId)
    const cierreAt = new Date()
    await tx.update(TurnoCajaTable).set({ cierreAt, abierto: null, updatedAt: cierreAt })
      .where(and(eq(TurnoCajaTable.id, actual.id), isNull(TurnoCajaTable.cierreAt)))
    const [nuevo] = await tx.insert(TurnoCajaTable).values({ restauranteId, aperturaAt: cierreAt }).$returningId()
    return {
      cerrado: { ...actual, cierreAt, abierto: false },
      actual: { id: nuevo.id, aperturaAt: cierreAt, cierreAt: null, abierto: true },
    }
  })
}

/** Finaliza el intervalo al apagar el módulo, sin abrir otro oculto. */
export async function finalizarTurnoAlDesactivar(db: any, restauranteId: number) {
  const ahora = new Date()
  await db.update(TurnoCajaTable).set({ cierreAt: ahora, abierto: null, updatedAt: ahora }).where(and(
    eq(TurnoCajaTable.restauranteId, restauranteId), isNull(TurnoCajaTable.cierreAt),
  ))
}
