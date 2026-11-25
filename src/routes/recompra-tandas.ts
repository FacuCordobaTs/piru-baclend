import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/mysql2'
import { and, asc, desc, eq, gte, inArray, ne } from 'drizzle-orm'
import { pool } from '../db'
import { authMiddleware } from '../middleware/auth'
import { requireModulo } from '../middleware/modulo'
import { MODULE_KEYS, tieneModuloActivo } from '../lib/modulos'
import {
  cliente as ClienteTable,
  codigoDescuento as CodigoDescuentoTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  marketingContacto as MarketingContactoTable,
  marketingEnlace as MarketingEnlaceTable,
  pedidoUnificado as PedidoUnificadoTable,
  producto as ProductoTable,
  productoPuntos as ProductoPuntosTable,
  recompraTanda as TandaTable,
  recompraTandaMensaje as MensajeTable,
  recuperoCliente as RecuperoClienteTable,
  restaurante as RestauranteTable,
  sucursal as SucursalTable,
} from '../db/schema'
import {
  carritoRep,
  componerTextos,
  datosDe,
  elegibles,
  planificarTanda,
  preparar,
  primerNombre,
  TANDA_MAXIMO,
  type ClienteTanda,
  type ItemPedidoTanda,
  type LocalTanda,
  type MensajePlanificado,
  type PedidoTanda,
  type ProductoTanda,
} from '../lib/recompra-tandas'
import {
  canalDelNumero,
  clavePunto,
  puntoDeLaTanda,
  puntosEnvio,
  resolverPunto,
  type AlcanceEnvio,
  type PuntoEnvio,
} from '../lib/recompra-puntos'
import { cargarPoliticaIncentivosPuntos } from '../lib/puntos-beneficios-pedido'
import { anclajePublico, generarTokenMarketing, hashTokenMarketing, urlEnlaceReceta, urlMicroCampana } from '../lib/marketing-enlaces'
import { cifrarGrowthPayload } from '../lib/marketing-crypto'
import { telefonoWaMe, urlWaMe } from '../lib/zonas-especiales'
import { chequearProteccionMarketing, VENTANA_TOPE_DIAS } from '../lib/proteccion-base'
import {
  compensarReservaCreditoMarketing,
  confirmarReservaCreditoMarketing,
  getOrCreateSaldo,
  listarPacks,
  marketingDisponible,
  reservarCreditoMarketing,
} from '../lib/mensajes-wallet'
import {
  BOTON_PLANTILLA_TANDA,
  cuerpoPlantillaTanda,
  resolverCredsRestaurante,
  sendTandaWhatsApp,
} from '../services/whatsapp'
import { registrarMensajeChat } from '../lib/whatsapp-chats'
import { asegurarCampanasMaestras } from './marketing'

const MS_HORA = 60 * 60 * 1000
const MS_DIA = 24 * MS_HORA
/** Margen para mandar la tanda más tarde: el beneficio corre desde que se envía cada mensaje. */
const MARGEN_ENVIO_MS = 48 * MS_HORA
/** Un pedido dentro de estos días después del mensaje cuenta como "volvió". */
const DIAS_RESULTADO = 14

const dbTipo = () => drizzle(pool)
type Db = ReturnType<typeof dbTipo>

async function cargarLocal(db: Db, restauranteId: number) {
  const [local] = await db.select({
    nombre: RestauranteTable.nombre,
    username: RestauranteTable.username,
    dominioTienda: RestauranteTable.dominioTienda,
    deliveryEnabled: RestauranteTable.deliveryEnabled,
    deliveryFee: RestauranteTable.deliveryFee,
    whatsappNumber: RestauranteTable.whatsappNumber,
    whatsappPhoneId: RestauranteTable.whatsappPhoneId,
    whatsappAccessToken: RestauranteTable.whatsappAccessToken,
  }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1)
  return local ?? null
}

function cargarSucursales(db: Db, restauranteId: number) {
  return db.select({
    id: SucursalTable.id,
    nombre: SucursalTable.nombre,
    activo: SucursalTable.activo,
    soloPos: SucursalTable.soloPos,
    whatsappEnabled: SucursalTable.whatsappEnabled,
    whatsappNumber: SucursalTable.whatsappNumber,
  }).from(SucursalTable).where(eq(SucursalTable.restauranteId, restauranteId))
    .orderBy(asc(SucursalTable.id))
}

/** Con avisos automáticos el envío puede salir por la API; cada punto decide si su número es el conectado. */
function moduloAvisosAutomaticos(db: Db, restauranteId: number) {
  return tieneModuloActivo(db as any, restauranteId, MODULE_KEYS.AVISOS_AUTOMATICOS_WHATSAPP)
    .catch(() => false)
}

/** Toda la base del local, en una pasada: la recomendación depende de la distribución completa. */
async function cargarBase(db: Db, restauranteId: number) {
  const ahora = Date.now()
  const [clientes, pedidos, items, productos, puntosProducto, tandas, recuperos, contactos] = await Promise.all([
    db.select({
      id: ClienteTable.id, nombre: ClienteTable.nombre, telefono: ClienteTable.telefono,
      optOut: ClienteTable.marketingOptOut, puntos: ClienteTable.puntos,
    }).from(ClienteTable).where(eq(ClienteTable.restauranteId, restauranteId)),
    db.select({
      id: PedidoUnificadoTable.id, clienteId: PedidoUnificadoTable.clienteId, total: PedidoUnificadoTable.total,
      tipo: PedidoUnificadoTable.tipo, createdAt: PedidoUnificadoTable.createdAt,
      sucursalId: PedidoUnificadoTable.sucursalId,
    }).from(PedidoUnificadoTable).where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId), ne(PedidoUnificadoTable.estado, 'cancelled'),
    )),
    db.select({
      pedidoId: ItemPedidoUnificadoTable.pedidoId, productoId: ItemPedidoUnificadoTable.productoId,
      cantidad: ItemPedidoUnificadoTable.cantidad, varianteId: ItemPedidoUnificadoTable.varianteId,
      varianteSecundariaId: ItemPedidoUnificadoTable.varianteSecundariaId, agregados: ItemPedidoUnificadoTable.agregados,
    }).from(ItemPedidoUnificadoTable)
      .innerJoin(PedidoUnificadoTable, eq(ItemPedidoUnificadoTable.pedidoId, PedidoUnificadoTable.id))
      .where(and(eq(PedidoUnificadoTable.restauranteId, restauranteId), ne(PedidoUnificadoTable.estado, 'cancelled'))),
    db.select({
      id: ProductoTable.id, nombre: ProductoTable.nombre, precio: ProductoTable.precio, imagenUrl: ProductoTable.imagenUrl,
      tieneVariantes: ProductoTable.tieneVariantes, activo: ProductoTable.activo,
      soloCanjePuntos: ProductoTable.soloCanjePuntos, eventoSucursalId: ProductoTable.eventoSucursalId,
    }).from(ProductoTable).where(eq(ProductoTable.restauranteId, restauranteId)),
    db.select({ productoId: ProductoPuntosTable.productoId, puntosGanados: ProductoPuntosTable.puntosGanados })
      .from(ProductoPuntosTable).where(eq(ProductoPuntosTable.restauranteId, restauranteId)),
    db.select({ clienteId: MensajeTable.clienteId, createdAt: MensajeTable.createdAt, enviadoAt: MensajeTable.enviadoAt })
      .from(MensajeTable).where(and(
        eq(MensajeTable.restauranteId, restauranteId),
        gte(MensajeTable.createdAt, new Date(ahora - 60 * MS_DIA)),
      )),
    db.select({ clienteId: RecuperoClienteTable.clienteId, createdAt: RecuperoClienteTable.createdAt })
      .from(RecuperoClienteTable).where(and(
        eq(RecuperoClienteTable.restauranteId, restauranteId),
        gte(RecuperoClienteTable.createdAt, new Date(ahora - 60 * MS_DIA)),
      )),
    db.select({ clienteId: MarketingContactoTable.clienteId, createdAt: MarketingContactoTable.createdAt })
      .from(MarketingContactoTable).where(and(
        eq(MarketingContactoTable.restauranteId, restauranteId),
        inArray(MarketingContactoTable.estado, ['abierto', 'reservado', 'enviado']),
        gte(MarketingContactoTable.createdAt, new Date(ahora - 60 * MS_DIA)),
      )),
  ])

  const ganados = new Map<number, number>(puntosProducto.map((p: any) => [p.productoId, p.puntosGanados ?? 0]))
  const catalogo = new Map<number, ProductoTanda>(productos
    .filter((p) => !p.soloCanjePuntos && p.eventoSucursalId == null)
    .map((p) => [p.id, {
      id: p.id, nombre: p.nombre, precio: Number(p.precio) || 0, imagenUrl: p.imagenUrl,
      puntosGanados: ganados.get(p.id) ?? 0, tieneVariantes: Boolean(p.tieneVariantes), activo: p.activo !== false,
    }]))

  const itemsPorPedido = new Map<number, ItemPedidoTanda[]>()
  for (const it of items) {
    if (!catalogo.has(it.productoId)) continue
    const agregados = Array.isArray(it.agregados)
      ? (it.agregados as unknown[]).map((a) => Number(typeof a === 'object' && a !== null ? (a as any).id : a)).filter((n) => Number.isInteger(n) && n > 0)
      : []
    const lista = itemsPorPedido.get(it.pedidoId) ?? []
    lista.push({ productoId: it.productoId, cantidad: it.cantidad ?? 1, varianteId: it.varianteId, varianteSecundariaId: it.varianteSecundariaId, agregadoIds: agregados })
    itemsPorPedido.set(it.pedidoId, lista)
  }

  const pedidosPorCliente = new Map<number, PedidoTanda[]>()
  const vendidos = new Map<number, number>()
  let pedidosSinSucursal = 0
  for (const p of pedidos) {
    if (p.clienteId == null) continue
    const fecha = new Date(p.createdAt).getTime()
    const lista = pedidosPorCliente.get(p.clienteId) ?? []
    const its = itemsPorPedido.get(p.id) ?? []
    const sucursalId = p.sucursalId ?? null
    if (sucursalId == null) pedidosSinSucursal++
    lista.push({ fecha, total: Number(p.total) || 0, delivery: p.tipo === 'delivery', items: its, sucursalId })
    pedidosPorCliente.set(p.clienteId, lista)
    if (ahora - fecha <= 90 * MS_DIA) for (const it of its) vendidos.set(it.productoId, (vendidos.get(it.productoId) ?? 0) + it.cantidad)
  }
  const populares = [...vendidos.entries()].sort((a, b) => b[1] - a[1])
    .map(([id]) => catalogo.get(id)!).filter((p) => p?.activo).slice(0, 8)

  const ultimo = new Map<number, number>()
  const marcar = (clienteId: number | null, fecha: Date | null) => {
    if (clienteId == null || !fecha) return
    const ms = new Date(fecha).getTime()
    if (ms > (ultimo.get(clienteId) ?? 0)) ultimo.set(clienteId, ms)
  }
  for (const t of tandas) marcar(t.clienteId, t.enviadoAt ?? t.createdAt)
  for (const r of recuperos) marcar(r.clienteId, r.createdAt)
  for (const c of contactos) marcar(c.clienteId, c.createdAt)

  const base: ClienteTanda[] = clientes.map((c) => ({
    id: c.id,
    nombre: c.nombre,
    telefono: telefonoWaMe(c.telefono),
    optOut: Boolean(c.optOut),
    puntos: c.puntos ?? 0,
    pedidos: pedidosPorCliente.get(c.id) ?? [],
    ultimoContacto: ultimo.get(c.id) ?? null,
  }))
  return { clientes: base, catalogo, populares, pedidosSinSucursal }
}

async function contexto(db: Db, restauranteId: number) {
  const [local, sucursales] = await Promise.all([
    cargarLocal(db, restauranteId),
    cargarSucursales(db, restauranteId),
  ])
  if (!local) return null
  const [base, politica, avisos] = await Promise.all([
    cargarBase(db, restauranteId),
    cargarPoliticaIncentivosPuntos(db, restauranteId),
    moduloAvisosAutomaticos(db, restauranteId),
  ])
  const localTanda: LocalTanda = {
    nombre: local.nombre ?? 'el local',
    deliveryEnabled: Boolean(local.deliveryEnabled),
    deliveryFee: Number(local.deliveryFee) || 0,
    puntos: politica.disponible ? politica.config : null,
  }
  const puntos = puntosEnvio({
    nombreLocal: localTanda.nombre,
    whatsappNumber: local.whatsappNumber,
    whatsappPhoneId: local.whatsappPhoneId,
    sucursales,
    pedidosSinSucursal: base.pedidosSinSucursal,
  }, avisos)
  const ahora = Date.now()
  const elegiblesDe = (punto: PuntoEnvio) => elegibles(
    base.clientes,
    base.catalogo,
    base.populares,
    ahora,
    { alcance: punto.alcance, sucursalId: punto.sucursalId },
  )
  return { local, sucursales, base, localTanda, puntos, elegiblesDe }
}

const numero = (v: unknown) => Number(v) || 0

function aMensajeApi(m: typeof MensajeTable.$inferSelect, canal: 'manual' | 'api', resultado?: { total: number; at: string } | null) {
  const nombre = primerNombre(m.clienteNombre)
  return {
    id: m.id,
    clienteId: m.clienteId,
    clienteNombre: m.clienteNombre,
    telefono: m.telefono,
    orden: m.orden,
    segmento: m.segmento,
    angulo: m.angulo,
    texto: m.texto,
    motivos: (m.motivos as string[]) ?? [],
    datos: m.datos,
    beneficio: {
      tipo: m.beneficioTipo,
      valor: numero(m.beneficioValor),
      etiqueta: m.beneficioEtiqueta,
      costoMaximo: numero(m.costoMaximo),
      vigenciaHoras: m.vigenciaHoras,
    },
    link: m.link,
    waMeUrl: urlWaMe(m.telefono, m.texto),
    // Lo que ve el cliente cuando sale por Meta: la plantilla con su encabezado y el botón.
    plantilla: canal === 'api'
      ? { cuerpo: cuerpoPlantillaTanda(nombre || 'ahí', m.textoPlantilla), imagenUrl: m.imagenUrl, boton: BOTON_PLANTILLA_TANDA }
      : null,
    estado: m.estado,
    canalEnvio: m.canalEnvio,
    enviadoAt: m.enviadoAt ? new Date(m.enviadoAt).toISOString() : null,
    errorEnvio: m.errorEnvio,
    resultado: resultado ?? null,
  }
}

/** Para cada mensaje enviado, el primer pedido del cliente dentro de los días siguientes. */
async function resultados(db: Db, restauranteId: number, mensajes: { id: number; clienteId: number; enviadoAt: Date | null }[]) {
  const enviados = mensajes.filter((m) => m.enviadoAt)
  const mapa = new Map<number, { total: number; at: string }>()
  if (!enviados.length) return mapa
  const desde = new Date(Math.min(...enviados.map((m) => new Date(m.enviadoAt!).getTime())))
  const pedidos = await db.select({ clienteId: PedidoUnificadoTable.clienteId, total: PedidoUnificadoTable.total, createdAt: PedidoUnificadoTable.createdAt })
    .from(PedidoUnificadoTable).where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId),
      ne(PedidoUnificadoTable.estado, 'cancelled'),
      inArray(PedidoUnificadoTable.clienteId, [...new Set(enviados.map((m) => m.clienteId))]),
      gte(PedidoUnificadoTable.createdAt, desde),
    )).orderBy(PedidoUnificadoTable.createdAt)
  for (const m of enviados) {
    const desdeMs = new Date(m.enviadoAt!).getTime()
    const p = pedidos.find((p) => p.clienteId === m.clienteId && new Date(p.createdAt).getTime() >= desdeMs
      && new Date(p.createdAt).getTime() - desdeMs <= DIAS_RESULTADO * MS_DIA)
    if (p) mapa.set(m.id, { total: numero(p.total), at: new Date(p.createdAt).toISOString() })
  }
  return mapa
}

/** El link personal de cada mensaje: cupón + link `/r/` o un link con token firmado. */
async function crearLink(tx: any, params: {
  restauranteId: number
  tandaId: number
  m: MensajePlanificado
  anclaje: NonNullable<ReturnType<typeof anclajePublico>>
  ahora: number
}): Promise<{ link: string; codigoDescuentoId: number | null; enlaceId: number | null }> {
  const { restauranteId, tandaId, m, anclaje, ahora } = params
  const b = m.beneficio
  const clienteId = m.perfil.cliente.id
  const rep = carritoRep(m.carrito)
  const vence = new Date(ahora + ('horas' in b ? b.horas * MS_HORA : 30 * MS_DIA) + MARGEN_ENVIO_MS)
  const conCupon = b.tipo === 'porcentaje' || b.tipo === 'monto_fijo' || b.tipo === 'envio_gratis'

  if (conCupon || (b.tipo === 'ninguno' && m.productoDestino != null)) {
    let codigoDescuentoId: number | null = null
    if (conCupon) {
      const resultado = await tx.insert(CodigoDescuentoTable).values({
        restauranteId,
        codigo: `TANDA${tandaId}-${clienteId}`,
        tipo: b.tipo,
        valor: b.tipo === 'envio_gratis' ? '0.00' : String(b.valor),
        limiteUsos: 1,
        usosActuales: 0,
        montoMinimo: b.tipo === 'monto_fijo' ? String(b.minimo) : '0.00',
        fechaInicio: new Date(ahora),
        fechaFin: vence,
        activo: true,
        generadoAutomaticamente: true,
      })
      codigoDescuentoId = Number(resultado[0].insertId)
    }
    const token = generarTokenMarketing()
    const destinoTipo = m.productoDestino != null ? 'producto' : rep ? 'carrito' : 'tienda'
    const resultado = await tx.insert(MarketingEnlaceTable).values({
      restauranteId,
      clienteId,
      tokenHash: hashTokenMarketing(token),
      idempotenciaClave: `tanda:${tandaId}:${clienteId}`,
      destinoTipo,
      productoId: m.productoDestino,
      carritoRep: destinoTipo === 'carrito' ? rep : null,
      codigoDescuentoId,
      expiraAt: vence,
    })
    return { link: urlEnlaceReceta(anclaje, token), codigoDescuentoId, enlaceId: Number(resultado[0].insertId) }
  }

  // Sin cupón: el link de "lo mismo de siempre" deja armado el carrito y, con puntos, lleva el
  // bonus firmado (el checkout lo vuelve a validar). Sin carrito, la tienda reconstruye el último pedido.
  const token = cifrarGrowthPayload({
    rId: restauranteId,
    cId: clienteId,
    campana: 'lo_mismo',
    modalidad: b.tipo === 'puntos' ? 'puntos_banner' : 'drawer_habitual',
    ...(rep ? { rep } : {}),
    ...(b.tipo === 'puntos' ? { puntos: b.puntos, pmin: b.minimo } : {}),
    exp: vence.getTime(),
  })
  return { link: urlMicroCampana(anclaje, 'lo-mismo', token), codigoDescuentoId: null, enlaceId: null }
}

const crearSchema = z.object({
  cantidad: z.number().int().min(1).max(TANDA_MAXIMO),
  presupuesto: z.number().min(0).max(100_000_000),
})
const idsSchema = z.object({ id: z.coerce.number().int().positive(), mid: z.coerce.number().int().positive() })

export function crearRecompraTandasRoute() {
  const route = new Hono()
  route.use('*', authMiddleware, requireModulo(MODULE_KEYS.MOTOR_RECOMPRA))
  const db = drizzle(pool)

  route.get('/preparacion', async (c: any) => {
    const ctx = await contexto(db, c.user.id)
    if (!ctx) return c.json({ success: false, message: 'Local no encontrado' }, 404)
    const prep = preparar(ctx.elegibles)
    return c.json({
      success: true,
      data: {
        ...prep,
        canal: ctx.canal,
        conPuntos: ctx.localTanda.puntos != null,
        localNombre: ctx.local.nombre,
        tieneTienda: anclajePublico(ctx.local) != null,
      },
    })
  })

  // Envío automático: cuántos mensajes de marketing quedan y los packs para comprar más. Cada
  // mensaje de una tanda por Meta usa uno; sin saldo no sale ninguno.
  route.get('/mensajes', async (c: any) => {
    const restauranteId = c.user.id as number
    const [saldo, packs] = await Promise.all([
      getOrCreateSaldo(db as any, restauranteId),
      listarPacks(db as any, 'marketing'),
    ])
    return c.json({
      success: true,
      data: {
        disponibles: marketingDisponible(saldo),
        packs: packs.slice(0, 3).map((p: any) => ({ id: p.id, nombre: p.nombre, cantidad: p.cantidad, precio: Number(p.precio) })),
      },
    })
  })

  route.get('/', async (c: any) => {
    const restauranteId = c.user.id as number
    const tandas = await db.select().from(TandaTable).where(eq(TandaTable.restauranteId, restauranteId))
      .orderBy(desc(TandaTable.createdAt)).limit(30)
    if (!tandas.length) return c.json({ success: true, data: [] })
    const mensajes = await db.select({
      id: MensajeTable.id, tandaId: MensajeTable.tandaId, clienteId: MensajeTable.clienteId, clienteNombre: MensajeTable.clienteNombre,
      estado: MensajeTable.estado, enviadoAt: MensajeTable.enviadoAt,
    }).from(MensajeTable).where(and(eq(MensajeTable.restauranteId, restauranteId), inArray(MensajeTable.tandaId, tandas.map((t) => t.id))))
    const vueltas = await resultados(db, restauranteId, mensajes)
    return c.json({
      success: true,
      data: tandas.map((t) => {
        const suyos = mensajes.filter((m) => m.tandaId === t.id)
        const volvieron = suyos.filter((m) => vueltas.has(m.id))
        return {
          id: t.id,
          canal: t.canal,
          createdAt: new Date(t.createdAt).toISOString(),
          presupuesto: numero(t.presupuesto),
          presupuestoAsignado: numero(t.presupuestoAsignado),
          conPuntos: t.conPuntos,
          total: suyos.length,
          enviados: suyos.filter((m) => m.estado === 'enviado').length,
          descartados: suyos.filter((m) => m.estado === 'descartado').length,
          volvieron: volvieron.length,
          ventas: volvieron.reduce((s, m) => s + (vueltas.get(m.id)?.total ?? 0), 0),
          nombres: suyos.slice(0, 4).map((m) => primerNombre(m.clienteNombre)),
        }
      }),
    })
  })

  route.post('/', zValidator('json', crearSchema), async (c: any) => {
    const restauranteId = c.user.id as number
    const { cantidad, presupuesto } = c.req.valid('json') as z.infer<typeof crearSchema>
    const ctx = await contexto(db, restauranteId)
    if (!ctx) return c.json({ success: false, message: 'Local no encontrado' }, 404)
    const anclaje = anclajePublico(ctx.local)
    if (!anclaje) return c.json({ success: false, code: 'sin_tienda', message: 'Tu tienda todavía no tiene dirección: configurala para poder mandar links.' }, 422)
    if (!ctx.elegibles.perfiles.length) {
      return c.json({ success: false, code: 'sin_clientes', message: 'Ahora no hay clientes a los que convenga escribirles. Probá en unos días.' }, 409)
    }
    await asegurarCampanasMaestras(db, restauranteId)

    const ahora = Date.now()
    const tandaId = await db.transaction(async (tx) => {
      const [insert] = await tx.insert(TandaTable).values({
        restauranteId,
        canal: ctx.canal,
        cantidadPedida: cantidad,
        presupuesto: presupuesto.toFixed(2),
        conPuntos: ctx.localTanda.puntos != null,
      })
      const id = Number(insert.insertId)
      const plan = planificarTanda({
        elegibles: ctx.elegibles.perfiles,
        cantidad,
        presupuesto,
        local: ctx.localTanda,
        productos: ctx.base.catalogo,
        semilla: id * 7919 + restauranteId,
        ahora,
      })
      let asignado = 0
      for (const [orden, m] of plan.entries()) {
        const link = await crearLink(tx, { restauranteId, tandaId: id, m, anclaje, ahora })
        const textos = componerTextos(m, link.link)
        asignado += m.beneficio.costo
        await tx.insert(MensajeTable).values({
          restauranteId,
          tandaId: id,
          clienteId: m.perfil.cliente.id,
          orden,
          clienteNombre: m.perfil.cliente.nombre.slice(0, 255),
          telefono: m.perfil.cliente.telefono!,
          segmento: m.perfil.segmento,
          angulo: m.angulo,
          texto: textos.texto,
          textoPlantilla: textos.textoPlantilla,
          motivos: m.motivos,
          datos: datosDe(m.perfil, ctx.localTanda.puntos != null),
          beneficioTipo: m.beneficio.tipo,
          beneficioValor: String(m.beneficio.tipo === 'puntos' ? m.beneficio.puntos : 'valor' in m.beneficio ? m.beneficio.valor : 0),
          beneficioEtiqueta: m.beneficioEtiqueta,
          costoMaximo: String(m.beneficio.costo),
          vigenciaHoras: 'horas' in m.beneficio ? m.beneficio.horas : null,
          link: link.link,
          codigoDescuentoId: link.codigoDescuentoId,
          enlaceId: link.enlaceId,
          imagenUrl: m.imagenUrl,
        })
      }
      await tx.update(TandaTable).set({ presupuestoAsignado: asignado.toFixed(2) })
        .where(and(eq(TandaTable.restauranteId, restauranteId), eq(TandaTable.id, id)))
      return id
    })
    return c.json({ success: true, data: await leerTanda(db, restauranteId, tandaId) }, 201)
  })

  // Cancelar una tanda la borra entera: sus mensajes, y los cupones y links de los que no se
  // mandaron. Los clientes vuelven a quedar disponibles para otra tanda (no cuentan como contactados).
  // Los mensajes ya enviados conservan su cupón y su link, porque el cliente ya los tiene.
  route.delete('/:id', zValidator('param', z.object({ id: z.coerce.number().int().positive() })), async (c: any) => {
    const restauranteId = c.user.id as number
    const id = Number(c.req.valid('param').id)
    const [tanda] = await db.select({ id: TandaTable.id }).from(TandaTable)
      .where(and(eq(TandaTable.restauranteId, restauranteId), eq(TandaTable.id, id))).limit(1)
    if (!tanda) return c.json({ success: false, message: 'Tanda no encontrada' }, 404)
    const mensajes = await db.select({
      estado: MensajeTable.estado, enlaceId: MensajeTable.enlaceId, codigoDescuentoId: MensajeTable.codigoDescuentoId,
    }).from(MensajeTable).where(and(eq(MensajeTable.restauranteId, restauranteId), eq(MensajeTable.tandaId, id)))
    const sinMandar = mensajes.filter((m) => m.estado !== 'enviado')
    const enlaces = sinMandar.flatMap((m) => (m.enlaceId ? [m.enlaceId] : []))
    const cupones = sinMandar.flatMap((m) => (m.codigoDescuentoId ? [m.codigoDescuentoId] : []))
    await db.transaction(async (tx) => {
      await tx.delete(MensajeTable).where(and(eq(MensajeTable.restauranteId, restauranteId), eq(MensajeTable.tandaId, id)))
      if (enlaces.length) {
        await tx.delete(MarketingEnlaceTable).where(and(eq(MarketingEnlaceTable.restauranteId, restauranteId), inArray(MarketingEnlaceTable.id, enlaces)))
      }
      if (cupones.length) {
        // Un cupón sin usar se borra; si alguien llegó a usarlo, se apaga para no romper el pedido.
        await tx.update(CodigoDescuentoTable).set({ activo: false })
          .where(and(eq(CodigoDescuentoTable.restauranteId, restauranteId), inArray(CodigoDescuentoTable.id, cupones)))
        await tx.delete(CodigoDescuentoTable).where(and(
          eq(CodigoDescuentoTable.restauranteId, restauranteId),
          inArray(CodigoDescuentoTable.id, cupones),
          eq(CodigoDescuentoTable.usosActuales, 0),
        )).catch(() => undefined)
      }
      await tx.delete(TandaTable).where(and(eq(TandaTable.restauranteId, restauranteId), eq(TandaTable.id, id)))
    })
    return c.json({ success: true })
  })

  route.get('/:id', zValidator('param', z.object({ id: z.coerce.number().int().positive() })), async (c: any) => {
    const tanda = await leerTanda(db, c.user.id, Number(c.req.valid('param').id))
    if (!tanda) return c.json({ success: false, message: 'Tanda no encontrada' }, 404)
    return c.json({ success: true, data: tanda })
  })

  // Modo manual: al abrir el WhatsApp del local con el texto listo, el mensaje cuenta como enviado
  // y el beneficio empieza a correr. Se puede deshacer si al final no se mandó.
  route.post('/:id/mensajes/:mid/abrir', zValidator('param', idsSchema), async (c: any) => {
    const { id, mid } = c.req.valid('param')
    const m = await buscarMensaje(db, c.user.id, id, mid)
    if (!m) return c.json({ success: false, message: 'Mensaje no encontrado' }, 404)
    if (m.estado === 'pendiente') {
      const ahora = new Date()
      await db.update(MensajeTable).set({ estado: 'enviado', canalEnvio: 'wa_me', enviadoAt: ahora, errorEnvio: null })
        .where(and(eq(MensajeTable.restauranteId, c.user.id), eq(MensajeTable.id, mid)))
      await arrancarBeneficio(db, c.user.id, m, ahora)
    }
    return c.json({ success: true, data: await mensajeActual(db, c.user.id, id, mid) })
  })

  route.post('/:id/mensajes/:mid/deshacer', zValidator('param', idsSchema), async (c: any) => {
    const { id, mid } = c.req.valid('param')
    const m = await buscarMensaje(db, c.user.id, id, mid)
    if (!m) return c.json({ success: false, message: 'Mensaje no encontrado' }, 404)
    if (m.canalEnvio === 'api') return c.json({ success: false, message: 'Este mensaje ya salió por WhatsApp y no se puede deshacer.' }, 409)
    await db.update(MensajeTable).set({ estado: 'pendiente', canalEnvio: null, enviadoAt: null })
      .where(and(eq(MensajeTable.restauranteId, c.user.id), eq(MensajeTable.id, mid)))
    await activarBeneficio(db, c.user.id, m, true)
    return c.json({ success: true, data: await mensajeActual(db, c.user.id, id, mid) })
  })

  route.post('/:id/mensajes/:mid/descartar', zValidator('param', idsSchema), async (c: any) => {
    const { id, mid } = c.req.valid('param')
    const m = await buscarMensaje(db, c.user.id, id, mid)
    if (!m) return c.json({ success: false, message: 'Mensaje no encontrado' }, 404)
    if (m.estado === 'enviado') return c.json({ success: false, message: 'Este mensaje ya se mandó.' }, 409)
    await db.update(MensajeTable).set({ estado: 'descartado' })
      .where(and(eq(MensajeTable.restauranteId, c.user.id), eq(MensajeTable.id, mid)))
    await activarBeneficio(db, c.user.id, m, false)
    return c.json({ success: true, data: await mensajeActual(db, c.user.id, id, mid) })
  })

  // API de Meta: un mensaje por vez, y sólo cuando el dueño aprieta "Enviar".
  route.post('/:id/mensajes/:mid/enviar', zValidator('param', idsSchema), async (c: any) => {
    const restauranteId = c.user.id as number
    const { id, mid } = c.req.valid('param')
    const [tanda] = await db.select().from(TandaTable).where(and(eq(TandaTable.restauranteId, restauranteId), eq(TandaTable.id, id))).limit(1)
    const m = await buscarMensaje(db, restauranteId, id, mid)
    if (!tanda || !m) return c.json({ success: false, message: 'Mensaje no encontrado' }, 404)
    if (m.estado === 'enviado') return c.json({ success: true, data: await mensajeActual(db, restauranteId, id, mid) })
    if (m.estado !== 'pendiente') return c.json({ success: false, message: 'Este mensaje fue descartado.' }, 409)
    const local = await cargarLocal(db, restauranteId)
    if (!local || tanda.canal !== 'api' || await canalDe(db, restauranteId, local) !== 'api') {
      return c.json({ success: false, code: 'sin_api', message: 'Este local no tiene el envío automático por WhatsApp. Mandalo desde tu WhatsApp.' }, 409)
    }
    // El botón de la plantilla trae embebida la raíz de la tienda pública; viaja lo que sigue.
    const anclaje = anclajePublico(local)
    const raiz = anclaje ? anclaje.base + anclaje.prefijo : null
    if (!raiz || !m.link.startsWith(raiz)) {
      return c.json({ success: false, code: 'link_desactualizado', message: 'La dirección de la tienda cambió: armá una tanda nueva.' }, 409)
    }

    const [cliente] = await db.select({ optOut: ClienteTable.marketingOptOut }).from(ClienteTable)
      .where(and(eq(ClienteTable.restauranteId, restauranteId), eq(ClienteTable.id, m.clienteId))).limit(1)
    const desde = new Date(Date.now() - VENTANA_TOPE_DIAS * MS_DIA)
    const [toquesTanda, toquesRecupero] = await Promise.all([
      db.select({ createdAt: MensajeTable.enviadoAt }).from(MensajeTable).where(and(
        eq(MensajeTable.restauranteId, restauranteId), eq(MensajeTable.clienteId, m.clienteId),
        eq(MensajeTable.estado, 'enviado'), gte(MensajeTable.enviadoAt, desde),
      )),
      db.select({ createdAt: RecuperoClienteTable.createdAt }).from(RecuperoClienteTable).where(and(
        eq(RecuperoClienteTable.restauranteId, restauranteId), eq(RecuperoClienteTable.clienteId, m.clienteId),
        gte(RecuperoClienteTable.createdAt, desde),
      )),
    ])
    const proteccion = chequearProteccionMarketing({
      optOut: Boolean(cliente?.optOut),
      toques: [...toquesTanda, ...toquesRecupero].filter((t) => t.createdAt).map((t) => ({ createdAt: new Date(t.createdAt!) })),
    })
    if (!proteccion.permitido) return c.json({ success: false, code: proteccion.motivo, message: proteccion.mensaje }, 409)

    // La reserva del saldo es también el candado: un segundo toque mientras sale el primero no reenvía.
    // Si un intento anterior falló (crédito devuelto), se reintenta con otra operación.
    let operacion = `tanda-mensaje:${mid}`
    let reserva = await reservarCreditoMarketing(db as any, restauranteId, operacion, 'reserva_marketing_tanda')
    if (reserva.estado === 'compensada') {
      operacion = `tanda-mensaje:${mid}:${Date.now()}`
      reserva = await reservarCreditoMarketing(db as any, restauranteId, operacion, 'reserva_marketing_tanda')
    }
    if (reserva.estado === 'sin_saldo') {
      return c.json({ success: false, code: 'saldo_insuficiente', message: 'No te quedan mensajes de marketing. Recargá en Mensajes para seguir.' }, 409)
    }
    if (reserva.estado === 'confirmada') return c.json({ success: true, data: await mensajeActual(db, restauranteId, id, mid) })
    if (reserva.idempotente) return c.json({ success: false, code: 'envio_en_proceso', message: 'Este mensaje se está enviando.' }, 409)

    const nombre = primerNombre(m.clienteNombre) || 'ahí'
    const envio = await sendTandaWhatsApp({
      phone: m.telefono,
      nombre,
      texto: m.textoPlantilla,
      pathBoton: m.link.slice(raiz.length),
      imagenUrl: m.imagenUrl,
    }, resolverCredsRestaurante(local))
    if (!envio.success || !envio.id) {
      await compensarReservaCreditoMarketing(db as any, restauranteId, operacion)
      await db.update(MensajeTable).set({ errorEnvio: 'WhatsApp no aceptó el mensaje' })
        .where(and(eq(MensajeTable.restauranteId, restauranteId), eq(MensajeTable.id, mid)))
      return c.json({ success: false, code: 'envio_fallido', message: 'WhatsApp no aceptó el mensaje. Probá de nuevo o mandalo desde tu WhatsApp.' }, 502)
    }
    const ahora = new Date()
    await db.update(MensajeTable).set({ estado: 'enviado', canalEnvio: 'api', enviadoAt: ahora, proveedorMessageId: envio.id, errorEnvio: null })
      .where(and(eq(MensajeTable.restauranteId, restauranteId), eq(MensajeTable.id, mid)))
    await confirmarReservaCreditoMarketing(db as any, restauranteId, operacion)
    await arrancarBeneficio(db, restauranteId, m, ahora)
    await registrarMensajeChat(db, {
      restauranteId,
      telefono: m.telefono,
      direccion: 'saliente',
      origen: 'tanda',
      texto: `${cuerpoPlantillaTanda(nombre, m.textoPlantilla)}\n\n[${BOTON_PLANTILLA_TANDA}]`,
      imagenUrl: m.imagenUrl,
      waMessageId: envio.id,
      createdAt: ahora,
    }).catch((error) => console.error('[tandas] No se pudo registrar el mensaje en el chat', { code: error?.code }))
    return c.json({ success: true, data: await mensajeActual(db, restauranteId, id, mid) })
  })

  return route
}

async function buscarMensaje(db: Db, restauranteId: number, tandaId: number, mid: number) {
  const [m] = await db.select().from(MensajeTable).where(and(
    eq(MensajeTable.restauranteId, restauranteId), eq(MensajeTable.tandaId, tandaId), eq(MensajeTable.id, mid),
  )).limit(1)
  return m ?? null
}

async function mensajeActual(db: Db, restauranteId: number, tandaId: number, mid: number) {
  const m = await buscarMensaje(db, restauranteId, tandaId, mid)
  if (!m) return null
  const [tanda] = await db.select({ canal: TandaTable.canal }).from(TandaTable)
    .where(and(eq(TandaTable.restauranteId, restauranteId), eq(TandaTable.id, tandaId))).limit(1)
  return aMensajeApi(m, tanda?.canal ?? 'manual')
}

/** El beneficio corre desde que el mensaje sale, no desde que se armó la tanda. */
async function arrancarBeneficio(db: Db, restauranteId: number, m: typeof MensajeTable.$inferSelect, desde: Date) {
  if (!m.vigenciaHoras) return
  const fin = new Date(desde.getTime() + m.vigenciaHoras * MS_HORA)
  if (m.codigoDescuentoId) {
    await db.update(CodigoDescuentoTable).set({ fechaFin: fin, activo: true })
      .where(and(eq(CodigoDescuentoTable.restauranteId, restauranteId), eq(CodigoDescuentoTable.id, m.codigoDescuentoId)))
  }
  if (m.enlaceId) {
    await db.update(MarketingEnlaceTable).set({ expiraAt: fin, activo: true, updatedAt: new Date() })
      .where(and(eq(MarketingEnlaceTable.restauranteId, restauranteId), eq(MarketingEnlaceTable.id, m.enlaceId)))
  }
}

/** Descartar apaga el cupón y el link; deshacer o volver a la lista los prende de nuevo. */
async function activarBeneficio(db: Db, restauranteId: number, m: typeof MensajeTable.$inferSelect, activo: boolean) {
  if (m.codigoDescuentoId) {
    await db.update(CodigoDescuentoTable).set({ activo })
      .where(and(eq(CodigoDescuentoTable.restauranteId, restauranteId), eq(CodigoDescuentoTable.id, m.codigoDescuentoId)))
  }
  if (m.enlaceId) {
    await db.update(MarketingEnlaceTable).set({ activo, updatedAt: new Date() })
      .where(and(eq(MarketingEnlaceTable.restauranteId, restauranteId), eq(MarketingEnlaceTable.id, m.enlaceId)))
  }
}

async function leerTanda(db: Db, restauranteId: number, tandaId: number) {
  const [tanda] = await db.select().from(TandaTable)
    .where(and(eq(TandaTable.restauranteId, restauranteId), eq(TandaTable.id, tandaId))).limit(1)
  if (!tanda) return null
  const mensajes = await db.select().from(MensajeTable)
    .where(and(eq(MensajeTable.restauranteId, restauranteId), eq(MensajeTable.tandaId, tandaId)))
    .orderBy(MensajeTable.orden)
  const vueltas = await resultados(db, restauranteId, mensajes)
  return {
    id: tanda.id,
    canal: tanda.canal,
    createdAt: new Date(tanda.createdAt).toISOString(),
    cantidadPedida: tanda.cantidadPedida,
    presupuesto: numero(tanda.presupuesto),
    presupuestoAsignado: numero(tanda.presupuestoAsignado),
    conPuntos: tanda.conPuntos,
    mensajes: mensajes.map((m) => aMensajeApi(m, tanda.canal, vueltas.get(m.id))),
  }
}

export const recompraTandasRoute = crearRecompraTandasRoute()
