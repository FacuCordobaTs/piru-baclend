// src/lib/claim.ts
// Claim flow (onboarding outbound) — ver docs/ROADMAP_CLAIM_FLOW.md
//
// El fundador arma una tienda demo (prospecto) y comparte un link de reclamo
// (admin.piru.app/mi-tienda/{claimToken}). El dueño lo "reclama" verificando su WhatsApp: la cuenta
// del prospecto y la del dueño son LA MISMA fila de `restaurante` (el claim sólo cambia el estado).
// Este módulo centraliza: generar/resolver el token, computar el inventario ("esto ya está listo")
// y derivar el pipeline (prospecto → reclamada → trial → activa → pausada) desde los datos.
import { type MySql2Database } from 'drizzle-orm/mysql2'
import { eq, count } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import {
  restaurante as RestauranteTable,
  producto as ProductoTable,
  zonaDelivery as ZonaDeliveryTable,
  pedidoUnificado as PedidoUnificadoTable,
} from '../db/schema'
import { SUSCRIPCION_ESTADOS } from './planes'
import { resolveMetodosPagoConfig, rowToPagoRow } from './metodos-pago'

type Db = MySql2Database<Record<string, never>>

/** Base del link de reclamo. Debe coincidir con el admin (misma que ADMIN_URL). */
const ADMIN_URL = (process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')

/** Un prospecto no reclamado expira a los 14 días (mini-FOMO real del follow-up). */
export const CLAIM_TOKEN_TTL_DIAS = 14

/** URL completa del link de reclamo para un token. */
export const buildClaimUrl = (token: string) => `${ADMIN_URL}/mi-tienda/${token}`

/**
 * Genera (o regenera) el link de reclamo de una tienda. Setea un token único y su expiración, y
 * marca la cuenta como `origen='outbound'` (es una tienda que se reclama, no self-serve).
 * Devuelve el token, la URL completa y la fecha de expiración.
 */
export async function generarClaimLink(
  db: Db,
  restauranteId: number,
  ttlDias: number = CLAIM_TOKEN_TTL_DIAS,
): Promise<{ token: string; url: string; expira: Date }> {
  const token = randomUUID().replace(/-/g, '')
  const expira = new Date(Date.now() + ttlDias * 24 * 60 * 60 * 1000)

  await db
    .update(RestauranteTable)
    .set({ origen: 'outbound', claimToken: token, claimTokenExpira: expira })
    .where(eq(RestauranteTable.id, restauranteId))

  return { token, url: `${ADMIN_URL}/mi-tienda/${token}`, expira }
}

/** Resuelve la fila de restaurante por su token de reclamo (o null si no existe). */
export async function getRestaurantePorClaimToken(db: Db, token: string) {
  if (!token) return null
  const [rest] = await db
    .select()
    .from(RestauranteTable)
    .where(eq(RestauranteTable.claimToken, token))
    .limit(1)
  return rest ?? null
}

/** ¿El token está vigente para reclamar? (existe, no expiró y todavía no fue reclamado). */
export function claimTokenVigente(rest: {
  claimTokenExpira?: Date | string | null
  claimedAt?: Date | string | null
} | null): boolean {
  if (!rest) return false
  if (rest.claimedAt) return false
  if (!rest.claimTokenExpira) return true
  return new Date(rest.claimTokenExpira) > new Date()
}

export interface InventarioClaim {
  /** Ítems del checklist "esto ya está listo" (los tildados los completó el fundador). */
  productos: number
  tieneImagen: boolean
  tieneCobros: boolean
  zonasDelivery: number
  primerPedido: boolean
  tieneNombre: boolean
  tieneLink: boolean
}

/**
 * Computa el inventario de lo que la tienda YA tiene cargado — la materia prima de la pantalla
 * "esto ya está listo" (reciprocidad: mostrarle cuánto trabajo se le regaló). Barato: 3 counts.
 */
export async function computarInventarioClaim(
  db: Db,
  restauranteId: number,
): Promise<InventarioClaim> {
  const [rest] = await db
    .select({
      nombre: RestauranteTable.nombre,
      username: RestauranteTable.username,
      imagenUrl: RestauranteTable.imagenUrl,
      imagenLightUrl: RestauranteTable.imagenLightUrl,
      mpConnected: RestauranteTable.mpConnected,
      transferenciaAlias: RestauranteTable.transferenciaAlias,
      cucuruConfigurado: RestauranteTable.cucuruConfigurado,
      proveedorPago: RestauranteTable.proveedorPago,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  const [[prodRow], [zonaRow], [pedidoRow]] = await Promise.all([
    db.select({ n: count() }).from(ProductoTable).where(eq(ProductoTable.restauranteId, restauranteId)),
    db.select({ n: count() }).from(ZonaDeliveryTable).where(eq(ZonaDeliveryTable.restauranteId, restauranteId)),
    db.select({ n: count() }).from(PedidoUnificadoTable).where(eq(PedidoUnificadoTable.restauranteId, restauranteId)),
  ])

  const tieneCobros = !!(
    rest?.mpConnected ||
    rest?.transferenciaAlias ||
    rest?.cucuruConfigurado ||
    (rest?.proveedorPago && rest.proveedorPago !== 'manual')
  )

  return {
    productos: Number(prodRow?.n ?? 0),
    tieneImagen: !!(rest?.imagenUrl || rest?.imagenLightUrl),
    tieneCobros,
    zonasDelivery: Number(zonaRow?.n ?? 0),
    primerPedido: Number(pedidoRow?.n ?? 0) > 0,
    tieneNombre: !!rest?.nombre,
    tieneLink: !!rest?.username,
  }
}

/**
 * Config editable de la tienda para el claim (onboarding outbound). El dueño, al reclamar, puede
 * revisar y ajustar lo que Facu dejó cargado SIN entrar todavía al panel: métodos de pago + alias,
 * precio/zonas de delivery y ver sus productos. Es la materia prima del recorrido de aprobación
 * (`ClaimTienda.tsx`). Público bajo el token secreto del claim; todos estos datos ya son visibles
 * para el comensal en la tienda (métodos al checkout, alias al transferir, precios de envío), así
 * que no expone nada nuevo.
 */
export interface ConfigClaim {
  pagos: {
    efectivo: boolean
    transferenciaManual: boolean
    transferenciaAutomatica: boolean
    mercadopagoCheckout: boolean
    transferenciaAlias: string | null
    /** Transferencia automática (Cucuru/Talo) disponible: si lo está, la manual no se usa. */
    autoTransferAvailable: boolean
    mpConnected: boolean
  }
  delivery: {
    deliveryEnabled: boolean
    /** Centro para el mapa (dirección del local); null si no está geocodificada. */
    lat: number | null
    lng: number | null
    zonas: Array<{
      id: number
      nombre: string
      precio: string
      poligono: unknown
      color: string | null
    }>
  }
  productos: Array<{ id: number; nombre: string; precio: string; imagenUrl: string | null }>
}

/**
 * Computa la config editable de la tienda para el recorrido del claim. Barato: una fila de
 * restaurante + zonas + productos. Reusa `resolveMetodosPagoConfig` (la misma verdad que usa el
 * checkout) para que lo que ve el dueño coincida con lo que ve el comensal.
 */
export async function computarConfigClaim(db: Db, restauranteId: number): Promise<ConfigClaim> {
  const [rest] = await db
    .select({
      metodosPagoConfig: RestauranteTable.metodosPagoConfig,
      cardsPaymentsEnabled: RestauranteTable.cardsPaymentsEnabled,
      mpConnected: RestauranteTable.mpConnected,
      mpPublicKey: RestauranteTable.mpPublicKey,
      cucuruConfigurado: RestauranteTable.cucuruConfigurado,
      cucuruEnabled: RestauranteTable.cucuruEnabled,
      proveedorPago: RestauranteTable.proveedorPago,
      taloClientId: RestauranteTable.taloClientId,
      taloClientSecret: RestauranteTable.taloClientSecret,
      taloUserId: RestauranteTable.taloUserId,
      transferenciaAlias: RestauranteTable.transferenciaAlias,
      deliveryEnabled: RestauranteTable.deliveryEnabled,
      direccionLat: RestauranteTable.direccionLat,
      direccionLng: RestauranteTable.direccionLng,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  const [zonas, productos] = await Promise.all([
    db
      .select({
        id: ZonaDeliveryTable.id,
        nombre: ZonaDeliveryTable.nombre,
        precio: ZonaDeliveryTable.precio,
        poligono: ZonaDeliveryTable.poligono,
        color: ZonaDeliveryTable.color,
      })
      .from(ZonaDeliveryTable)
      .where(eq(ZonaDeliveryTable.restauranteId, restauranteId)),
    db
      .select({
        id: ProductoTable.id,
        nombre: ProductoTable.nombre,
        precio: ProductoTable.precio,
        imagenUrl: ProductoTable.imagenUrl,
      })
      .from(ProductoTable)
      .where(eq(ProductoTable.restauranteId, restauranteId)),
  ])

  const cfg = rest
    ? resolveMetodosPagoConfig(rowToPagoRow(rest))
    : { efectivo: true, transferenciaManual: false, transferenciaAutomatica: false, mercadopagoCheckout: false, mercadopagoBricks: false }

  const autoTransferAvailable =
    !!(rest?.cucuruConfigurado && rest?.cucuruEnabled !== false) ||
    (rest?.proveedorPago === 'talo' && !!(rest?.taloClientId && rest?.taloClientSecret && rest?.taloUserId))

  return {
    pagos: {
      efectivo: cfg.efectivo,
      transferenciaManual: cfg.transferenciaManual,
      transferenciaAutomatica: cfg.transferenciaAutomatica,
      mercadopagoCheckout: cfg.mercadopagoCheckout,
      transferenciaAlias: rest?.transferenciaAlias ?? null,
      autoTransferAvailable,
      mpConnected: !!rest?.mpConnected,
    },
    delivery: {
      deliveryEnabled: rest?.deliveryEnabled !== false,
      lat: rest?.direccionLat != null ? Number(rest.direccionLat) : null,
      lng: rest?.direccionLng != null ? Number(rest.direccionLng) : null,
      zonas: zonas.map((z) => ({
        id: z.id,
        nombre: z.nombre,
        precio: String(z.precio),
        poligono: z.poligono,
        color: z.color ?? null,
      })),
    },
    productos: productos.map((p) => ({
      id: p.id,
      nombre: p.nombre,
      precio: String(p.precio),
      imagenUrl: p.imagenUrl ?? null,
    })),
  }
}

/** Un prospecto se considera "por expirar" cuando le quedan ≤ este umbral (hoy/mañana). */
export const CLAIM_ALERTA_DIAS = 1

export type ExpiracionAlerta = 'por_expirar' | 'expirado' | null

export interface ExpiracionClaim {
  /** Días (con signo) hasta que el link de reclamo expira. Negativo = ya expiró. null si no aplica. */
  diasParaExpirar: number | null
  /** Alerta para el fundador: 'por_expirar' (último toque), 'expirado' (nunca la abrió) o null. */
  alerta: ExpiracionAlerta
}

/**
 * Deriva el estado de expiración del LINK DE RECLAMO de un prospecto — la materia prima del aviso
 * "la tienda de [Local] expira mañana y nunca la abrió" (el último toque del follow-up). Sólo aplica
 * a tiendas outbound **no reclamadas** con token: una vez reclamada (o self-serve) el token deja de
 * importar. No es un enum guardado: se calcula de `origen` + `claimedAt` + `claimTokenExpira`.
 */
export function derivarExpiracionClaim(
  rest: {
    origen?: string | null
    claimedAt?: Date | string | null
    claimToken?: string | null
    claimTokenExpira?: Date | string | null
  } | null,
  umbralDias: number = CLAIM_ALERTA_DIAS,
): ExpiracionClaim {
  const sinAlerta: ExpiracionClaim = { diasParaExpirar: null, alerta: null }
  if (!rest) return sinAlerta
  // Sólo prospectos: outbound, con token y todavía sin reclamar.
  if (rest.origen !== 'outbound' || rest.claimedAt || !rest.claimToken) return sinAlerta
  if (!rest.claimTokenExpira) return sinAlerta // sin fecha de expiración → no expira

  const ms = new Date(rest.claimTokenExpira).getTime() - Date.now()
  const diasParaExpirar = Math.ceil(ms / (24 * 60 * 60 * 1000))
  const alerta: ExpiracionAlerta =
    ms <= 0 ? 'expirado' : diasParaExpirar <= umbralDias ? 'por_expirar' : null

  return { diasParaExpirar, alerta }
}

export type Pipeline = 'self_serve' | 'prospecto' | 'reclamada' | 'trial' | 'activa' | 'pausada'

/**
 * Deriva el estado del pipeline de ventas desde los datos (no es un enum guardado): el "interno"
 * de Facu pasa a ser su CRM gratis. Prioridad: el estado de la suscripción manda; si no hay
 * suscripción activa/trial, se mira si la tienda outbound ya fue reclamada.
 */
export function derivarPipeline(args: {
  origen: string | null | undefined
  claimedAt: Date | string | null | undefined
  estado: string | null | undefined
}): Pipeline {
  const { origen, claimedAt, estado } = args
  if (estado === SUSCRIPCION_ESTADOS.TRIAL) return 'trial'
  if (estado === SUSCRIPCION_ESTADOS.ACTIVA) return 'activa'
  if (
    estado === SUSCRIPCION_ESTADOS.PAGO_PENDIENTE ||
    estado === SUSCRIPCION_ESTADOS.SUSPENDIDA ||
    estado === SUSCRIPCION_ESTADOS.CANCELADA
  ) {
    return 'pausada'
  }
  // Sin suscripción con acceso: distinguir prospecto (outbound sin reclamar) de reclamada.
  if (origen === 'outbound') return claimedAt ? 'reclamada' : 'prospecto'
  return 'self_serve'
}
