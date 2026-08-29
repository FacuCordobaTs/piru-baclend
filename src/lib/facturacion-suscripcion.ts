/** Facturación compuesta de la suscripción base y módulos pagos.
 *
 * Este archivo sólo crea el comprobante pendiente e ítems congelados. La
 * acreditación/activación idempotente corresponde a T08.
 */
import { and, eq } from 'drizzle-orm'
import { type MySql2Database } from 'drizzle-orm/mysql2'
import {
  configuracionSuscripcion as ConfiguracionSuscripcionTable,
  modulo as ModuloTable,
  packRecarga as PackRecargaTable,
  pagoSuscripcion as PagoSuscripcionTable,
  pagoSuscripcionItem as PagoSuscripcionItemTable,
  plan as PlanTable,
  recargaMensajes as RecargaMensajesTable,
  restauranteModulo as RestauranteModuloTable,
  suscripcion as SuscripcionTable,
} from '../db/schema'
import { SUSCRIPCION_UNICA_CODIGO } from './suscripcion'
import { resolverRepresentacionCanonicaCrecimiento } from './modulos'

type Db = MySql2Database<Record<string, never>>
export type CicloFactura = 'mensual' | 'anual'

export interface ItemFacturaCalculado {
  tipo: 'base' | 'modulo' | 'pack_mensajes'
  moduloId: number | null
  codigo: string
  descripcion: string
  precioUnitario: number
  monto: number
  desde: Date | null
  hasta: Date | null
}

type ModuloFacturable = {
  codigo: string
  estado: string | null
}

/** Un trial factura exclusivamente la base, aun si existiera un entitlement incoherente. */
export function seleccionarModulosFacturables<T extends ModuloFacturable>(
  modulos: T[],
  opts: { soloModuloCodigo?: string; soloBase?: boolean },
): T[] {
  const seleccionados = modulos.filter((modulo) => {
    if (opts.soloBase) return false
    if (opts.soloModuloCodigo) return modulo.codigo === opts.soloModuloCodigo
    return modulo.estado === 'activo'
  })
  return resolverRepresentacionCanonicaCrecimiento(seleccionados)
}

export function mesesDelCiclo(ciclo: CicloFactura): number {
  return ciclo === 'anual' ? 12 : 1
}

export function sumarMesesCalendario(fecha: Date, meses: number): Date {
  const resultado = new Date(fecha)
  const dia = resultado.getDate()
  resultado.setMonth(resultado.getMonth() + meses)
  if (resultado.getDate() < dia) resultado.setDate(0)
  return resultado
}

/**
 * Una renovación anticipada empieza al finalizar la cobertura ya pagada. Si
 * la cobertura ya venció (o la suscripción está suspendida/cancelada), vuelve
 * a empezar hoy. Así un checkout nunca recorta días ya pagos.
 */
export function inicioPeriodoFactura(
  ahora: Date,
  suscripcion: { estado: string; fechaProximoCobro: Date | null } | null,
): Date {
  const vence = suscripcion?.fechaProximoCobro ? new Date(suscripcion.fechaProximoCobro) : null
  if (
    vence && vence > ahora
    && (suscripcion?.estado === 'activa' || suscripcion?.estado === 'pago_pendiente')
  ) return vence
  return ahora
}

/** Precio de un componente mensual para el ciclo, con descuento anual global. */
function descuentoAnualSeguro(descuentoAnual: number): number {
  return Math.max(0, Math.min(20, Math.round(Number.isFinite(descuentoAnual) ? descuentoAnual : 0)))
}

export function importePorCiclo(precioMensual: number, ciclo: CicloFactura, descuentoAnual: number): number {
  if (ciclo === 'mensual') return Math.round(precioMensual)
  return Math.round(precioMensual * 12 * (1 - descuentoAnualSeguro(descuentoAnual) / 100))
}

/** D3: días calendario restantes, inclusivo del día de activación. */
export function importeProrrateado(
  precioMensual: number,
  ciclo: CicloFactura,
  descuentoAnual: number,
  desde: Date,
  hasta: Date,
): number {
  const totalMs = hasta.getTime() - sumarMesesCalendario(hasta, -mesesDelCiclo(ciclo)).getTime()
  const restanteMs = hasta.getTime() - desde.getTime()
  const diasTotales = Math.max(1, Math.ceil(totalMs / 86_400_000))
  const diasRestantes = Math.max(1, Math.ceil(restanteMs / 86_400_000))
  return Math.round(importePorCiclo(precioMensual, ciclo, descuentoAnual) * diasRestantes / diasTotales)
}

export async function crearFacturaSuscripcionPendiente(
  db: Db,
  restauranteId: number,
  opts: { ciclo: CicloFactura; soloModuloCodigo?: string; soloBase?: boolean; packId?: number; token?: string; tokenExpiraEn?: Date },
): Promise<{ pagoId: number; recargaMensajesId: number | null; montoBase: number; montoModulos: number; montoRecarga: number; montoTotal: number; items: ItemFacturaCalculado[] }> {
  const [configuracion, suscripcionActual, planCompatible] = await Promise.all([
    db.select().from(ConfiguracionSuscripcionTable).where(eq(ConfiguracionSuscripcionTable.codigo, SUSCRIPCION_UNICA_CODIGO)).limit(1).then((r) => r[0]),
    db.select().from(SuscripcionTable).where(eq(SuscripcionTable.restauranteId, restauranteId)).limit(1).then((r) => r[0] ?? null),
    // Columna obligatoria hasta T43: sólo alias técnico para admins anteriores.
    db.select({ id: PlanTable.id }).from(PlanTable).where(and(eq(PlanTable.codigo, 'basico'), eq(PlanTable.activo, true))).limit(1).then((r) => r[0]),
  ])
  if (!configuracion || !configuracion.activo) throw new Error('La suscripción Piru no está disponible')
  if (!planCompatible) throw new Error('Falta el plan compatible requerido durante la transición')

  const ciclo = opts.soloModuloCodigo ? suscripcionActual?.ciclo as CicloFactura : opts.ciclo
  if (ciclo !== 'mensual' && ciclo !== 'anual') throw new Error('La suscripción no tiene un ciclo vigente')
  const ahora = new Date()
  const periodoDesde = opts.soloModuloCodigo
    ? ahora
    : inicioPeriodoFactura(ahora, suscripcionActual)
  const periodoHasta = sumarMesesCalendario(periodoDesde, mesesDelCiclo(ciclo))
  const items: ItemFacturaCalculado[] = []
  if (!opts.soloModuloCodigo) {
    const precio = Number(configuracion.precioMensual)
    items.push({ tipo: 'base', moduloId: null, codigo: configuracion.codigo, descripcion: configuracion.nombre, precioUnitario: precio, monto: importePorCiclo(precio, ciclo, configuracion.descuentoAnual), desde: periodoDesde, hasta: periodoHasta })
  }

  const modulos = await db.select({
    id: ModuloTable.id, codigo: ModuloTable.codigo, nombre: ModuloTable.nombre,
    precioMensual: ModuloTable.precioMensual, estado: RestauranteModuloTable.estado,
    precioCongelado: RestauranteModuloTable.precioMensualCongelado, origen: RestauranteModuloTable.origen,
  }).from(ModuloTable)
    .leftJoin(RestauranteModuloTable, and(eq(RestauranteModuloTable.moduloId, ModuloTable.id), eq(RestauranteModuloTable.restauranteId, restauranteId)))
    .where(and(eq(ModuloTable.tipo, 'pago'), eq(ModuloTable.activo, true)))

  const candidatos = seleccionarModulosFacturables(modulos, opts)
  if (opts.soloModuloCodigo && candidatos.length !== 1) throw new Error('Módulo pago no encontrado')
  if (opts.soloModuloCodigo && (!suscripcionActual?.fechaProximoCobro || !['activa', 'pago_pendiente'].includes(suscripcionActual.estado))) {
    throw new Error('Primero activá la suscripción base')
  }

  for (const modulo of candidatos) {
    const precio = Number(modulo.precioCongelado ?? modulo.precioMensual)
    if (precio <= 0) continue
    const esAltaProrrateada = Boolean(opts.soloModuloCodigo)
    const hasta = esAltaProrrateada ? new Date(suscripcionActual!.fechaProximoCobro!) : periodoHasta
    const monto = esAltaProrrateada
      ? importeProrrateado(precio, ciclo, configuracion.descuentoAnual, periodoDesde, hasta)
      : importePorCiclo(precio, ciclo, configuracion.descuentoAnual)
    items.push({ tipo: 'modulo', moduloId: modulo.id, codigo: modulo.codigo, descripcion: modulo.nombre, precioUnitario: precio, monto, desde: periodoDesde, hasta })
  }

  let packSeleccionado: { id: number; cantidad: number; precio: number } | null = null
  if (opts.packId != null) {
    const avisosIncluidos = candidatos.some((modulo) => modulo.codigo === 'avisos_automaticos_whatsapp')
    if (!avisosIncluidos) throw new Error('El pack sólo puede agregarse junto al módulo de Avisos automáticos')
    const [pack] = await db.select().from(PackRecargaTable)
      .where(and(eq(PackRecargaTable.id, opts.packId), eq(PackRecargaTable.activo, true), eq(PackRecargaTable.categoria, 'utility')))
      .limit(1)
    if (!pack) throw new Error('Pack de avisos no encontrado')
    const precio = Number(pack.precio)
    packSeleccionado = { id: pack.id, cantidad: pack.cantidad, precio }
    items.push({
      tipo: 'pack_mensajes', moduloId: null, codigo: `pack_utility_${pack.id}`,
      descripcion: `${pack.nombre} · ${pack.cantidad} avisos`,
      precioUnitario: precio, monto: precio, desde: null, hasta: null,
    })
  }
  if (!items.length) throw new Error('No hay conceptos para facturar')

  const montoBase = items.filter((i) => i.tipo === 'base').reduce((n, i) => n + i.monto, 0)
  const montoModulos = items.filter((i) => i.tipo === 'modulo').reduce((n, i) => n + i.monto, 0)
  const montoRecarga = items.filter((i) => i.tipo === 'pack_mensajes').reduce((n, i) => n + i.monto, 0)
  const montoTotal = montoBase + montoModulos + montoRecarga
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Db
    let recargaMensajesId: number | null = null
    if (packSeleccionado) {
      const recargaInsert = await txDb.insert(RecargaMensajesTable).values({
        restauranteId, categoria: 'utility', packRecargaId: packSeleccionado.id,
        cantidad: packSeleccionado.cantidad, monto: packSeleccionado.precio.toFixed(2),
        origen: 'manual', estado: 'pending',
      })
      recargaMensajesId = Number((recargaInsert as any)[0].insertId)
    }
    const insert = await txDb.insert(PagoSuscripcionTable).values({
      restauranteId, planId: planCompatible.id, configuracionSuscripcionId: configuracion.id, ciclo,
      monto: montoTotal.toFixed(2), montoBase: montoBase.toFixed(2), montoModulos: montoModulos.toFixed(2),
      montoRecarga: montoRecarga.toFixed(2), recargaMensajesId, montoTotal: montoTotal.toFixed(2),
      token: opts.token ?? null, tokenExpiraEn: opts.tokenExpiraEn ?? null, estado: 'pending',
    })
    const pagoId = Number((insert as any)[0].insertId)
    await txDb.insert(PagoSuscripcionItemTable).values(items.map((item) => ({
      pagoSuscripcionId: pagoId, tipo: item.tipo, moduloId: item.moduloId, codigo: item.codigo,
      descripcion: item.descripcion, cantidad: 1, precioUnitario: item.precioUnitario.toFixed(2), monto: item.monto.toFixed(2),
      desde: item.desde, hasta: item.hasta,
    })))
    return { pagoId, recargaMensajesId, montoBase, montoModulos, montoRecarga, montoTotal, items }
  })
}
