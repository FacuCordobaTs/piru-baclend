// src/lib/trial-avisos.ts
// Aviso "tu prueba está por vencer" (día ~3 del trial de 5) del Claim Flow. Ver docs/ROADMAP_CLAIM_FLOW.md (Tarea 7).
//
// Un scheduler (setInterval en index.ts, patrón del Motor de Recompra) llama a `tickAvisosTrial`
// cada ~15 min. El tick busca los trials que vencen dentro de ~2 días y todavía no recibieron el
// aviso, y les manda por WhatsApp (número de Piru) un mensaje con el link de pago para activar la
// suscripción base ahí mismo. Se envía UNA SOLA VEZ por trial: `suscripcion.avisoTrialVencimientoAt` es el flag
// anti-reenvío (se marca al enviar; se resetea a null al arrancar un trial nuevo en iniciarTrial).
//
// NO hay cron externo: es un setInterval dentro del proceso del backend, best-effort (si falla un
// local, se loguea y se sigue; se reintenta en el próximo tick).
import { type MySql2Database } from 'drizzle-orm/mysql2'
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import {
  suscripcion as SuscripcionTable,
  restaurante as RestauranteTable,
  pedidoUnificado as PedidoUnificadoTable,
} from '../db/schema'
import { DIAS_GRACIA } from './suscripciones'
import { crearFacturaSuscripcionPendiente } from './facturacion-suscripcion'
import { horaArgentina } from './proteccion-base'
import { sendTrialEndingWhatsApp } from '../services/whatsapp'

type Db = MySql2Database<Record<string, never>>

/** Cuántos días antes del fin del trial se manda el aviso (día ~3 de un trial de 5). */
export const TRIAL_AVISO_ANTES_DIAS = 2

/** Franja horaria (Argentina, UTC-3) en la que es aceptable mandar el aviso de pago. */
const HORA_MIN = 9
const HORA_MAX = 21 // exclusivo: no se envía a las 21:00 o después

/** Contexto falso para leer env fuera de un request (mismo patrón que motor-recompra). */
const fakeCtx = { env: process.env } as any

/** Fecha en formato "viernes 8/8" (día de semana + d/m, hora Argentina) para el copy del aviso. */
function formatearFechaFin(fecha: Date): string {
  try {
    const dia = new Intl.DateTimeFormat('es-AR', {
      weekday: 'long', timeZone: 'America/Argentina/Buenos_Aires',
    }).format(fecha)
    const dm = new Intl.DateTimeFormat('es-AR', {
      day: 'numeric', month: 'numeric', timeZone: 'America/Argentina/Buenos_Aires',
    }).format(fecha)
    return `${dia} ${dm}`
  } catch {
    return new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'numeric' }).format(fecha)
  }
}

const fmtPlata = (n: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n)

/** Precio sin símbolo (para la plantilla, que ya trae "$" fijo: "${{4}}/mes"). Ej: "40.000". */
const fmtPrecio = (n: number) =>
  new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(n)

/**
 * Procesa un trial concreto: computa el valor generado, crea el pago pendiente con su token y manda
 * el aviso por WhatsApp. Devuelve true si el aviso salió (para marcar el flag), false si no se pudo
 * enviar por una razón permanente (sin teléfono → igual se marca para no reintentar en loop) o
 * transitoria (error de red → NO se marca, se reintenta el próximo tick).
 */
async function procesarTrial(
  db: Db,
  sub: { restauranteId: number; trialFin: Date; fechaInicio: Date | null },
): Promise<{ marcar: boolean }> {
  const [rest] = await db
    .select({ nombre: RestauranteTable.nombre, telefono: RestauranteTable.telefono })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, sub.restauranteId))
    .limit(1)

  const telefono = (rest?.telefono || '').replace(/\D/g, '')
  if (!telefono || telefono.length < 8) {
    // Condición permanente (el número no va a aparecer solo): marcamos el flag para no reintentar
    // en cada tick. Si el dueño verifica su número después, ya no recibirá este aviso (aceptable).
    console.warn(`⚠️ [Trial aviso] restaurante ${sub.restauranteId} sin teléfono válido; se omite el aviso.`)
    return { marcar: true }
  }

  // Valor generado en el trial: plata en pedidos que ENTRARON por Piru (web, no anotados a mano)
  // desde que arrancó la prueba. Mismo criterio que el contador de valor de /planes/mi-suscripcion.
  let plataTrial = 0
  if (sub.fechaInicio) {
    const [valorRow] = await db
      .select({ monto: sql<string>`COALESCE(SUM(${PedidoUnificadoTable.total}), 0)` })
      .from(PedidoUnificadoTable)
      .where(
        and(
          eq(PedidoUnificadoTable.restauranteId, sub.restauranteId),
          eq(PedidoUnificadoTable.anotadoManualmente, false),
          sql`${PedidoUnificadoTable.createdAt} >= ${sub.fechaInicio}`,
        ),
      )
    plataTrial = parseFloat(String(valorRow?.monto ?? '0'))
  }

  // Token de pago (página pública /pago/:token). Válido hasta el fin del trial + la gracia, para que
  // el link siga sirviendo aunque el dueño lo abra tarde (no es un pago de 30 min como el on-demand).
  const token = randomUUID()
  const tokenExpiraEn = new Date(sub.trialFin.getTime() + DIAS_GRACIA * 24 * 60 * 60 * 1000)
  const factura = await crearFacturaSuscripcionPendiente(db, sub.restauranteId, {
    ciclo: 'mensual',
    // Un trial nunca arrastra módulos pagos, ni siquiera ante datos incoherentes.
    soloBase: true,
    token,
    tokenExpiraEn,
  })

  const envio = await sendTrialEndingWhatsApp(fakeCtx, {
    phone: telefono,
    nombre: rest?.nombre || 'tu local',
    fechaFin: formatearFechaFin(sub.trialFin),
    plata: fmtPlata(plataTrial),
    precio: fmtPrecio(factura.montoTotal),
    token,
  })

  if (!envio.success) {
    // Error transitorio (red / API): NO marcamos → se reintenta en el próximo tick.
    return { marcar: false }
  }
  return { marcar: true }
}

/**
 * Tick del scheduler: busca trials que vencen dentro de TRIAL_AVISO_ANTES_DIAS días y aún no
 * avisados, y les manda el aviso de vencimiento con link de pago. Respeta una franja horaria diurna
 * (Argentina) para no molestar de madrugada. Best-effort por local.
 */
export async function tickAvisosTrial(db: Db, ahora: number = Date.now()): Promise<void> {
  const hora = horaArgentina(ahora)
  if (hora < HORA_MIN || hora >= HORA_MAX) return // fuera de la franja diurna: esperamos al próximo tick

  const ahoraDate = new Date(ahora)
  const limite = new Date(ahora + TRIAL_AVISO_ANTES_DIAS * 24 * 60 * 60 * 1000)

  const trials = await db
    .select({
      restauranteId: SuscripcionTable.restauranteId,
      trialFin: SuscripcionTable.trialFin,
      fechaInicio: SuscripcionTable.fechaInicio,
    })
    .from(SuscripcionTable)
    .where(
      and(
        eq(SuscripcionTable.estado, 'trial'),
        isNull(SuscripcionTable.avisoTrialVencimientoAt),
        // trialFin en (ahora, ahora + 2d]: por vencer, pero todavía no vencido (si ya venció, el aviso
        // "termina el X" en pasado no tiene sentido y resolverEstadoVigente lo pasa a pago_pendiente).
        gt(SuscripcionTable.trialFin, ahoraDate),
        lte(SuscripcionTable.trialFin, limite),
      ),
    )

  for (const sub of trials) {
    if (!sub.trialFin) continue // guard de tipos (el filtro gt/lte ya lo garantiza no-null)
    try {
      const { marcar } = await procesarTrial(db, {
        restauranteId: sub.restauranteId,
        trialFin: new Date(sub.trialFin),
        fechaInicio: sub.fechaInicio ? new Date(sub.fechaInicio) : null,
      })
      if (marcar) {
        await db
          .update(SuscripcionTable)
          .set({ avisoTrialVencimientoAt: new Date(ahora) })
          .where(eq(SuscripcionTable.restauranteId, sub.restauranteId))
      }
    } catch (err) {
      console.error(`❌ [Trial aviso] falló para restaurante ${sub.restauranteId}:`, err)
    }
  }
}
