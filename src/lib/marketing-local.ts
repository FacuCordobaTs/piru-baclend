import { and, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import {
  restaurante,
  pedidoUnificado,
  colaRecompra,
  campanaRecompra,
  horarioRestaurante,
  suscripcion,
  restauranteModulo,
  modulo,
  configuracionSuscripcion,
} from '../db/schema'
import { calcularDiasFlojos } from './dias-flojos'
import { anclajePublico } from './marketing-enlaces'
import {
  moduloEstaActivoAhora,
  resolverModulosFacturablesDeListado,
} from './modulos'
import {
  crearDateArgentina,
  obtenerComponentesArgentina,
} from './motor-recompra-patron'

type Db = MySql2Database<Record<string, never>>

/** Columnas seguras del local: la tarjeta nunca lee la fila completa de `restaurante`. */
export const columnasLocalMarketing = {
  restauranteId: restaurante.id,
  nombre: restaurante.nombre,
  username: restaurante.username,
  imagenUrl: restaurante.imagenUrl,
  colorPrimario: restaurante.colorPrimario,
  dominioTienda: restaurante.dominioTienda,
  whatsappConectado: sql<number>`(${restaurante.whatsappEnabled} = TRUE AND ${restaurante.whatsappAccessToken} IS NOT NULL)`,
}

export interface LocalMarketing {
  restauranteId: number
  nombre: string | null
  username: string | null
  imagenUrl: string | null
  colorPrimario: string | null
  dominioTienda: string | null
  whatsappConectado: number | boolean
}

/**
 * La tarjeta del local para Marketing del panel: ventas, actividad, módulos, día más flojo y
 * mensajes de hoy. Las ventas salen de una sola consulta de 60 días agregada en JS con hora de
 * Argentina. Cuenta los pedidos de ejemplo de la demo, igual que el resto del panel.
 */
export async function tarjetaDelLocal(
  db: Db,
  local: LocalMarketing,
  ahora = new Date(),
) {
  const ids = [local.restauranteId]
  const comp = obtenerComponentesArgentina(ahora.getTime())
  const desdeHoy = crearDateArgentina(comp.anio, comp.mes, comp.diaMes, 0)
  const hastaHoy = new Date(desdeHoy.getTime() + 86400000)
  const [pedidos, primeros, subs, mods, horarios, mensajes, configuraciones] =
    await Promise.all([
      db
        .select({
          restauranteId: pedidoUnificado.restauranteId,
          createdAt: pedidoUnificado.createdAt,
          pagado: pedidoUnificado.pagado,
          total: pedidoUnificado.total,
          estado: pedidoUnificado.estado,
        })
        .from(pedidoUnificado)
        .where(
          and(
            inArray(pedidoUnificado.restauranteId, ids),
            ne(pedidoUnificado.estado, 'cancelled'),
            gte(
              pedidoUnificado.createdAt,
              new Date(ahora.getTime() - 60 * 86400000),
            ),
          ),
        ),
      db
        .select({
          restauranteId: pedidoUnificado.restauranteId,
          clienteId: pedidoUnificado.clienteId,
          primero: sql<Date>`MIN(${pedidoUnificado.createdAt})`.mapWith(
            pedidoUnificado.createdAt,
          ),
        })
        .from(pedidoUnificado)
        .where(
          and(
            inArray(pedidoUnificado.restauranteId, ids),
            ne(pedidoUnificado.estado, 'cancelled'),
            sql`${pedidoUnificado.clienteId} IS NOT NULL`,
          ),
        )
        .groupBy(pedidoUnificado.restauranteId, pedidoUnificado.clienteId),
      db
        .select({
          restauranteId: suscripcion.restauranteId,
          estado: suscripcion.estado,
          montoMensual: suscripcion.montoTotalMensual,
          precioBase: suscripcion.precioBaseMensual,
          precioMensual: suscripcion.precioMensual,
        })
        .from(suscripcion)
        .where(inArray(suscripcion.restauranteId, ids)),
      db
        .select({
          restauranteId: restauranteModulo.restauranteId,
          codigo: modulo.codigo,
          tipo: modulo.tipo,
          precio: modulo.precioMensual,
          estado: restauranteModulo.estado,
          origen: restauranteModulo.origen,
          precioMensualCongelado: restauranteModulo.precioMensualCongelado,
          vigenteHasta: restauranteModulo.vigenteHasta,
          catalogoActivo: modulo.activo,
        })
        .from(restauranteModulo)
        .innerJoin(modulo, eq(modulo.id, restauranteModulo.moduloId))
        .where(inArray(restauranteModulo.restauranteId, ids)),
      db
        .select({
          restauranteId: horarioRestaurante.restauranteId,
          diaSemana: horarioRestaurante.diaSemana,
        })
        .from(horarioRestaurante)
        .where(inArray(horarioRestaurante.restauranteId, ids)),
      db
        .select({
          restauranteId: colaRecompra.restauranteId,
          cantidad: sql<number>`COUNT(*)`,
        })
        .from(colaRecompra)
        .innerJoin(
          campanaRecompra,
          eq(campanaRecompra.id, colaRecompra.campanaId),
        )
        .where(
          and(
            inArray(colaRecompra.restauranteId, ids),
            eq(colaRecompra.estado, 'pendiente'),
            eq(colaRecompra.rol, 'contactado'),
            eq(campanaRecompra.estado, 'activa'),
            eq(colaRecompra.diaSemana, new Date(desdeHoy.getTime()).getUTCDay()),
            lt(colaRecompra.dueDate, hastaHoy),
          ),
        )
        .groupBy(colaRecompra.restauranteId),
      db
        .select({ precioMensual: configuracionSuscripcion.precioMensual })
        .from(configuracionSuscripcion)
        .where(eq(configuracionSuscripcion.codigo, 'piru'))
        .limit(1),
    ])
  const stats = metricasDelLocal(
    pedidos.filter((p) => p.restauranteId === local.restauranteId),
    ahora,
  )
  const sub = subs.find((s) => s.restauranteId === local.restauranteId)
  const propios = mods.filter(
    (m) => m.restauranteId === local.restauranteId,
  )
  const vigentes = propios.filter(
    (m) =>
      m.catalogoActivo &&
      moduloEstaActivoAhora(
        { ...m, estadoSuscripcion: sub?.estado ?? null },
        ahora,
      ),
  )
  const activo = (codigo: string) =>
    vigentes.some((m) => m.codigo === codigo)
  const facturables = resolverModulosFacturablesDeListado(
    propios.map((m) => ({ ...m, precioMensual: m.precio })),
  )
  const montoMensual = sub
    ? Number(
        configuraciones[0]?.precioMensual ??
          sub.precioBase ??
          sub.precioMensual ??
          0,
      ) + facturables.reduce((total, m) => total + m.montoMensual, 0)
    : 0
  const abiertos = horarios
    .filter((h) => h.restauranteId === local.restauranteId)
    .map((h) => h.diaSemana)
  const dias = Array.from(
    new Set(abiertos.length ? abiertos : [0, 1, 2, 3, 4, 5, 6]),
  )
  const flojo = calcularDiasFlojos(
    pedidos.filter((p) => p.restauranteId === local.restauranteId),
    { semanas: 8, ahora: ahora.getTime(), diasAbiertos: dias },
  ).flojos.find((f) => f.franja === null)
  const anclaje = anclajePublico(local)
  return {
    restauranteId: local.restauranteId,
    nombre: local.nombre || `Local ${local.restauranteId}`,
    username: local.username,
    imagenUrl: local.imagenUrl,
    colorPrimario: local.colorPrimario,
    baseTienda: anclaje
      ? `${anclaje.base}${anclaje.prefijo}`.replace(/\/$/, '')
      : null,
    whatsappConectado: Boolean(local.whatsappConectado),
    recompraActiva: activo('motor_recompra'),
    diasFlojosActivo: activo('dias_flojos'),
    puntosActivo: activo('puntos_clientes'),
    crecimientoActivo: activo('crecimiento'),
    codigosDescuentoActivo: activo('codigos_descuento'),
    suscripcion: sub ? { estado: sub.estado, montoMensual } : null,
    ventas30d: stats.ventas30d,
    ventas30dAnterior: stats.ventas30dAnterior,
    pedidos30d: stats.pedidos30d,
    ventasSemanales: stats.ventasSemanales,
    clientesNuevos30d: primeros.filter(
      (p) =>
        p.restauranteId === local.restauranteId &&
        new Date(p.primero).getTime() >= ahora.getTime() - 30 * 86400000,
    ).length,
    diaMasFlojo: flojo
      ? { diaSemana: flojo.diaSemana, nombre: flojo.nombre }
      : null,
    mensajesParaHoy: Number(
      mensajes.find((m) => m.restauranteId === local.restauranteId)
        ?.cantidad ?? 0,
    ),
  }
}

export interface PedidoDelLocal {
  restauranteId: number
  createdAt: Date
  total: string | number
  pagado: boolean
}
/** Un solo conjunto de pedidos de 60 días produce ventas, actividad y sparkline en ART. */
export function metricasDelLocal(pedidos: PedidoDelLocal[], ahora = new Date()) {
  const diaMs = 86400000
  const limite30 = ahora.getTime() - 30 * diaMs
  const limite60 = ahora.getTime() - 60 * diaMs
  const semanas = new Array<number>(8).fill(0)
  let ventas30d = 0,
    ventas30dAnterior = 0,
    pedidos30d = 0
  const dias = new Array<number>(7).fill(0)
  const semanasConPedidos = new Set<number>()
  const compHoy = obtenerComponentesArgentina(ahora.getTime())
  const lunesActual = Date.UTC(
    compHoy.anio,
    compHoy.mes,
    compHoy.diaMes - ((compHoy.diaSemana + 6) % 7),
    3,
  )
  for (const pedido of pedidos) {
    const fecha = pedido.createdAt.getTime()
    if (fecha < limite60 || fecha > ahora.getTime()) continue
    if (fecha >= limite30) {
      pedidos30d++
      if (pedido.pagado) ventas30d += Number(pedido.total)
    } else if (pedido.pagado) ventas30dAnterior += Number(pedido.total)
    const comp = obtenerComponentesArgentina(fecha)
    const dia = comp.hora < 6 ? (comp.diaSemana + 6) % 7 : comp.diaSemana
    dias[dia]++
    const indice = 7 + Math.floor((fecha - lunesActual) / (7 * diaMs))
    if (indice >= 0 && indice < 8) {
      semanasConPedidos.add(indice)
      if (pedido.pagado) semanas[indice] += Number(pedido.total)
    }
  }
  return {
    ventas30d,
    ventas30dAnterior,
    pedidos30d,
    ventasSemanales: semanas,
    conteosDia: dias,
    semanasConPedidos: semanasConPedidos.size,
  }
}
