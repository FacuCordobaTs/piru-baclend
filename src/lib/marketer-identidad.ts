import { createHash, randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { marketer, restaurante, restauranteMarketer } from '../db/schema'

export const hashActivacionMarketer = (token: string) =>
  createHash('sha256').update(token).digest('hex')
/** Base de la app de marketers (`MARKETING_URL`), sin barra final. */
export const urlAppMarketing = () =>
  (process.env.MARKETING_URL || 'https://marketing.piru.app').replace(/\/$/, '')
export function generarActivacionMarketer(ahora = new Date()) {
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: hashActivacionMarketer(token),
    expiraAt: new Date(ahora.getTime() + 7 * 86400000),
    linkActivacion: `${urlAppMarketing()}/activar#token=${token}`,
  }
}
export function datosMarketer(row: typeof marketer.$inferSelect) {
  return {
    id: row.id,
    nombre: row.nombre,
    email: row.email,
    telefono: row.telefono,
    codigo: row.codigo,
    comisionPorcentaje: Number(row.comisionPorcentaje),
    datosCobro: row.datosCobro,
  }
}
const errorVinculo = (message: string, status: number, code: string) =>
  Object.assign(new Error(message), { status, code })

/** Bloquear la fila del local serializa altas concurrentes y preserva la confirmación del dueño. */
export async function vincularMarketer(
  restauranteId: number,
  marketerId: number | null,
  opciones: {
    origen: 'interno' | 'duenio'
    comisionPorcentaje?: number | null
    reemplazar?: boolean
  },
  db = drizzle(pool),
) {
  return db.transaction(async (tx) => {
    const [local] = await tx
      .select({ id: restaurante.id })
      .from(restaurante)
      .where(eq(restaurante.id, restauranteId))
      .limit(1)
      .for('update')
    if (!local)
      throw errorVinculo('Local no encontrado', 404, 'local_no_encontrado')
    const [actual] = await tx
      .select()
      .from(restauranteMarketer)
      .where(eq(restauranteMarketer.restauranteId, restauranteId))
      .limit(1)
    const ahora = new Date()
    if (marketerId === null) {
      if (actual?.estado === 'activo')
        await tx
          .update(restauranteMarketer)
          .set({
            estado: 'revocado',
            revocadoAt: ahora,
            revocadoPor: opciones.origen,
          })
          .where(eq(restauranteMarketer.id, actual.id))
      return null
    }
    const [partner] = await tx
      .select({
        id: marketer.id,
        nombre: marketer.nombre,
        codigo: marketer.codigo,
      })
      .from(marketer)
      .where(and(eq(marketer.id, marketerId), eq(marketer.activo, true)))
      .limit(1)
    if (!partner)
      throw errorVinculo(
        'Marketer no encontrado o inactivo',
        404,
        'marketer_no_encontrado',
      )
    if (
      actual?.estado === 'activo' &&
      actual.marketerId !== marketerId &&
      !(opciones.reemplazar ?? opciones.origen === 'interno')
    )
      throw errorVinculo(
        'El local ya tiene otro marketer. Confirmá el reemplazo.',
        409,
        'reemplazo_requerido',
      )
    // Repetir el mismo alta no reinicia la fecha que protege las comisiones.
    const desde =
      actual?.estado === 'activo' && actual.marketerId === marketerId
        ? actual.activadoAt
        : ahora
    const values = {
      restauranteId,
      marketerId,
      estado: 'activo' as const,
      origen: opciones.origen,
      activadoAt: desde,
      revocadoAt: null,
      revocadoPor: null,
      comisionPorcentaje:
        opciones.comisionPorcentaje === undefined
          ? actual?.marketerId === marketerId
            ? actual.comisionPorcentaje
            : null
          : opciones.comisionPorcentaje === null
            ? null
            : opciones.comisionPorcentaje.toFixed(2),
    }
    if (actual)
      await tx
        .update(restauranteMarketer)
        .set(values)
        .where(eq(restauranteMarketer.id, actual.id))
    else await tx.insert(restauranteMarketer).values(values)
    return { marketer: partner, desde, origen: opciones.origen }
  })
}
