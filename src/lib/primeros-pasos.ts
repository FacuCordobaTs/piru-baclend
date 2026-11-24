/**
 * "Primeros pasos" del panel para las tiendas creadas por registro self-serve (como la pantalla de
 * inicio de Tiendanube: "Chequeá los pasos para dejar tu tienda a tu manera"). Los pasos no se
 * guardan: se deducen de los datos del local, así nunca quedan desfasados de lo que hizo el dueño.
 */
import { and, count, eq, isNull } from 'drizzle-orm'
import { type MySql2Database } from 'drizzle-orm/mysql2'
import {
  horarioRestaurante as HorarioTable,
  producto as ProductoTable,
  restaurante as RestauranteTable,
  sitioTienda as SitioTiendaTable,
  zonaDelivery as ZonaDeliveryTable,
} from '../db/schema'

type Db = MySql2Database<Record<string, never>>

export type PasoId = 'crear_tienda' | 'productos' | 'whatsapp' | 'horarios' | 'entregas' | 'pagos' | 'diseno'

export interface Paso {
  id: PasoId
  hecho: boolean
  /** Un paso opcional no cuenta para terminar (por ejemplo, el diseño en el plan Inicial). */
  opcional: boolean
}

export interface DatosPasos {
  productos: number
  whatsapp: string | null
  horarios: number
  zonas: number
  deliveryEnabled: boolean
  takeawayEnabled: boolean
  direccion: string | null
  mpConnected: boolean
  transferenciaAlias: string | null
  tieneSitio: boolean
  disenoEnPlan: boolean
}

/** Política pura de cada paso. */
export function calcularPasos(d: DatosPasos): Paso[] {
  const texto = (v: string | null) => Boolean(v && v.trim())
  return [
    { id: 'crear_tienda', hecho: true, opcional: false },
    { id: 'productos', hecho: d.productos > 0, opcional: false },
    // La tienda manda cada pedido a este WhatsApp: sin él, el pedido no llega a nadie.
    { id: 'whatsapp', hecho: texto(d.whatsapp), opcional: false },
    // Sin horarios la tienda figura cerrada: es lo que impide vender antes de estar listo.
    { id: 'horarios', hecho: d.horarios > 0, opcional: false },
    {
      id: 'entregas',
      hecho: (d.deliveryEnabled && d.zonas > 0) || (d.takeawayEnabled && texto(d.direccion)),
      opcional: false,
    },
    { id: 'pagos', hecho: d.mpConnected || texto(d.transferenciaAlias), opcional: false },
    { id: 'diseno', hecho: d.disenoEnPlan && d.tieneSitio, opcional: !d.disenoEnPlan },
  ]
}

export function resumenPasos(pasos: Paso[]) {
  const obligatorios = pasos.filter((p) => !p.opcional)
  const completados = obligatorios.filter((p) => p.hecho).length
  return { completados, total: obligatorios.length, terminado: completados === obligatorios.length }
}

export async function leerDatosPasos(db: Db, restauranteId: number, disenoEnPlan: boolean): Promise<DatosPasos | null> {
  const [local] = await db
    .select({
      telefono: RestauranteTable.telefono,
      comprobantesWhatsapp: RestauranteTable.comprobantesWhatsapp,
      deliveryEnabled: RestauranteTable.deliveryEnabled,
      takeawayEnabled: RestauranteTable.takeawayEnabled,
      direccion: RestauranteTable.direccion,
      mpConnected: RestauranteTable.mpConnected,
      transferenciaAlias: RestauranteTable.transferenciaAlias,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)
  if (!local) return null

  const [[productos], [horarios], [zonas], [sitio]] = await Promise.all([
    db.select({ n: count() }).from(ProductoTable)
      .where(and(eq(ProductoTable.restauranteId, restauranteId), isNull(ProductoTable.eventoSucursalId))),
    db.select({ n: count() }).from(HorarioTable).where(eq(HorarioTable.restauranteId, restauranteId)),
    db.select({ n: count() }).from(ZonaDeliveryTable).where(eq(ZonaDeliveryTable.restauranteId, restauranteId)),
    db.select({ id: SitioTiendaTable.id }).from(SitioTiendaTable).where(eq(SitioTiendaTable.restauranteId, restauranteId)).limit(1),
  ])

  return {
    productos: Number(productos?.n ?? 0),
    whatsapp: local.comprobantesWhatsapp || local.telefono,
    horarios: Number(horarios?.n ?? 0),
    zonas: Number(zonas?.n ?? 0),
    deliveryEnabled: Boolean(local.deliveryEnabled),
    takeawayEnabled: Boolean(local.takeawayEnabled),
    direccion: local.direccion,
    mpConnected: Boolean(local.mpConnected),
    transferenciaAlias: local.transferenciaAlias,
    tieneSitio: Boolean(sitio),
    disenoEnPlan,
  }
}
