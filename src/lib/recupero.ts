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
// El COPY del toque ya no es único: lo pone el recetario (`recetas-recompra.ts`) según el segmento
// del cliente, y en modo manual el operador puede cambiar de receta (y con ella el beneficio y el
// link). La escalera sigue siendo la autoridad del beneficio: la receta sólo puede bajarlo.
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
import {
  componerCuerpoToque,
  DESCUENTO_MAX,
  DESCUENTO_MIN,
  ESCALERA,
  esModalidadLink,
  esSegmentoRecompra,
  lineaBeneficioRecompra,
  listarRecetasRecompra,
  MODALIDADES_LINK,
  NIVEL_MAX,
  normalizarToque,
  resolverBeneficioRecompra,
  resolverPlantillaRecompra,
  resolverRecetaRecompra,
  resolverRecetaToque,
  resolverSegmentoRecompraDesdeRFM,
  SEGMENTOS_RECUPERABLES,
  TOQUE_MAX,
  TOQUES_RECOMPRA,
  type BeneficioRecompra,
  type EscalonRecupero,
  type ModalidadLink,
  type RecetaRecompra,
  type SegmentoRecompra,
  type ToqueRecompra,
  type VariableToque,
} from './recetas-recompra'
import {
  COOLDOWN_HORAS,
  estadoRecupero,
  MS_POR_HORA,
  type EstadoRecupero,
  type Toque,
} from './recompra-goteo'
import { resolverEnvioRecompra, type OrigenDescuento } from './recompra-envio'

// El vocabulario del goteo vive en el recetario; se reexporta para no romper a sus consumidores
// (motor-recompra, las rutas de clientes y los tipos del admin lo importan desde acá desde antes).
export { SEGMENTOS_RECUPERABLES, esSegmentoRecompra, normalizarToque, TOQUE_MAX }
export { DESCUENTO_MIN, DESCUENTO_MAX, MODALIDADES_LINK, esModalidadLink }
export type { SegmentoRecompra, ToqueRecompra, ModalidadLink }

type Db = MySql2Database<Record<string, never>>

// ── Definición de la escalera ────────────────────────────────────────────────
// La tabla vive en el recetario (módulo puro) para que el motor y los tests puedan leerla sin abrir
// el pool; se reexporta acá porque este módulo es donde la importan sus consumidores desde antes.
export { ESCALERA, NIVEL_MAX, type EscalonRecupero }

const MS_POR_DIA = 1000 * 60 * 60 * 24
// El ritmo del goteo vive en un módulo puro para poder fijarlo con tests (ver `recompra-goteo.ts`);
// se reexporta acá porque este módulo es donde lo importan sus consumidores desde antes.
export { COOLDOWN_HORAS, MS_POR_HORA }

// El estado de la escalera para un cliente es puro y vive con el ritmo del goteo (ver
// `recompra-goteo.ts`); se reexporta acá porque este módulo es donde lo importan sus consumidores.
export { estadoRecupero, type EstadoRecupero, type Toque }

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

/**
 * Segmento de recompra de UN cliente, con el mismo cerebro RFM de la cohorte (`cargarCohorteRecompra`).
 * Es exacto para clientes con 2+ pedidos, porque la cadencia se calcula individual; con 0 o 1 pedido
 * cae en `primer_pedido`, igual que en la cohorte. Se usa cuando el cliente llega suelto (recupero
 * manual por cliente): la cola del motor ya trae el segmento que clasificó la campaña.
 */
export function segmentoRecompraDePedidos(
  pedidos: { total: string | null; createdAt: Date | string; estado?: string | null }[],
): SegmentoRecompra {
  const validos = pedidos.filter((p) => p.estado !== 'cancelled')
  const fechasPedidosMs = validos.map((p) => new Date(p.createdAt).getTime())
  const totalGastado = validos.reduce((acc, p) => acc + parseFloat(p.total || '0'), 0)
  if (fechasPedidosMs.length === 1) return 'primer_pedido'
  const [perfil] = computarPerfilesRFM([
    { cantidadPedidos: fechasPedidosMs.length, totalGastado, fechasPedidos: fechasPedidosMs },
  ])
  return resolverSegmentoRecompraDesdeRFM(perfil.segmento) ?? 'primer_pedido'
}

/** Una receta ofrecida al operador, con el beneficio que tendría si la eligiera. */
export interface OpcionRecetaRecompra {
  codigo: SegmentoRecompra
  nombre: string
  descripcion: string
  /** Hook del segmento: la primera línea del mensaje (sin la línea del cupón). */
  textoBase: string
  /** true si es la receta del segmento del cliente: la que el motor recomienda. */
  esRecomendada: boolean
  /** true si es la que efectivamente se aplicó al mensaje devuelto. */
  esSeleccionada: boolean
  /** Descuento efectivo de esta opción (0 = sin descuento). */
  descuento: number
  expiraHoras: number | null
  nivel: number
}

function opcionReceta(
  receta: RecetaRecompra,
  beneficio: BeneficioRecompra,
  flags: { esRecomendada: boolean; esSeleccionada: boolean },
): OpcionRecetaRecompra {
  return {
    codigo: receta.codigo,
    nombre: receta.nombre,
    descripcion: receta.descripcion,
    textoBase: receta.textoBase,
    esRecomendada: flags.esRecomendada,
    esSeleccionada: flags.esSeleccionada,
    descuento: beneficio.descuento,
    expiraHoras: beneficio.expiraHoras,
    nivel: beneficio.nivel,
  }
}

/**
 * Crea (o reemite) el cupón de descuento asociado a un toque de recupero. Código determinístico
 * por (cliente, descuento) para no acumular basura al reintentar. Un solo uso; el escalón con
 * vencimiento (nivel 3) vence en 48 hs.
 */
async function upsertCuponRecupero(
  db: Db,
  restauranteId: number,
  clienteId: number,
  beneficio: BeneficioRecompra,
): Promise<string> {
  const codigo = `VOLVE${beneficio.descuento}-${clienteId}`
  const fechaFin = beneficio.expiraHoras != null
    ? new Date(Date.now() + beneficio.expiraHoras * MS_POR_HORA)
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
        valor: String(beneficio.descuento),
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
      valor: String(beneficio.descuento),
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

/**
 * Resuelve el cupón de un toque a partir del LINK, para que la tienda lo siembre en el checkout por
 * id (`codigoDescuentoId`) sin que el cliente tipee nada.
 *
 * Hermano de `upsertCuponRecupero`, no un alias: aquél **re-arma** el cupón (`usosActuales: 0` y
 * `fechaFin` nueva), que es lo correcto al emitir un toque nuevo y exactamente lo que NO hay que
 * hacer al abrir un link. Acá sólo se LEE, y se devuelve `null` si el cupón no existe, está inactivo,
 * vencido o ya usado: así el vencimiento de 48 hs de `codigo_descuento.fechaFin` es el que manda, y
 * reabrir el link no lo extiende ni revive un cupón ya gastado.
 *
 * No recibe el `%` esperado para poder crearlo si falta: el cupón lo emite el ENVÍO, no la apertura
 * del link. Si falta, este link no tiene beneficio que prometer.
 */
export async function resolverCuponLinkRecupero(
  db: Db,
  restauranteId: number,
  clienteId: number,
  descuento: number,
): Promise<{ id: number; codigo: string; fechaFin: Date | null } | null> {
  if (!Number.isFinite(descuento) || descuento <= 0) return null
  const codigo = `VOLVE${Math.trunc(descuento)}-${clienteId}`

  const [cupon] = await db
    .select({
      id: CodigoDescuentoTable.id,
      activo: CodigoDescuentoTable.activo,
      limiteUsos: CodigoDescuentoTable.limiteUsos,
      usosActuales: CodigoDescuentoTable.usosActuales,
      fechaFin: CodigoDescuentoTable.fechaFin,
    })
    .from(CodigoDescuentoTable)
    .where(
      and(
        eq(CodigoDescuentoTable.restauranteId, restauranteId),
        eq(CodigoDescuentoTable.codigo, codigo),
      ),
    )
    .limit(1)

  if (!cupon || !cupon.activo) return null
  const ahora = Date.now()
  if (cupon.fechaFin && new Date(cupon.fechaFin).getTime() <= ahora) return null
  if (cupon.limiteUsos != null && (cupon.usosActuales ?? 0) >= cupon.limiteUsos) return null
  // `fechaFin` viaja para que el resolver del link pueda mostrar el vencimiento REAL del cupón y no
  // el del token, que es sólo de exhibición.
  return { id: cupon.id, codigo, fechaFin: cupon.fechaFin ?? null }
}

export interface ResultadoEnvioRecupero {
  ok: boolean
  /** Código de error legible para la UI cuando ok=false. */
  motivo?: 'sin_whatsapp' | 'sin_telefono' | 'sin_saldo' | 'cooldown' | 'cliente_no_encontrado' | 'envio_fallido' | MotivoBloqueoMarketing
  mensaje?: string
  nivel?: number
  /** Toque que salió (1..3). El `nivel` es el de la escalera: pueden diferir en el envío manual. */
  toque?: number
  codigoDescuento?: string | null
  saldoMarketing?: number
  plantillaWhatsapp?: string
  errorEnvio?: string | null
  estado?: EstadoRecupero
}

export interface OpcionesEnvioRecupero {
  /** Clave estable del intento lógico. Impide dobles débitos y dobles envíos al reintentar. */
  operacionId?: string
  /** Segmento que clasificó la campaña. Si falta, se deriva del RFM del cliente. */
  segmento?: SegmentoRecompra
  /** Receta elegida a mano (modo manual). Sin ella se usa la recomendada del segmento. */
  receta?: SegmentoRecompra
  /**
   * Toque que le toca a este envío (1..3). El motor lo pasa desde la fila de la cola, porque entre
   * el encolado y el drenaje el ledger puede haber cambiado (el operador forzó un toque a mano) y
   * la fila quedaría mintiendo sobre lo que mandó. Se aplica como TECHO: nunca adelanta la escalera.
   */
  toque?: number
  /** Modalidad del link elegida a mano. Sin ella se deriva del descuento. */
  link?: ModalidadLink
  /** % forzado a mano (sólo modo manual). Sin él manda el escalón o el techo de la receta. */
  descuento?: number
}

/**
 * `recupero_dormido_v1` es la plantilla HISTÓRICA: sigue siendo la del 1º toque de `dormido`
 * (ya está aprobada en las WABAs de los locales, no se crea una nueva). El resto de las
 * combinaciones segmento × toque tienen la suya.
 */
export const PLANTILLA_RECUPERO_WHATSAPP = resolverPlantillaRecompra('dormido', 1)

/** De dónde salió el descuento de este envío. La UI lo muestra para que el operador sepa qué mandó. */
export type { OrigenDescuento }

export interface OpcionToqueRecompra {
  toque: ToqueRecompra
  /** "1º toque", "2º toque", "3º toque". */
  titulo: string
  /** Qué trabajo hace ese toque ("recordatorio corto", "cierre"). */
  descripcion: string
  /** % del escalón de ese toque (el que aplicaría el motor). */
  descuento: number
  expiraHoras: number | null
  /** true si es el toque que se aplicó a este mensaje. */
  esActual: boolean
  /**
   * true si es el toque que la escalera marca hoy para este cliente: el DEFAULT del diálogo. No es
   * una habilitación —el operador puede elegir cualquier toque, porque el copy es su decisión
   * editorial—, pero la UI lo resalta para que el default se entienda de un vistazo.
   */
  esDeLaEscalera: boolean
}

export interface OpcionLinkRecompra {
  modalidad: ModalidadLink
  titulo: string
  descripcion: string
  esActual: boolean
}

export interface OpcionesMensajeRecompra {
  segmentos: {
    codigo: SegmentoRecompra
    nombre: string
    /** true si es el segmento RECALCULADO en vivo del cliente (el que se usa por defecto). */
    esDelCliente: boolean
    esActual: boolean
  }[]
  toques: OpcionToqueRecompra[]
  links: OpcionLinkRecompra[]
  descuentos: { min: number; max: number; sugeridos: number[]; recomendado: number }
}

export interface DatosMensajeRecupero {
  clienteId: number
  clienteNombre: string
  telefono: string | null
  telefonoNormalizado: string | null
  restauranteNombre: string
  tiempoSinPedir: string
  productoFavorito: string
  /**
   * Línea del beneficio (la variable final del tramo). NO menciona ningún código: el descuento
   * viaja en el link, así que la tienda lo aplica sola.
   */
  incentivo: string
  descuento: number
  /** Se sigue emitiendo como mecanismo de cobro, pero ya no se muestra en el mensaje. */
  codigoDescuento: string | null
  nivel: number
  /** Toque efectivamente aplicado a este mensaje (1..3). */
  toque: ToqueRecompra
  /** Toque que traía la fila de la cola, si vino de una. La UI avisa si difiere del efectivo. */
  toquePlanificado: number | null
  /** Plantilla de Meta que corresponde a (segmento × toque). */
  plantillaWhatsapp: string
  /** ¿La plantilla lleva encabezado con la foto del producto? Sólo el 1º toque. */
  conImagen: boolean
  /** Con qué modalidad abre el link. */
  link: ModalidadLink
  /** De dónde salió el descuento aplicado. */
  descuentoOrigen: OrigenDescuento
  expiraHoras: number | null
  /** Segmento del cliente: define la receta recomendada. */
  segmento: SegmentoRecompra
  /** Segmento que clasificó la campaña (el de la fila). Difiere del vivo si el cliente cambió. */
  segmentoFila: SegmentoRecompra | null
  /** Receta aplicada a este mensaje (la recomendada salvo que el operador haya elegido otra). */
  receta: OpcionRecetaRecompra
  /** Todas las recetas disponibles con su beneficio. Es el menú de "cambiar mensaje" del modo manual. */
  recetas: OpcionRecetaRecompra[]
  /** Catálogo de los tres controles del diálogo, con sus defaults ya resueltos. */
  opciones: OpcionesMensajeRecompra
  /** Link de micro-campaña (`/c/:slug?tk=v1...`) que abre la tienda del local. */
  urlTienda: string
  /** El cuerpo del tramo ya renderizado: es el texto que se copia en modo manual. */
  texto: string
  /**
   * Los `{{n}}` del tramo, EN ORDEN: es el contrato de variables posicionales con Meta. Se manda
   * tal cual, sin nombres hardcodeados, para que la plantilla y el recetario no puedan divergir.
   */
  parametros: { nombre: VariableToque; valor: string }[]
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
 *
 * El mensaje se arma con la RECETA del segmento del cliente. En modo manual el operador puede pedir
 * otra receta (`opciones.receta`): se aplica su copy y su incentivo propio, así que si elige una
 * receta sin descuento el cupón desaparece y el link pasa a ser el de `lo-mismo`. Sin receta elegida
 * (el caso del envío automático) el beneficio es el de la escalera, sin cambios.
 */
export async function prepararMensajeRecupero(
  db: Db,
  restauranteId: number,
  clienteId: number,
  opciones: OpcionesEnvioRecupero = {},
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

  // 2. Pedidos del cliente → último pedido + producto favorito + segmento (si no vino de la cola).
  const pedidos = await db
    .select({
      id: PedidoUnificadoTable.id,
      createdAt: PedidoUnificadoTable.createdAt,
      total: PedidoUnificadoTable.total,
      estado: PedidoUnificadoTable.estado,
    })
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

  // 3. Segmento + estado de la escalera → TOQUE (el copy) y BENEFICIO (el %).
  //    Dos ejes independientes: el SEGMENTO elige la voz y el TOQUE elige el trabajo —de ahí sale la
  //    plantilla de Meta—. El BENEFICIO, en cambio, es siempre el de la escalera: cambiar de copy, de
  //    link o de % no reinicia ni adelanta el avance del cliente.
  const segmentoVivo = segmentoRecompraDePedidos(pedidos)
  const segmentoFila = opciones.segmento ?? null
  const segmento = segmentoFila ?? segmentoVivo
  const recetaRecomendada = resolverRecetaRecompra(segmento)
  const recetaSeleccionada = opciones.receta ? resolverRecetaRecompra(opciones.receta) : recetaRecomendada
  const esRecomendada = recetaSeleccionada.codigo === recetaRecomendada.codigo

  const toquesMap = await cargarToquesPorCliente(db, restauranteId, [clienteId])
  const estado = estadoRecupero(toquesMap[clienteId] ?? [], ultimoPedidoMs)
  const escalon = ESCALERA[estado.proximoNivel - 1]

  // El toque elegido a mano se respeta tal cual (es decisión editorial); el `nivel` que se registra
  // es igual el del escalón. Ver `recompra-envio.ts`, que es donde vive esta regla.
  const toquePlanificado = opciones.toque != null ? normalizarToque(opciones.toque) : null
  const envio = resolverEnvioRecompra({
    escalon,
    proximoNivel: estado.proximoNivel,
    receta: recetaSeleccionada,
    esRecetaRecomendada: esRecomendada,
    toque: toquePlanificado,
    link: opciones.link,
    descuento: opciones.descuento,
  })
  const { toque, link, descuento, descuentoOrigen, beneficio, beneficioBase } = envio
  const recetaToque = resolverRecetaToque(segmento, toque)

  // 4. Cupón: es el MECANISMO DE COBRO, no el vehículo del mensaje. El checkout recibe un
  // `codigoDescuentoId`, nunca el % del link, así que el cupón determinístico del cliente es lo que
  // hace que el descuento se aplique solo. El mensaje no lo menciona: el cliente no tipea nada.
  let codigo: string | null = null
  if (envio.emiteCupon) {
    codigo = await upsertCuponRecupero(db, restauranteId, clienteId, beneficio)
  }

  // 5. Link de micro-campaña con el carrito del último pedido adentro del token cifrado (antes:
  // `username?rep=12x2-15x1` a la vista). La tienda resuelve el slug y reconstruye cliente +
  // carrito, así que el mensaje ya no expone ids.
  const esReactivacion = link === 'reactivacion'
  const tokenMicroCampana = cifrarGrowthPayload({
    rId: restauranteId,
    cId: clienteId,
    campana: esReactivacion ? 'reactivacion' : 'lo_mismo',
    modalidad: esReactivacion ? 'descuento_banner' : 'drawer_habitual',
    rep: repParam || undefined,
    // El % viaja por el link: la tienda muestra el banner y la carta con descuento y de ahí siembra
    // el cupón en el checkout, sin que el cliente tipee nada.
    dto: descuento,
    // El link vive lo mismo que el cupón (nivel 3: 48 hs). Es de EXHIBICIÓN: el vencimiento que se
    // hace cumplir de verdad es `codigo_descuento.fechaFin`, que fija `upsertCuponRecupero`.
    exp: beneficio.expiraHoras != null ? Date.now() + beneficio.expiraHoras * MS_POR_HORA : null,
    // El cupón de este link ya lo emitió el envío: el resolver de la tienda lo LEE y no lo mintea
    // (ver `resolverCuponLinkRecupero` y `marketing.ts`).
    origen: 'recompra',
  })
  const urlTienda = rest.username
    ? urlMicroCampana(rest.username, esReactivacion ? 'reactivacion' : 'lo-mismo', tokenMicroCampana)
    : 'https://my.piru.app'
  // La plantilla de WhatsApp ya trae la base `BASE_TIENDA`: sólo se envía el
  // path dinámico del botón.
  const usernameSuffix = rest.username ? urlTienda.slice(BASE_TIENDA.length) : ''

  const tiempoSinPedir = tiempoSinPedirTexto(diasDesdeUltimo)
  const incentivo = lineaBeneficioRecompra(beneficio, toque)
  const nombreCliente = cli.nombre?.trim() || 'Cliente'
  const nombreLocal = rest.nombre?.trim() || 'El local'

  // El cuerpo sale del recetario del tramo: es el MISMO texto que el cuerpo de la plantilla de Meta,
  // así que lo que el admin previsualiza y lo que el operador copia no pueden divergir.
  const { texto: cuerpo, parametros } = componerCuerpoToque(recetaToque, {
    cliente: nombreCliente,
    local: nombreLocal,
    tiempoSinPedir,
    productoFavorito,
    beneficio: incentivo,
  } satisfies Record<VariableToque, string>)
  // En modo manual no hay botón de plantilla: el link va pegado abajo del texto.
  const texto = `${cuerpo}\n\n${urlTienda}`

  const norm = normalizarTelefonoCliente(cli.telefono)
  const telWa = norm ? (norm.startsWith('54') ? norm : norm.length === 10 ? `549${norm}` : norm) : null
  const waMeUrl = telWa ? `https://wa.me/${telWa}?text=${encodeURIComponent(texto)}` : null

  // 6. Menú de recetas: cada una con el beneficio que tendría si se eligiera. Se calcula sin tocar
  // la base (sólo se emite el cupón de la receta aplicada), así que abrir el selector no ensucia
  // cupones: al elegir otra receta se vuelve a pedir el mensaje y ahí sí se emite su cupón.
  const recetas = listarRecetasRecompra().map((r) => {
    const esRec = r.codigo === recetaRecomendada.codigo
    return opcionReceta(r, resolverBeneficioRecompra(escalon, r, esRec), {
      esRecomendada: esRec,
      esSeleccionada: r.codigo === recetaSeleccionada.codigo,
    })
  })

  // 7. Los otros dos controles del diálogo. El catálogo de toques sale de la ESCALERA (el toque y el
  // escalón son el mismo número: `nivel === toque`), así que la UI no tiene que inventar defaults.
  const opcionesUi: OpcionesMensajeRecompra = {
    segmentos: recetas.map((r) => ({
      codigo: r.codigo,
      nombre: r.nombre,
      esDelCliente: r.codigo === segmentoVivo,
      esActual: r.codigo === segmento,
    })),
    toques: TOQUES_RECOMPRA.map((t) => {
      const e = ESCALERA[t - 1]
      return {
        toque: t,
        titulo: e.titulo,
        descripcion: e.detalle,
        descuento: e.descuento,
        expiraHoras: e.expiraHoras,
        esActual: t === toque,
        esDeLaEscalera: t === estado.proximoNivel,
      }
    }),
    links: [
      {
        modalidad: 'lo-mismo' as ModalidadLink,
        titulo: 'Volver a pedir lo mismo',
        descripcion: 'Abre su último pedido ya cargado. Sin descuento: es para quien sólo necesita el empujón.',
        esActual: link === 'lo-mismo',
      },
      {
        modalidad: 'reactivacion' as ModalidadLink,
        titulo: 'Volver con descuento',
        descripcion: 'Abre la tienda con el % ya aplicado. El cliente no tipea ningún código.',
        esActual: link === 'reactivacion',
      },
    ],
    descuentos: {
      min: DESCUENTO_MIN,
      max: DESCUENTO_MAX,
      sugeridos: [10, 20],
      recomendado: beneficioBase.descuento,
    },
  }

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
      descuento,
      codigoDescuento: codigo,
      nivel: beneficio.nivel,
      toque,
      toquePlanificado,
      plantillaWhatsapp: recetaToque.plantilla,
      conImagen: recetaToque.conImagen,
      link,
      descuentoOrigen,
      expiraHoras: beneficio.expiraHoras,
      segmento,
      segmentoFila,
      receta: opcionReceta(recetaSeleccionada, beneficio, {
        esRecomendada,
        esSeleccionada: true,
      }),
      recetas,
      opciones: opcionesUi,
      urlTienda,
      texto,
      parametros,
      waMeUrl,
      imagenProducto: imagenProducto || rest.imagenUrl || null,
      usernameSuffix,
      escalon,
      estado,
    },
  }
}

/**
 * Orquesta el envío de un toque de recupero al cliente por Meta API: resuelve el tramo (segmento ×
 * toque), arma el antojo, genera el cupón si corresponde, manda el WhatsApp de marketing con la
 * marca del local, registra el toque y descuenta el bucket marketing (best-effort).
 *
 * En modo automático no se pasa nada: cada cliente recibe el toque que le marca su escalera, con el
 * copy de SU segmento y la plantilla de esa combinación. En modo manual llegan `toque`, `link` y
 * `descuento`: son decisiones editoriales del operador para ESE envío.
 */
export async function enviarRecuperoDormido(
  c: any,
  db: Db,
  restauranteId: number,
  clienteId: number,
  opciones: OpcionesEnvioRecupero = {},
): Promise<ResultadoEnvioRecupero> {
  const prep = await prepararMensajeRecupero(db, restauranteId, clienteId, {
    segmento: opciones.segmento,
    receta: opciones.receta,
    toque: opciones.toque,
    link: opciones.link,
    descuento: opciones.descuento,
  })
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
      plantillaWhatsapp: data.plantillaWhatsapp,
      estado: data.estado,
    }
  }
  if (reserva.estado === 'confirmada') {
    const [toqueConfirmado] = await db.select({
      nivel: RecuperoClienteTable.nivel,
      toque: RecuperoClienteTable.toque,
      codigoDescuento: RecuperoClienteTable.codigoDescuento,
    }).from(RecuperoClienteTable).where(and(
      eq(RecuperoClienteTable.restauranteId, restauranteId),
      eq(RecuperoClienteTable.clienteId, clienteId),
    )).orderBy(desc(RecuperoClienteTable.createdAt)).limit(1)
    return {
      ok: true,
      nivel: toqueConfirmado?.nivel ?? data.estado.ultimoNivel ?? data.escalon.nivel,
      toque: toqueConfirmado?.toque ?? undefined,
      codigoDescuento: toqueConfirmado?.codigoDescuento ?? null,
      saldoMarketing: reserva.saldoMarketingDisponible,
      plantillaWhatsapp: data.plantillaWhatsapp,
      estado: data.estado,
    }
  }
  if (reserva.estado === 'compensada') {
    return {
      ok: false,
      motivo: 'envio_fallido',
      mensaje: 'Este intento ya había fallado y su crédito fue devuelto',
      saldoMarketing: reserva.saldoMarketingDisponible,
      plantillaWhatsapp: data.plantillaWhatsapp,
      estado: data.estado,
    }
  }

  // 4. Envío de WhatsApp Meta. La plantilla, el encabezado y los parámetros salen del tramo: el
  //    1º toque lleva la foto del producto, el 2º y el 3º no llevan encabezado.
  const send = await sendClientRecuperoWhatsApp(
    c,
    {
      phone: data.telefono!,
      plantilla: data.plantillaWhatsapp,
      conImagen: data.conImagen,
      parametros: data.parametros,
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
      plantillaWhatsapp: data.plantillaWhatsapp,
      errorEnvio: typeof send.error === 'string' ? send.error : JSON.stringify(send.error ?? null).slice(0, 500),
      estado: data.estado,
    }
  }

  const confirmacion = await confirmarReservaCreditoMarketing(db, restauranteId, operacionId)

  // 5. Registrar toque en historial. Se guardan las DOS cosas: el `nivel` de la ESCALERA (el próximo
  // toque sigue la escalera aunque el operador haya elegido otro copy o forzado otro %) y el `toque`
  // que realmente salió. Difieren sólo en el envío manual forzado, y esa divergencia es la que hay
  // que poder auditar después.
  await db.insert(RecuperoClienteTable).values({
    restauranteId,
    clienteId,
    telefono: data.telefono,
    nivel: data.escalon.nivel,
    toque: data.toque,
    modalidad: data.link,
    descuentoPorcentaje: data.descuento,
    codigoDescuento: data.codigoDescuento,
    segmento: data.segmento,
  })

  const nuevoEstado = estadoRecupero(
    [...(toquesMap[clienteId] ?? []), { nivel: data.escalon.nivel, createdAt: new Date() }],
    null,
  )

  return {
    ok: true,
    nivel: data.escalon.nivel,
    toque: data.toque,
    codigoDescuento: data.codigoDescuento,
    saldoMarketing: confirmacion.saldoMarketingDisponible,
    plantillaWhatsapp: data.plantillaWhatsapp,
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
//
// Los segmentos (`SegmentoRecompra`) y su recetario viven en `recetas-recompra.ts`.
// ═════════════════════════════════════════════════════════════════════════════

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
  /** Toques enviados DESPUÉS del último pedido, sin capar. Es lo que mide el avance del goteo. */
  toquesDesdeUltimoPedido: number
  /** Timestamp del último toque enviado (de cualquier toque, no sólo los posteriores al pedido). */
  ultimoToqueMs: number | null
  fechasPedidosMs: number[]
}

/**
 * Detecta la cohorte recuperable de un local: clientes en un segmento recuperable
 * (primer_pedido/en_riesgo/dormido/perdido), con teléfono cargado y fuera del cooldown de recupero.
 * Reusa el mismo cerebro RFM que la "Base de clientes" (misma verdad, calculada on-the-fly).
 *
 * `incluirEnCooldown` levanta SÓLO el filtro de cooldown, y lo usa el reencolado del goteo: al
 * cliente que ya recibió un toque hay que volver a verlo, justamente, cuando está dentro del
 * cooldown (es la ventana que hay que esperar antes del toque siguiente). Todo lo demás —opt-out,
 * tope mensual, segmento, teléfono— se sigue filtrando igual en los dos modos.
 */
export async function cargarCohorteRecompra(
  db: Db,
  restauranteId: number,
  opciones: { incluirEnCooldown?: boolean } = {},
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
    if (!estado.puedeEnviar && !opciones.incluirEnCooldown) return
    const ultimoToqueMs = (toques[cl.id] ?? []).reduce<number | null>(
      (max, t) => (max == null || t.createdAt.getTime() > max ? t.createdAt.getTime() : max),
      null,
    )
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
      toquesDesdeUltimoPedido: estado.toquesDesdeUltimoPedido,
      ultimoToqueMs,
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

  // Grupo contactado: envío batch (reusa el mismo camino que el envío individual) con el mensaje
  // del segmento que clasificó la cohorte.
  let enviados = 0
  let fallidos = 0
  for (const cl of contactar) {
    let res: ResultadoEnvioRecupero
    try {
      res = await enviarRecuperoDormido(c, db, restauranteId, cl.clienteId, { segmento: cl.segmento })
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
