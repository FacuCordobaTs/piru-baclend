// src/lib/recupero.ts
//
// Motor de Recompra · Capa 2 (piloto automático) — playbook de recupero de dormidos (tarea 4.2).
//
// A diferencia del enunciado original del ROADMAP (piloto automático), acá el playbook es una
// ACCIÓN VOLUNTARIA del local: aprieta un botón en la "Base de clientes" y se manda el toque de
// recupero al cliente elegido. La inteligencia (a quién le conviene, en qué escalón está) la pone
// el sistema; el gatillo lo pone el local.
//
// La ESCALERA DE INCENTIVOS es la clave: no se regala descuento de entrada.
//   nivel 1 → sin descuento (solo antojo: foto de lo que más pide + "repetí tu pedido")
//   nivel 2 → descuento chico (10%)
//   nivel 3 → oferta fuerte (20%) con vencimiento (48 hs)
// El próximo nivel se deriva de cuántos toques se enviaron DESPUÉS del último pedido del cliente:
// si volvió a pedir, la escalera se reinicia sola (se detiene apenas el cliente vuelve).
//
// Consume el bucket `marketing` del wallet de mensajes (best-effort: la contabilidad nunca impide
// que salga el mensaje). El envío usa las credenciales de Meta del propio local (marca del local).

import { type MySql2Database } from 'drizzle-orm/mysql2'
import { and, eq, inArray, desc } from 'drizzle-orm'
import {
  cliente as ClienteTable,
  restaurante as RestauranteTable,
  pedidoUnificado as PedidoUnificadoTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  producto as ProductoTable,
  codigoDescuento as CodigoDescuentoTable,
  recuperoCliente as RecuperoClienteTable,
} from '../db/schema'
import { consumirMensaje } from './mensajes-wallet'
import { sendClientRecuperoWhatsApp } from '../services/whatsapp'

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
 * Deep link con carrito precargado (tarea 4.3 · Capa 3, fricción cero). Codifica los items
 * (productoId + cantidad) en un sufijo compacto y URL-safe `rep` que la tienda (`web/MenuDelivery`)
 * lee para armar el carrito solo. Formato: `12x2-15x1` (idProductoXcantidad, pares con `-`).
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
    })
  }

  return codigo
}

export interface ResultadoEnvioRecupero {
  ok: boolean
  /** Código de error legible para la UI cuando ok=false. */
  motivo?: 'sin_whatsapp' | 'sin_telefono' | 'cooldown' | 'cliente_no_encontrado' | 'envio_fallido'
  mensaje?: string
  nivel?: number
  codigoDescuento?: string | null
  saldoMarketing?: number
  estado?: EstadoRecupero
}

/**
 * Orquesta el envío de un toque de recupero al cliente: resuelve el escalón, arma el antojo
 * (producto top + foto), genera el cupón si corresponde, manda el WhatsApp de marketing con la
 * marca del local, registra el toque y descuenta el bucket marketing (best-effort).
 *
 * El gating por plan (motor_recompra = Avanzado) lo aplica el middleware de la ruta, no esta función.
 */
export async function enviarRecuperoDormido(
  c: any,
  db: Db,
  restauranteId: number,
  clienteId: number,
): Promise<ResultadoEnvioRecupero> {
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
      whatsappPhoneId: RestauranteTable.whatsappPhoneId,
      whatsappAccessToken: RestauranteTable.whatsappAccessToken,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  if (!rest) {
    return { ok: false, motivo: 'cliente_no_encontrado', mensaje: 'Local no encontrado' }
  }

  // Marca del local vs número de Piru: lo ideal es enviar con las credenciales de Meta del propio
  // local (OAuth) para que el mensaje salga con su marca. Mientras el OAuth de Meta NO esté
  // disponible (se implementa más adelante), permitimos enviar igual usando el número del bot de
  // Piru (fallback en `sendClientRecuperoWhatsApp`: si `creds` es undefined usa WHATSAPP_PHONE_ID/
  // WHATSAPP_API_TOKEN). Cuando el local ya tenga OAuth, se usan sus credenciales.
  const credsLocal = rest.whatsappPhoneId && rest.whatsappAccessToken
    ? { phoneId: rest.whatsappPhoneId, token: rest.whatsappAccessToken }
    : undefined

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
  const pedidosValidos = pedidos // (los cancelados igual no molestan para recencia; contamos por fecha)
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

  // Deep link con carrito precargado (4.3): reconstruimos el ÚLTIMO pedido del cliente para que el
  // botón del mensaje abra la tienda con ese carrito ya armado ("repetí tu pedido"). Fallback: el
  // producto favorito solo. El sufijo se cuelga del username en el botón URL de la plantilla.
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

  // Sufijo dinámico del botón URL: username (+ carrito precargado si lo pudimos reconstruir).
  const usernameSuffix = rest.username
    ? (repParam ? `${rest.username}?rep=${repParam}` : rest.username)
    : ''

  // 3. Estado de la escalera → escalón a enviar.
  const toquesMap = await cargarToquesPorCliente(db, restauranteId, [clienteId])
  const estado = estadoRecupero(toquesMap[clienteId] ?? [], ultimoPedidoMs)
  if (!estado.puedeEnviar) {
    return {
      ok: false,
      motivo: 'cooldown',
      mensaje: `Ya le enviaste un mensaje hace poco. Esperá ${COOLDOWN_HORAS} hs antes de insistir.`,
      estado,
    }
  }
  const escalon = ESCALERA[estado.proximoNivel - 1]

  // 4. Cupón (nivel 2/3).
  const codigo = escalon.descuento > 0
    ? await upsertCuponRecupero(db, restauranteId, clienteId, escalon)
    : null

  // 5. Envío del WhatsApp de marketing con la marca del local.
  const send = await sendClientRecuperoWhatsApp(
    c,
    {
      phone: cli.telefono,
      customerName: cli.nombre || 'Cliente',
      restaurantName: rest.nombre || 'El local',
      tiempoSinPedir: tiempoSinPedirTexto(diasDesdeUltimo),
      productoFavorito,
      incentivo: incentivoTexto(escalon, codigo),
      usernameTienda: usernameSuffix,
      imageUrl: imagenProducto || rest.imagenUrl || null,
    },
    credsLocal, // undefined ⇒ fallback al número del bot de Piru (mientras no haya OAuth de Meta)
  )

  if (!send.success) {
    return { ok: false, motivo: 'envio_fallido', mensaje: 'No se pudo enviar el mensaje por WhatsApp', estado }
  }

  // 6. Registrar el toque.
  await db.insert(RecuperoClienteTable).values({
    restauranteId,
    clienteId,
    telefono: cli.telefono,
    nivel: escalon.nivel,
    descuentoPorcentaje: escalon.descuento,
    codigoDescuento: codigo,
    segmento: null,
  })

  // 7. Descontar el bucket marketing (best-effort: nunca frena el mensaje ni el flujo).
  let saldoMarketing: number | undefined
  try {
    const consumo = await consumirMensaje(db, restauranteId, {
      categoria: 'marketing',
      tipoMensaje: 'recupero_dormido',
      motivo: `playbook_recupero_nivel_${escalon.nivel}`,
    })
    saldoMarketing = consumo.saldoMarketingDisponible
  } catch (err) {
    console.error('❌ [Recupero] Error descontando marketing wallet:', err)
  }

  // Estado actualizado (suma el toque recién enviado).
  const nuevoEstado = estadoRecupero(
    [...(toquesMap[clienteId] ?? []), { nivel: escalon.nivel, createdAt: new Date() }],
    ultimoPedidoMs,
  )

  return {
    ok: true,
    nivel: escalon.nivel,
    codigoDescuento: codigo,
    saldoMarketing,
    estado: nuevoEstado,
  }
}
