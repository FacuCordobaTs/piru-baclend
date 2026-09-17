// src/lib/recupero.ts
//
// Recupero de clientes — playbook de dormidos conservado por compatibilidad/transición.
//
// El endpoint por cliente es una ACCIÓN VOLUNTARIA del local; estas primitivas también son
// reutilizadas por el motor persistente de goteo. Modelo vigente y compatibilidad:
// docs/CUSTOMERS_AND_GROWTH.md.
//
// La ESCALERA DE INCENTIVOS es la clave: no se regala descuento de entrada.
//   nivel 1 → sin descuento (solo antojo: foto de lo que más pide + "repetí tu pedido")
//   nivel 2 → descuento chico (10%)
//   nivel 3 → oferta fuerte (20%) con vencimiento (48 hs)
// El próximo nivel se deriva de cuántos toques se enviaron DESPUÉS del último pedido del cliente:
// si volvió a pedir, la escalera se reinicia sola (se detiene apenas el cliente vuelve).
//
// Reserva el bucket `marketing` antes de llamar a WhatsApp: retención nunca genera deuda.
// El envío usa las credenciales de Meta del propio local (marca del local).

import { type MySql2Database } from 'drizzle-orm/mysql2'
import { and, eq, inArray, notInArray, desc } from 'drizzle-orm'
import {
  cliente as ClienteTable,
  restaurante as RestauranteTable,
  pedidoUnificado as PedidoUnificadoTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  producto as ProductoTable,
  codigoDescuento as CodigoDescuentoTable,
  recuperoCliente as RecuperoClienteTable,
  campanaRecompra as CampanaRecompraTable,
  campanaRecompraCliente as CampanaRecompraClienteTable,
} from '../db/schema'
import {
  compensarReservaCreditoMarketing,
  confirmarReservaCreditoMarketing,
  reservarCreditoMarketing,
} from './mensajes-wallet'
import { computarPerfilesRFM, type SegmentoCliente } from './clientes-rfm'
import { sendClientRecuperoWhatsApp, resolverCredsRestaurante } from '../services/whatsapp'
import {
  chequearProteccionMarketing,
  enHorarioSilencio,
  contarToquesEnVentana,
  TOPE_MARKETING_POR_CLIENTE,
  type MotivoBloqueoMarketing,
} from './proteccion-base'
import { normalizarTelefonoCliente } from './clientes-identidad'
import { cifrarGrowthPayload } from './marketing-crypto'
import { BASE_TIENDA, urlMicroCampana } from './marketing-enlaces'

type Db = MySql2Database<Record<string, never>>

// ── Definición de la escalera ────────────────────────────────────────────────
export interface EscalonRecupero {
  nivel: number
  /** % de descuento del cupón (0 = sin descuento). */
  descuento: number
  /** Vencimiento del cupón en horas (null = sin vencimiento). */
  expiraHoras: number | null
  /** Rótulo corto para la UI. */
  titulo: string
  /** Descripción para la UI (qué se le va a mandar). */
  detalle: string
}

export const ESCALERA: EscalonRecupero[] = [
  {
    nivel: 1,
    descuento: 0,
    expiraHoras: null,
    titulo: 'Primer toque · sin descuento',
    detalle: 'Solo un antojo: la foto de lo que más pide + invitación a repetir su pedido. No se regala margen a quien vuelve gratis.',
  },
  {
    nivel: 2,
    descuento: 10,
    expiraHoras: null,
    titulo: 'Segundo toque · 10% de descuento',
    detalle: 'Si no volvió con el primer toque, un empujón chico: 10% con un código propio.',
  },
  {
    nivel: 3,
    descuento: 20,
    expiraHoras: 48,
    titulo: 'Último toque · 20% OFF con vencimiento',
    detalle: 'Oferta fuerte y con urgencia: 20% que vence en 48 hs. Es el último intento.',
  },
]

export const NIVEL_MAX = ESCALERA.length

/** No se permite reenviar otro toque dentro de esta ventana (protección mínima anti-spam). */
export const COOLDOWN_HORAS = 48

const MS_POR_DIA = 1000 * 60 * 60 * 24
const MS_POR_HORA = 1000 * 60 * 60

export interface EstadoRecupero {
  /** Toques enviados en total al cliente (histórico). */
  totalEnvios: number
  /** Timestamp ISO del último toque enviado, o null. */
  ultimoEnvioAt: string | null
  /** Nivel del último toque enviado, o null. */
  ultimoNivel: number | null
  /** Próximo escalón a enviar (1..NIVEL_MAX). */
  proximoNivel: number
  /** false si estamos dentro del cooldown (hay que esperar antes de insistir). */
  puedeEnviar: boolean
}

interface Toque {
  nivel: number
  createdAt: Date
}

/**
 * Deriva el estado de la escalera para un cliente a partir de sus toques previos y la fecha de su
 * último pedido. El próximo nivel cuenta sólo los toques posteriores al último pedido (si volvió a
 * pedir, la escalera se reinicia). Capado en NIVEL_MAX.
 */
export function estadoRecupero(
  toques: Toque[],
  ultimoPedidoMs: number | null,
  ahora: number = Date.now(),
): EstadoRecupero {
  const ordenados = [...toques].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  const ultimo = ordenados[ordenados.length - 1] ?? null

  // Toques enviados DESPUÉS del último pedido (los previos ya "cumplieron": el cliente pidió).
  const desdeUltimoPedido = ultimoPedidoMs != null
    ? ordenados.filter((t) => t.createdAt.getTime() > ultimoPedidoMs)
    : ordenados

  const proximoNivel = Math.min(desdeUltimoPedido.length + 1, NIVEL_MAX)

  const puedeEnviar = ultimo == null
    ? true
    : (ahora - ultimo.createdAt.getTime()) >= COOLDOWN_HORAS * MS_POR_HORA

  return {
    totalEnvios: ordenados.length,
    ultimoEnvioAt: ultimo ? ultimo.createdAt.toISOString() : null,
    ultimoNivel: ultimo ? ultimo.nivel : null,
    proximoNivel,
    puedeEnviar,
  }
}

/** Carga los toques de recupero de varios clientes de un local, agrupados por clienteId. */
export async function cargarToquesPorCliente(
  db: Db,
  restauranteId: number,
  clienteIds: number[],
): Promise<Record<number, Toque[]>> {
  const map: Record<number, Toque[]> = {}
  if (clienteIds.length === 0) return map
  const rows = await db
    .select({
      clienteId: RecuperoClienteTable.clienteId,
      nivel: RecuperoClienteTable.nivel,
      createdAt: RecuperoClienteTable.createdAt,
    })
    .from(RecuperoClienteTable)
    .where(
      and(
        eq(RecuperoClienteTable.restauranteId, restauranteId),
        inArray(RecuperoClienteTable.clienteId, clienteIds),
      ),
    )
  for (const r of rows) {
    if (!map[r.clienteId]) map[r.clienteId] = []
    map[r.clienteId].push({ nivel: r.nivel, createdAt: new Date(r.createdAt) })
  }
  return map
}

/** Texto natural del tiempo sin pedir para el cuerpo del mensaje. */
function tiempoSinPedirTexto(dias: number | null): string {
  if (dias == null) return 'un tiempo'
  if (dias <= 1) return 'unos días'
  if (dias < 14) return `${dias} días`
  if (dias < 60) return `${Math.round(dias / 7)} semanas`
  return `${Math.round(dias / 30)} meses`
}

/**
 * Carrito precargado (tarea 4.3 · Capa 3, fricción cero). Codifica los items
 * (productoId + cantidad) en un sufijo compacto y URL-safe que viaja dentro del
 * token cifrado del link de micro-campaña; la tienda lo lee al resolver el token
 * y arma el carrito solo. Formato: `12x2-15x1` (idProductoXcantidad, pares con `-`).
 * Del antojo al pedido pagado sin volver a elegir nada.
 */
export function encodeCarritoRep(items: { productoId: number; cantidad: number }[]): string {
  return items
    .filter((i) => i.productoId > 0 && i.cantidad > 0)
    .map((i) => `${i.productoId}x${i.cantidad}`)
    .join('-')
}

/** Frase del incentivo según el escalón (la escalera hecha copy). */
function incentivoTexto(escalon: EscalonRecupero, codigo: string | null): string {
  if (escalon.nivel === 1) {
    return 'Sin vueltas: te dejamos todo listo para que repitas tu pedido de siempre. 😋'
  }
  if (escalon.nivel === 2) {
    return `Y esta vez va con un ${escalon.descuento}% de descuento: usá el código ${codigo} al hacer tu pedido.`
  }
  return `Te guardamos un ${escalon.descuento}% OFF con el código ${codigo}, pero ojo: vence en 48 horas ⏰.`
}

/**
 * Crea (o reemite) el cupón de descuento asociado a un toque de recupero. Código determinístico
 * por (cliente, nivel) para no acumular basura al reintentar. Un solo uso; el nivel 3 vence en 48 hs.
 */
async function upsertCuponRecupero(
  db: Db,
  restauranteId: number,
  clienteId: number,
  escalon: EscalonRecupero,
): Promise<string> {
  const codigo = `VOLVE${escalon.descuento}-${clienteId}`
  const fechaFin = escalon.expiraHoras != null
    ? new Date(Date.now() + escalon.expiraHoras * MS_POR_HORA)
    : null

  const [existente] = await db
    .select({ id: CodigoDescuentoTable.id })
    .from(CodigoDescuentoTable)
    .where(
      and(
        eq(CodigoDescuentoTable.restauranteId, restauranteId),
        eq(CodigoDescuentoTable.codigo, codigo),
      ),
    )
    .limit(1)

  if (existente) {
    await db
      .update(CodigoDescuentoTable)
      .set({
        tipo: 'porcentaje',
        valor: String(escalon.descuento),
        limiteUsos: 1,
        usosActuales: 0,
        fechaInicio: new Date(),
        fechaFin,
        activo: true,
        generadoAutomaticamente: true,
      })
      .where(eq(CodigoDescuentoTable.id, existente.id))
  } else {
    await db.insert(CodigoDescuentoTable).values({
      restauranteId,
      codigo,
      tipo: 'porcentaje',
      valor: String(escalon.descuento),
      limiteUsos: 1,
      usosActuales: 0,
      montoMinimo: '0.00',
      fechaInicio: new Date(),
      fechaFin,
      activo: true,
      generadoAutomaticamente: true,
    })
  }

  return codigo
}

export interface ResultadoEnvioRecupero {
  ok: boolean
  /** Código de error legible para la UI cuando ok=false. */
  motivo?: 'sin_whatsapp' | 'sin_telefono' | 'sin_saldo' | 'cooldown' | 'cliente_no_encontrado' | 'envio_fallido' | MotivoBloqueoMarketing
  mensaje?: string
  nivel?: number
  codigoDescuento?: string | null
  saldoMarketing?: number
  plantillaWhatsapp?: string
  errorEnvio?: string | null
  estado?: EstadoRecupero
}

export interface OpcionesEnvioRecupero {
  /** Clave estable del intento lógico. Impide dobles débitos y dobles envíos al reintentar. */
  operacionId?: string
}

export const PLANTILLA_RECUPERO_WHATSAPP = 'recupero_dormido_v1'

export interface DatosMensajeRecupero {
  clienteId: number
  clienteNombre: string
  telefono: string | null
  telefonoNormalizado: string | null
  restauranteNombre: string
  tiempoSinPedir: string
  productoFavorito: string
  incentivo: string
  descuento: number
  codigoDescuento: string | null
  nivel: number
  /** Link de micro-campaña (`/c/:slug?tk=v1...`) que abre la tienda del local. */
  urlTienda: string
  texto: string
  waMeUrl: string | null
  imagenProducto: string | null
  /** El mismo link, sin la base: es el path dinámico del botón de la plantilla. */
  usernameSuffix: string
  escalon: EscalonRecupero
  estado: EstadoRecupero
  horarioSugerido?: string | null
}

/**
 * Prepara los datos del mensaje de recupero (copy, cupón, producto favorito, deep link y wa.me).
 * No realiza envíos ni consume saldo. Se usa tanto en modo manual como antes de enviar automático.
 */
export async function prepararMensajeRecupero(
  db: Db,
  restauranteId: number,
  clienteId: number,
): Promise<{ ok: true; data: DatosMensajeRecupero } | { ok: false; motivo: string; mensaje: string; estado?: EstadoRecupero }> {
  // 1. Cliente + local
  const [cli] = await db
    .select()
    .from(ClienteTable)
    .where(and(eq(ClienteTable.id, clienteId), eq(ClienteTable.restauranteId, restauranteId)))
    .limit(1)
  if (!cli) return { ok: false, motivo: 'cliente_no_encontrado', mensaje: 'Cliente no encontrado' }
  if (!cli.telefono) return { ok: false, motivo: 'sin_telefono', mensaje: 'El cliente no tiene teléfono cargado' }

  const [rest] = await db
    .select({
      nombre: RestauranteTable.nombre,
      username: RestauranteTable.username,
      imagenUrl: RestauranteTable.imagenUrl,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  if (!rest) {
    return { ok: false, motivo: 'cliente_no_encontrado', mensaje: 'Local no encontrado' }
  }

  // 2. Pedidos del cliente (no cancelados) → último pedido + producto favorito.
  const pedidos = await db
    .select({ id: PedidoUnificadoTable.id, createdAt: PedidoUnificadoTable.createdAt })
    .from(PedidoUnificadoTable)
    .where(
      and(
        eq(PedidoUnificadoTable.restauranteId, restauranteId),
        eq(PedidoUnificadoTable.clienteId, clienteId),
      ),
    )
  const pedidosValidos = pedidos
  const fechasMs = pedidosValidos.map((p) => new Date(p.createdAt).getTime())
  const ultimoPedidoMs = fechasMs.length > 0 ? Math.max(...fechasMs) : null
  const diasDesdeUltimo = ultimoPedidoMs != null
    ? Math.max(0, Math.floor((Date.now() - ultimoPedidoMs) / MS_POR_DIA))
    : null

  // Producto favorito (más pedido por cantidad) + su foto para el header.
  let productoFavorito = 'tu pedido de siempre'
  let imagenProducto: string | null = null
  let topProductoId: number | null = null
  const pedidoIds = pedidosValidos.map((p) => p.id)
  if (pedidoIds.length > 0) {
    const items = await db
      .select({ productoId: ItemPedidoUnificadoTable.productoId, cantidad: ItemPedidoUnificadoTable.cantidad })
      .from(ItemPedidoUnificadoTable)
      .where(inArray(ItemPedidoUnificadoTable.pedidoId, pedidoIds))
    const conteo: Record<number, number> = {}
    for (const it of items) conteo[it.productoId] = (conteo[it.productoId] || 0) + (it.cantidad ?? 1)
    const topId = Object.entries(conteo).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (topId) {
      topProductoId = Number(topId)
      const [prod] = await db
        .select({ nombre: ProductoTable.nombre, imagenUrl: ProductoTable.imagenUrl })
        .from(ProductoTable)
        .where(eq(ProductoTable.id, topProductoId))
        .limit(1)
      if (prod?.nombre) productoFavorito = prod.nombre
      if (prod?.imagenUrl) imagenProducto = prod.imagenUrl
    }
  }

  // Deep link con carrito precargado (4.3): reconstruimos el ÚLTIMO pedido del cliente
  let repParam = ''
  if (ultimoPedidoMs != null && pedidoIds.length > 0) {
    const ultimoPedidoId = pedidosValidos
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.id
    if (ultimoPedidoId) {
      const itemsUltimo = await db
        .select({ productoId: ItemPedidoUnificadoTable.productoId, cantidad: ItemPedidoUnificadoTable.cantidad })
        .from(ItemPedidoUnificadoTable)
        .where(eq(ItemPedidoUnificadoTable.pedidoId, ultimoPedidoId))
      const agrup: Record<number, number> = {}
      for (const it of itemsUltimo) agrup[it.productoId] = (agrup[it.productoId] || 0) + (it.cantidad ?? 1)
      repParam = encodeCarritoRep(
        Object.entries(agrup).map(([pid, qty]) => ({ productoId: Number(pid), cantidad: qty })),
      )
    }
  }
  if (!repParam && topProductoId) repParam = `${topProductoId}x1`

  // 3. Estado de la escalera → escalón a enviar.
  const toquesMap = await cargarToquesPorCliente(db, restauranteId, [clienteId])
  const estado = estadoRecupero(toquesMap[clienteId] ?? [], ultimoPedidoMs)
  const escalon = ESCALERA[estado.proximoNivel - 1]

  // 4. Cupón si corresponde (upsert determinístico)
  let codigo: string | null = null
  if (escalon.descuento > 0) {
    codigo = await upsertCuponRecupero(db, restauranteId, clienteId, escalon)
  }

  // 5. Link de micro-campaña con el carrito del último pedido adentro del token
  // cifrado (antes: `username?rep=12x2-15x1` a la vista). La tienda resuelve el
  // slug y reconstruye cliente + carrito, así que el mensaje ya no expone ids.
  // El escalón sin descuento usa `lo-mismo` (drawer 1-toque, sin % extra) y los
  // escalones con cupón usan `reactivacion`; el descuento sigue viajando en el
  // cupón, por eso `dto` queda en 0 y el beneficio no se duplica.
  const esReactivacion = escalon.descuento > 0
  const tokenMicroCampana = cifrarGrowthPayload({
    rId: restauranteId,
    cId: clienteId,
    campana: esReactivacion ? 'reactivacion' : 'lo_mismo',
    modalidad: esReactivacion ? 'descuento_banner' : 'drawer_habitual',
    rep: repParam || undefined,
    dto: 0,
    // El link vive lo mismo que el cupón del escalón (nivel 3: 48 hs).
    exp: escalon.expiraHoras != null ? Date.now() + escalon.expiraHoras * MS_POR_HORA : null,
  })
  const urlTienda = rest.username
    ? urlMicroCampana(rest.username, esReactivacion ? 'reactivacion' : 'lo-mismo', tokenMicroCampana)
    : 'https://my.piru.app'
  // La plantilla de WhatsApp ya trae la base `BASE_TIENDA`: sólo se envía el
  // path dinámico del botón.
  const usernameSuffix = rest.username ? urlTienda.slice(BASE_TIENDA.length) : ''

  const tiempoSinPedir = tiempoSinPedirTexto(diasDesdeUltimo)
  const incentivo = incentivoTexto(escalon, codigo)
  const nombreCliente = cli.nombre?.trim() || 'Cliente'
  const nombreLocal = rest.nombre?.trim() || 'El local'

  const texto = `¡Hola ${nombreCliente}! 👋\n\nEn ${nombreLocal} hace ${tiempoSinPedir} que no te vemos y se nos antojó tentarte con ${productoFavorito}. 😋\n\n${incentivo}\n\nPedí en segundos desde acá 👇\n${urlTienda}`

  const norm = normalizarTelefonoCliente(cli.telefono)
  const telWa = norm ? (norm.startsWith('54') ? norm : norm.length === 10 ? `549${norm}` : norm) : null
  const waMeUrl = telWa ? `https://wa.me/${telWa}?text=${encodeURIComponent(texto)}` : null

  return {
    ok: true,
    data: {
      clienteId,
      clienteNombre: nombreCliente,
      telefono: cli.telefono,
      telefonoNormalizado: telWa,
      restauranteNombre: nombreLocal,
      tiempoSinPedir,
      productoFavorito,
      incentivo,
      descuento: escalon.descuento,
      codigoDescuento: codigo,
      nivel: escalon.nivel,
      urlTienda,
      texto,
      waMeUrl,
      imagenProducto: imagenProducto || rest.imagenUrl || null,
      usernameSuffix,
      escalon,
      estado,
    },
  }
}

/**
 * Orquesta el envío de un toque de recupero al cliente por Meta API: resuelve el escalón,
 * arma el antojo, genera el cupón si corresponde, manda el WhatsApp de marketing con la
 * marca del local, registra el toque y descuenta el bucket marketing (best-effort).
 */
export async function enviarRecuperoDormido(
  c: any,
  db: Db,
  restauranteId: number,
  clienteId: number,
  opciones: OpcionesEnvioRecupero = {},
): Promise<ResultadoEnvioRecupero> {
  const prep = await prepararMensajeRecupero(db, restauranteId, clienteId)
  if (!prep.ok) {
    return { ok: false, motivo: prep.motivo as any, mensaje: prep.mensaje, estado: prep.estado }
  }
  const { data } = prep

  // 1. Local y credenciales de Meta
  const [rest] = await db
    .select({
      whatsappPhoneId: RestauranteTable.whatsappPhoneId,
      whatsappAccessToken: RestauranteTable.whatsappAccessToken,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)
  const credsLocal = rest ? resolverCredsRestaurante(rest) : undefined

  // 2. Protección de la base (opt-out + cooldown + tope)
  const [cli] = await db
    .select({ marketingOptOut: ClienteTable.marketingOptOut })
    .from(ClienteTable)
    .where(and(eq(ClienteTable.id, clienteId), eq(ClienteTable.restauranteId, restauranteId)))
    .limit(1)

  const toquesMap = await cargarToquesPorCliente(db, restauranteId, [clienteId])
  const proteccion = chequearProteccionMarketing({
    optOut: !!cli?.marketingOptOut,
    toques: toquesMap[clienteId] ?? [],
  })
  if (!proteccion.permitido) {
    return { ok: false, motivo: proteccion.motivo, mensaje: proteccion.mensaje, estado: data.estado }
  }

  if (!data.estado.puedeEnviar) {
    return {
      ok: false,
      motivo: 'cooldown',
      mensaje: `Ya le enviaste un mensaje hace poco. Esperá ${COOLDOWN_HORAS} hs antes de insistir.`,
      estado: data.estado,
    }
  }

  // 3. Reservar antes de enviar
  const operacionId = opciones.operacionId ?? `recupero:${restauranteId}:${clienteId}:${crypto.randomUUID()}`
  const reserva = await reservarCreditoMarketing(
    db,
    restauranteId,
    operacionId,
    `reserva_recupero_nivel_${data.escalon.nivel}`,
  )
  if (reserva.estado === 'sin_saldo') {
    return {
      ok: false,
      motivo: 'sin_saldo',
      mensaje: 'No hay saldo de mensajes de marketing disponible',
      saldoMarketing: reserva.saldoMarketingDisponible,
      plantillaWhatsapp: PLANTILLA_RECUPERO_WHATSAPP,
      estado: data.estado,
    }
  }
  if (reserva.estado === 'confirmada') {
    const [toqueConfirmado] = await db.select({
      nivel: RecuperoClienteTable.nivel,
      codigoDescuento: RecuperoClienteTable.codigoDescuento,
    }).from(RecuperoClienteTable).where(and(
      eq(RecuperoClienteTable.restauranteId, restauranteId),
      eq(RecuperoClienteTable.clienteId, clienteId),
    )).orderBy(desc(RecuperoClienteTable.createdAt)).limit(1)
    return {
      ok: true,
      nivel: toqueConfirmado?.nivel ?? data.estado.ultimoNivel ?? data.escalon.nivel,
      codigoDescuento: toqueConfirmado?.codigoDescuento ?? null,
      saldoMarketing: reserva.saldoMarketingDisponible,
      plantillaWhatsapp: PLANTILLA_RECUPERO_WHATSAPP,
      estado: data.estado,
    }
  }
  if (reserva.estado === 'compensada') {
    return {
      ok: false,
      motivo: 'envio_fallido',
      mensaje: 'Este intento ya había fallado y su crédito fue devuelto',
      saldoMarketing: reserva.saldoMarketingDisponible,
      plantillaWhatsapp: PLANTILLA_RECUPERO_WHATSAPP,
      estado: data.estado,
    }
  }

  // 4. Envío de WhatsApp Meta
  const send = await sendClientRecuperoWhatsApp(
    c,
    {
      phone: data.telefono!,
      customerName: data.clienteNombre,
      restaurantName: data.restauranteNombre,
      tiempoSinPedir: data.tiempoSinPedir,
      productoFavorito: data.productoFavorito,
      incentivo: data.incentivo,
      usernameTienda: data.usernameSuffix,
      imageUrl: data.imagenProducto,
    },
    credsLocal,
  )

  if (!send.success) {
    const compensacion = await compensarReservaCreditoMarketing(db, restauranteId, operacionId)
    return {
      ok: false,
      motivo: 'envio_fallido',
      mensaje: 'No se pudo enviar el mensaje por WhatsApp',
      saldoMarketing: compensacion.saldoMarketingDisponible,
      plantillaWhatsapp: PLANTILLA_RECUPERO_WHATSAPP,
      errorEnvio: typeof send.error === 'string' ? send.error : JSON.stringify(send.error ?? null).slice(0, 500),
      estado: data.estado,
    }
  }

  const confirmacion = await confirmarReservaCreditoMarketing(db, restauranteId, operacionId)

  // 5. Registrar toque en historial
  await db.insert(RecuperoClienteTable).values({
    restauranteId,
    clienteId,
    telefono: data.telefono,
    nivel: data.escalon.nivel,
    descuentoPorcentaje: data.escalon.descuento,
    codigoDescuento: data.codigoDescuento,
    segmento: null,
  })

  const nuevoEstado = estadoRecupero(
    [...(toquesMap[clienteId] ?? []), { nivel: data.escalon.nivel, createdAt: new Date() }],
    null,
  )

  return {
    ok: true,
    nivel: data.escalon.nivel,
    codigoDescuento: data.codigoDescuento,
    saldoMarketing: confirmacion.saldoMarketingDisponible,
    plantillaWhatsapp: PLANTILLA_RECUPERO_WHATSAPP,
    estado: nuevoEstado,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CAMPAÑA DE RECOMPRA + GRUPO DE CONTROL (tarea 4.4)
//
// El "encendido del motor": en vez de ir cliente por cliente apretando un botón, el local dispara
// UNA campaña. El sistema detecta la cohorte recuperable, aparta al azar un 10% de cada segmento
// como GRUPO DE CONTROL (no se contacta) y le manda el toque de recupero al resto, todo en batch.
// El control se guarda para poder medir la atribución honesta después (contactados vs control).
// ═════════════════════════════════════════════════════════════════════════════

export type SegmentoRecompra = 'primer_pedido' | 'en_riesgo' | 'dormido' | 'perdido'

/** Segmentos donde tiene sentido el recupero (el cliente se enfrió respecto de SU propio ritmo). */
export const SEGMENTOS_RECUPERABLES: SegmentoRecompra[] = ['primer_pedido', 'en_riesgo', 'dormido', 'perdido']

/** Fracción de cada segmento que se aparta al azar como grupo de control (no negociable, día 1). */
export const PORCENTAJE_CONTROL = 0.1

export interface ClienteCohorte {
  clienteId: number
  nombre: string
  telefono: string
  segmento: SegmentoRecompra
  diasDesdeUltimo: number | null
  totalGastado: number
  ultimoPedidoMs: number | null
  cantidadPedidos: number
  proximoNivel: number
  fechasPedidosMs: number[]
}

/**
 * Detecta la cohorte recuperable de un local: clientes en un segmento recuperable
 * (primer_pedido/en_riesgo/dormido/perdido), con teléfono cargado y fuera del cooldown de recupero.
 * Reusa el mismo cerebro RFM que la "Base de clientes" (misma verdad, calculada on-the-fly).
 */
export async function cargarCohorteRecompra(
  db: Db,
  restauranteId: number,
): Promise<ClienteCohorte[]> {
  const clientes = await db
    .select({
      id: ClienteTable.id,
      nombre: ClienteTable.nombre,
      telefono: ClienteTable.telefono,
      marketingOptOut: ClienteTable.marketingOptOut,
    })
    .from(ClienteTable)
    .where(eq(ClienteTable.restauranteId, restauranteId))
  if (clientes.length === 0) return []

  const pedidos = await db
    .select({
      clienteId: PedidoUnificadoTable.clienteId,
      total: PedidoUnificadoTable.total,
      createdAt: PedidoUnificadoTable.createdAt,
    })
    .from(PedidoUnificadoTable)
    .where(
      and(
        eq(PedidoUnificadoTable.restauranteId, restauranteId),
        notInArray(PedidoUnificadoTable.estado, ['cancelled']),
      ),
    )

  const porCliente: Record<number, { fechasMs: number[]; total: number }> = {}
  for (const cl of clientes) porCliente[cl.id] = { fechasMs: [], total: 0 }
  for (const p of pedidos) {
    const g = porCliente[p.clienteId as number]
    if (!g) continue
    g.fechasMs.push(new Date(p.createdAt).getTime())
    g.total += parseFloat(p.total || '0')
  }

  const perfiles = computarPerfilesRFM(
    clientes.map((cl) => ({
      cantidadPedidos: porCliente[cl.id].fechasMs.length,
      totalGastado: porCliente[cl.id].total,
      fechasPedidos: porCliente[cl.id].fechasMs,
    })),
  )

  const toques = await cargarToquesPorCliente(db, restauranteId, clientes.map((cl) => cl.id))

  const cohorte: ClienteCohorte[] = []
  clientes.forEach((cl, i) => {
    const perfil = perfiles[i]
    const g = porCliente[cl.id]
    const ultimoPedidoMs = g.fechasMs.length > 0 ? Math.max(...g.fechasMs) : null

    // Clasificación para recompra: clientes de 1 solo pedido se incorporan como 'primer_pedido'
    let segmentoRecompra: SegmentoRecompra | null = null
    if (g.fechasMs.length === 1 || perfil.segmento === 'nuevo') {
      if (g.fechasMs.length === 1) {
        segmentoRecompra = 'primer_pedido'
      } else {
        return // todavía sin compras realizadas
      }
    } else if (perfil.segmento === 'en_riesgo' || perfil.segmento === 'dormido' || perfil.segmento === 'perdido') {
      segmentoRecompra = perfil.segmento
    }

    if (!segmentoRecompra || !SEGMENTOS_RECUPERABLES.includes(segmentoRecompra)) return
    if (!cl.telefono) return
    // Protección de la base (4.5): fuera de la cohorte los que pidieron la baja (opt-out) y los que
    // ya tocaron el tope de marketing del mes. Así el batch no los alcanza ni figuran en la preview.
    if (cl.marketingOptOut) return
    if (contarToquesEnVentana(toques[cl.id] ?? []) >= TOPE_MARKETING_POR_CLIENTE) return
    const estado = estadoRecupero(toques[cl.id] ?? [], ultimoPedidoMs)
    if (!estado.puedeEnviar) return
    cohorte.push({
      clienteId: cl.id,
      nombre: cl.nombre || 'Cliente',
      telefono: cl.telefono,
      segmento: segmentoRecompra,
      diasDesdeUltimo: perfil.diasDesdeUltimo,
      totalGastado: g.total,
      ultimoPedidoMs,
      cantidadPedidos: g.fechasMs.length,
      proximoNivel: estado.proximoNivel,
      fechasPedidosMs: g.fechasMs,
    })
  })
  return cohorte
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Aparta al azar un 10% de CADA segmento como grupo de control. Se hace por segmento (no sobre el
 * total) para que la medición sea comparable dentro de cada estado de ciclo de vida. Con muy pocos
 * clientes en un segmento el control redondea a 0 (no se puede medir honestamente con 2 casos).
 */
export function separarControl(cohorte: ClienteCohorte[]): {
  contactar: ClienteCohorte[]
  control: ClienteCohorte[]
} {
  const contactar: ClienteCohorte[] = []
  const control: ClienteCohorte[] = []
  const porSeg: Record<string, ClienteCohorte[]> = {}
  for (const cl of cohorte) (porSeg[cl.segmento] ??= []).push(cl)
  for (const seg of Object.keys(porSeg)) {
    const arr = shuffle(porSeg[seg])
    const nControl = Math.round(arr.length * PORCENTAJE_CONTROL)
    control.push(...arr.slice(0, nControl))
    contactar.push(...arr.slice(nControl))
  }
  return { contactar, control }
}

/** Resumen por segmento para la preview de la campaña (qué se detectó / qué se contactaría). */
export interface ResumenSegmentoCohorte {
  segmento: SegmentoCliente
  detectados: number
  aContactar: number
  control: number
  facturacionEnJuego: number
}

export interface PreviewCampana {
  totalDetectados: number
  totalAContactar: number
  totalControl: number
  facturacionEnJuego: number
  /** Protección de la base (4.5): true si ahora mismo es horario de silencio (no se puede enviar). */
  horarioSilencio: boolean
  porSegmento: ResumenSegmentoCohorte[]
  clientes: {
    clienteId: number
    nombre: string
    segmento: SegmentoCliente
    diasDesdeUltimo: number | null
    totalGastado: number
    proximoNivel: number
  }[]
}

/** Arma la preview (sin enviar nada): la cohorte detectada + el 10% que quedaría en control. */
export async function previewCampanaRecompra(
  db: Db,
  restauranteId: number,
): Promise<PreviewCampana> {
  const cohorte = await cargarCohorteRecompra(db, restauranteId)
  const nControlEstimado: Record<string, number> = {}
  const porSegMap: Record<string, ClienteCohorte[]> = {}
  for (const cl of cohorte) (porSegMap[cl.segmento] ??= []).push(cl)
  for (const seg of Object.keys(porSegMap)) {
    nControlEstimado[seg] = Math.round(porSegMap[seg].length * PORCENTAJE_CONTROL)
  }

  const porSegmento: ResumenSegmentoCohorte[] = SEGMENTOS_RECUPERABLES
    .filter((seg) => (porSegMap[seg]?.length ?? 0) > 0)
    .map((seg) => {
      const arr = porSegMap[seg] ?? []
      const control = nControlEstimado[seg] ?? 0
      return {
        segmento: seg,
        detectados: arr.length,
        aContactar: arr.length - control,
        control,
        facturacionEnJuego: arr.reduce((acc, c) => acc + c.totalGastado, 0),
      }
    })

  const totalControl = Object.values(nControlEstimado).reduce((a, b) => a + b, 0)
  return {
    totalDetectados: cohorte.length,
    totalAContactar: cohorte.length - totalControl,
    totalControl,
    facturacionEnJuego: cohorte.reduce((acc, c) => acc + c.totalGastado, 0),
    horarioSilencio: enHorarioSilencio(),
    porSegmento,
    clientes: cohorte.map((c) => ({
      clienteId: c.clienteId,
      nombre: c.nombre,
      segmento: c.segmento,
      diasDesdeUltimo: c.diasDesdeUltimo,
      totalGastado: c.totalGastado,
      proximoNivel: c.proximoNivel,
    })),
  }
}

export interface ResultadoCampana {
  ok: boolean
  vacio?: boolean
  /** Protección de la base (4.5): true si se rechazó por estar en horario de silencio. */
  bloqueadoPorHorario?: boolean
  campanaId?: number
  totalDetectados: number
  totalControl: number
  enviados: number
  fallidos: number
}

/**
 * Ejecuta la campaña batch: detecta la cohorte, aparta el 10% de control (guardándolo), y le manda
 * el toque de recupero al resto reusando `enviarRecuperoDormido` (misma escalera, cupón, deep link,
 * ledger y consumo del wallet que el envío individual). Persiste toda la cohorte en
 * `campana_recompra_cliente` (rol contactado/control + snapshots) para la atribución posterior.
 *
 * El gating del módulo Motor de Recompra lo aplica la ruta que inicia esta operación.
 */
export async function ejecutarCampanaRecompra(
  c: any,
  db: Db,
  restauranteId: number,
): Promise<ResultadoCampana> {
  // Protección de la base (4.5): un batch de madrugada puede tocar a muchos de una → si estamos en
  // horario de silencio, no se manda nada (el opt-out y el tope por cliente ya filtran la cohorte).
  if (enHorarioSilencio()) {
    return {
      ok: false,
      bloqueadoPorHorario: true,
      totalDetectados: 0,
      totalControl: 0,
      enviados: 0,
      fallidos: 0,
    }
  }

  const cohorte = await cargarCohorteRecompra(db, restauranteId)
  if (cohorte.length === 0) {
    return { ok: true, vacio: true, totalDetectados: 0, totalControl: 0, enviados: 0, fallidos: 0 }
  }

  const { contactar, control } = separarControl(cohorte)

  const [ins] = await db.insert(CampanaRecompraTable).values({
    restauranteId,
    totalDetectados: cohorte.length,
    totalContactados: 0,
    totalControl: control.length,
    totalFallidos: 0,
  })
  const campanaId = Number((ins as any).insertId)

  const snapshot = (cl: ClienteCohorte) => ({
    totalGastadoSnapshot: cl.totalGastado.toFixed(2),
    ultimoPedidoAtSnapshot: cl.ultimoPedidoMs != null ? new Date(cl.ultimoPedidoMs) : null,
  })

  // Grupo de control: se registra pero NO se contacta (es el punto de la atribución honesta).
  for (const cl of control) {
    await db.insert(CampanaRecompraClienteTable).values({
      campanaId,
      restauranteId,
      clienteId: cl.clienteId,
      rol: 'control',
      segmento: cl.segmento,
      nivel: null,
      codigoDescuento: null,
      envioOk: false,
      ...snapshot(cl),
    })
  }

  // Grupo contactado: envío batch (reusa el mismo camino que el envío individual).
  let enviados = 0
  let fallidos = 0
  for (const cl of contactar) {
    let res: ResultadoEnvioRecupero
    try {
      res = await enviarRecuperoDormido(c, db, restauranteId, cl.clienteId)
    } catch (err) {
      console.error(`❌ [Campaña ${campanaId}] Error enviando a cliente ${cl.clienteId}:`, err)
      res = { ok: false, motivo: 'envio_fallido' }
    }
    if (res.ok) enviados++
    else fallidos++
    await db.insert(CampanaRecompraClienteTable).values({
      campanaId,
      restauranteId,
      clienteId: cl.clienteId,
      rol: 'contactado',
      segmento: cl.segmento,
      nivel: res.nivel ?? cl.proximoNivel,
      codigoDescuento: res.codigoDescuento ?? null,
      envioOk: !!res.ok,
      ...snapshot(cl),
    })
  }

  await db
    .update(CampanaRecompraTable)
    .set({ totalContactados: enviados, totalFallidos: fallidos })
    .where(eq(CampanaRecompraTable.id, campanaId))

  return {
    ok: true,
    campanaId,
    totalDetectados: cohorte.length,
    totalControl: control.length,
    enviados,
    fallidos,
  }
}

/** Historial de campañas del local (para mostrar el resultado del último encendido). */
export async function listarCampanasRecompra(db: Db, restauranteId: number, limite = 10) {
  return db
    .select()
    .from(CampanaRecompraTable)
    .where(eq(CampanaRecompraTable.restauranteId, restauranteId))
    .orderBy(desc(CampanaRecompraTable.createdAt))
    .limit(limite)
}
