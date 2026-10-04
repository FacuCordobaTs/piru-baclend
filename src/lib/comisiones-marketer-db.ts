import { and, eq, gte, isNull, sql } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import {
  marketer,
  restauranteMarketer,
  comisionMarketer,
  pagoSuscripcion,
  pagoSuscripcionItem,
} from '../db/schema'
import {
  generarComision,
  type RepositorioComisiones,
} from './comisiones-marketer'
type Db = MySql2Database<Record<string, never>>
export function repositorioComisiones(db: Db): RepositorioComisiones {
  return {
    async obtenerFuente(pagoId) {
      const [r] = await db
        .select({
          factura: pagoSuscripcion,
          vinculo: restauranteMarketer,
          activo: marketer.activo,
          porcentaje: marketer.comisionPorcentaje,
        })
        .from(pagoSuscripcion)
        .innerJoin(
          restauranteMarketer,
          eq(restauranteMarketer.restauranteId, pagoSuscripcion.restauranteId),
        )
        .innerJoin(marketer, eq(marketer.id, restauranteMarketer.marketerId))
        .where(eq(pagoSuscripcion.id, pagoId))
        .limit(1)
      if (!r) return null
      const items = await db
        .select({
          tipo: pagoSuscripcionItem.tipo,
          monto: pagoSuscripcionItem.monto,
        })
        .from(pagoSuscripcionItem)
        .where(eq(pagoSuscripcionItem.pagoSuscripcionId, pagoId))
      // Los snapshots modernos son autoritativos; legacy usa sólo las columnas explícitas.
      const componentes = items.length
        ? items
        : [
            { tipo: 'base', monto: r.factura.montoBase ?? '0' },
            { tipo: 'modulo', monto: r.factura.montoModulos },
          ]
      return {
        factura: r.factura,
        vinculo: {
          ...r.vinculo,
          marketerActivo: r.activo,
          porcentaje: r.vinculo.comisionPorcentaje ?? r.porcentaje,
        },
        items: componentes,
      }
    },
    async insertarUnica(asiento) {
      // La comprobación y el INSERT son una sola sentencia: una revocación/reemplazo
      // concurrente no puede acreditar un vínculo que dejó de estar vigente.
      try {
        const [result] = await db.execute(sql`INSERT INTO comision_marketer
          (pago_suscripcion_id, restaurante_id, marketer_id, base_comisionable, porcentaje, monto, estado, created_at)
          SELECT ${asiento.pagoSuscripcionId}, ${asiento.restauranteId}, ${asiento.marketerId},
            ${asiento.baseComisionable}, ${asiento.porcentaje}, ${asiento.monto}, 'pendiente', ${asiento.createdAt}
          FROM restaurante_marketer rm JOIN marketer m ON m.id = rm.marketer_id
          JOIN pago_suscripcion p ON p.restaurante_id = rm.restaurante_id
          WHERE rm.restaurante_id = ${asiento.restauranteId} AND rm.marketer_id = ${asiento.marketerId}
            AND rm.estado = 'activo' AND m.activo = TRUE AND p.id = ${asiento.pagoSuscripcionId}
            AND p.estado = 'paid' AND p.created_at >= rm.activado_at`)
        return (
          Number((result as unknown as { affectedRows: number }).affectedRows) >
          0
        )
      } catch (error) {
        const e = error as { code?: string; cause?: { code?: string } }
        if ((e.code ?? e.cause?.code) === 'ER_DUP_ENTRY') return false
        throw error
      }
    },
    async pendientesDeConciliar() {
      const rows = await db
        .select({ id: pagoSuscripcion.id })
        .from(pagoSuscripcion)
        .innerJoin(
          restauranteMarketer,
          eq(restauranteMarketer.restauranteId, pagoSuscripcion.restauranteId),
        )
        .innerJoin(marketer, eq(marketer.id, restauranteMarketer.marketerId))
        .leftJoin(
          comisionMarketer,
          eq(comisionMarketer.pagoSuscripcionId, pagoSuscripcion.id),
        )
        .where(
          and(
            eq(pagoSuscripcion.estado, 'paid'),
            eq(restauranteMarketer.estado, 'activo'),
            eq(marketer.activo, true),
            gte(pagoSuscripcion.createdAt, restauranteMarketer.activadoAt),
            isNull(comisionMarketer.id),
          ),
        )
      return rows.map((r) => r.id)
    },
  }
}
export async function acreditarComisionMarketer(db: Db, pagoId: number) {
  try {
    await generarComision(repositorioComisiones(db), pagoId)
  } catch {
    console.error(
      '[Marketers] No se pudo registrar la comisión de la factura',
      pagoId,
    )
  }
}
