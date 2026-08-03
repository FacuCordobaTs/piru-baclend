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
import { consumirMensaje } from './mensajes-wallet'
import { computarPerfilesRFM, type SegmentoCliente } from './clientes-rfm'
import { sendClientRecuperoWhatsApp, resolverCredsRestaurante } from '../services/whatsapp'
import {
  chequearProteccionMarketing,
  enHorarioSilencio,
  contarToquesEnVentana,
  TOPE_MARKETING_POR_CLIENTE,
  type MotivoBloqueoMarketing,
} from './proteccion-base'

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
  motivo?: 'sin_whatsapp' | 'sin_telefono' | 'cooldown' | 'cliente_no_encontrado' | 'envio_fallido' | MotivoBloqueoMarketing
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
  const credsLocal = resolverCredsRestaurante(rest)

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

  // 3.a Protección de la base (4.5): opt-out respetado + tope por cliente/mes + horario de silencio.
  //     Es un cimiento no negociable: el motor no debe poder quemar la base ni la reputación del número.
  const proteccion = chequearProteccionMarketing({
    optOut: !!cli.marketingOptOut,
    toques: toquesMap[clienteId] ?? [],
  })
  if (!proteccion.permitido) {
    return { ok: false, motivo: proteccion.motivo, mensaje: proteccion.mensaje, estado }
  }

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

// ═════════════════════════════════════════════════════════════════════════════
// CAMPAÑA DE RECOMPRA + GRUPO DE CONTROL (tarea 4.4)
//
// El "encendido del motor": en vez de ir cliente por cliente apretando un botón, el local dispara
// UNA campaña. El sistema detecta la cohorte recuperable, aparta al azar un 10% de cada segmento
// como GRUPO DE CONTROL (no se contacta) y le manda el toque de recupero al resto, todo en batch.
// El control se guarda para poder medir la atribución honesta después (contactados vs control).
// ═════════════════════════════════════════════════════════════════════════════

/** Segmentos donde tiene sentido el recupero (el cliente se enfrió respecto de SU propio ritmo). */
export const SEGMENTOS_RECUPERABLES: SegmentoCliente[] = ['en_riesgo', 'dormido', 'perdido']

/** Fracción de cada segmento que se aparta al azar como grupo de control (no negociable, día 1). */
export const PORCENTAJE_CONTROL = 0.1

export interface ClienteCohorte {
  clienteId: number
  nombre: string
  telefono: string
  segmento: SegmentoCliente
  diasDesdeUltimo: number | null
  totalGastado: number
  ultimoPedidoMs: number | null
  cantidadPedidos: number
  proximoNivel: number
}

/**
 * Detecta la cohorte recuperable de un local: clientes en un segmento recuperable
 * (en_riesgo/dormido/perdido), con teléfono cargado y fuera del cooldown de recupero.
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
    if (!SEGMENTOS_RECUPERABLES.includes(perfil.segmento)) return
    if (!cl.telefono) return
    // Protección de la base (4.5): fuera de la cohorte los que pidieron la baja (opt-out) y los que
    // ya tocaron el tope de marketing del mes. Así el batch no los alcanza ni figuran en la preview.
    if (cl.marketingOptOut) return
    if (contarToquesEnVentana(toques[cl.id] ?? []) >= TOPE_MARKETING_POR_CLIENTE) return
    const g = porCliente[cl.id]
    const ultimoPedidoMs = g.fechasMs.length > 0 ? Math.max(...g.fechasMs) : null
    const estado = estadoRecupero(toques[cl.id] ?? [], ultimoPedidoMs)
    if (!estado.puedeEnviar) return
    cohorte.push({
      clienteId: cl.id,
      nombre: cl.nombre || 'Cliente',
      telefono: cl.telefono,
      segmento: perfil.segmento,
      diasDesdeUltimo: perfil.diasDesdeUltimo,
      totalGastado: g.total,
      ultimoPedidoMs,
      cantidadPedidos: g.fechasMs.length,
      proximoNivel: estado.proximoNivel,
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
 * El gating por plan (motor_recompra = Avanzado) lo aplica el middleware de la ruta.
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
