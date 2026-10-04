import { and, eq, gte, inArray, lte, notInArray } from 'drizzle-orm'
import {
  pedidoUnificado,
  horarioRestaurante,
  franjaHorarioPedido,
  colaRecompra,
  campanaRecompra,
  producto,
  itemPedidoUnificado,
} from '../db/schema'
import { calcularDiasFlojos, diaOperativo } from './dias-flojos'
import { cargarCohorteRecompra } from './recupero'
import type { MySql2Database } from 'drizzle-orm/mysql2'

export async function cargarDiasAbiertos(
  db: MySql2Database<any>,
  restauranteId: number,
) {
  const horarios = await db
    .select({ dia: horarioRestaurante.diaSemana })
    .from(horarioRestaurante)
    .where(eq(horarioRestaurante.restauranteId, restauranteId))
  return horarios.length
    ? Array.from(new Set(horarios.map((h) => h.dia)))
    : [0, 1, 2, 3, 4, 5, 6]
}

export async function obtenerDiasFlojos(
  db: MySql2Database<any>,
  restauranteId: number,
  semanas = 8,
  dia?: number,
  franjaId?: string,
) {
  const ahora = Date.now()
  const [pedidos, franjas, diasAbiertos] = await Promise.all([
    db
      .select({
        id: pedidoUnificado.id,
        clienteId: pedidoUnificado.clienteId,
        createdAt: pedidoUnificado.createdAt,
        total: pedidoUnificado.total,
        pagado: pedidoUnificado.pagado,
        estado: pedidoUnificado.estado,
      })
      .from(pedidoUnificado)
      .where(
        and(
          eq(pedidoUnificado.restauranteId, restauranteId),
          gte(
            pedidoUnificado.createdAt,
            new Date(ahora - (semanas * 7 + 2) * 86400000),
          ),
          lte(pedidoUnificado.createdAt, new Date(ahora)),
          notInArray(pedidoUnificado.estado, ['cancelled']),
        ),
      ),
    db
      .select()
      .from(franjaHorarioPedido)
      .where(
        and(
          eq(franjaHorarioPedido.restauranteId, restauranteId),
          eq(franjaHorarioPedido.activo, true),
        ),
      ),
    cargarDiasAbiertos(db, restauranteId),
  ])
  const analisis = calcularDiasFlojos(pedidos, {
    semanas,
    ahora,
    diasAbiertos,
    franjas: franjas.map((f) => ({
      id: String(f.id),
      nombre: f.nombre,
      horaInicio: f.horaInicio,
      horaFin: f.horaFin,
    })),
  })
  if (dia === undefined) return analisis
  const franja = analisis.franjas.find((f) => f.id === franjaId)
  const [cohorte, comprometidos, favoritos] = await Promise.all([
    cargarCohorteRecompra(db, restauranteId, { incluirProtegidos: true }),
    db
      .select({ clienteId: colaRecompra.clienteId })
      .from(colaRecompra)
      .innerJoin(
        campanaRecompra,
        eq(campanaRecompra.id, colaRecompra.campanaId),
      )
      .where(
        and(
          eq(colaRecompra.restauranteId, restauranteId),
          eq(campanaRecompra.restauranteId, restauranteId),
          inArray(campanaRecompra.estado, [
            'activa',
            'pausada_manual',
            'pausada_sin_saldo',
          ]),
          inArray(colaRecompra.estado, ['pendiente', 'enviado', 'control']),
        ),
      ),
    db
      .select({
        clienteId: pedidoUnificado.clienteId,
        nombre: producto.nombre,
        cantidad: itemPedidoUnificado.cantidad,
      })
      .from(pedidoUnificado)
      .innerJoin(
        itemPedidoUnificado,
        eq(itemPedidoUnificado.pedidoId, pedidoUnificado.id),
      )
      .innerJoin(
        producto,
        and(
          eq(producto.id, itemPedidoUnificado.productoId),
          eq(producto.restauranteId, restauranteId),
        ),
      )
      .where(
        and(
          eq(pedidoUnificado.restauranteId, restauranteId),
          notInArray(pedidoUnificado.estado, ['cancelled']),
        ),
      ),
  ])
  const enTanda = new Set(comprometidos.map((c) => c.clienteId))
  const productos = new Map<number, Map<string, number>>()
  for (const f of favoritos) {
    if (f.clienteId === null) continue
    const porNombre = productos.get(f.clienteId) ?? new Map<string, number>()
    porNombre.set(f.nombre, (porNombre.get(f.nombre) ?? 0) + f.cantidad)
    productos.set(f.clienteId, porNombre)
  }
  const pesos: Record<string, number> = {
    primer_pedido: 4,
    en_riesgo: 3,
    dormido: 2,
    perdido: 1,
  }
  const candidatos = cohorte
    .filter((c) => c.diasDesdeUltimo === null || c.diasDesdeUltimo >= 7)
    .map((c) => {
      const pedidosDia = c.fechasPedidosMs.filter(
        (f) => diaOperativo(f).diaSemana === dia,
      ).length
      const horas = c.fechasPedidosMs.map((f) => diaOperativo(f).hora)
      const horaHabitual =
        Array.from(new Set(horas)).sort(
          (a, b) =>
            horas.filter((h) => h === b).length -
            horas.filter((h) => h === a).length,
        )[0] ?? 20
      const fechas = [...c.fechasPedidosMs].sort((a, b) => a - b)
      const intervalos = fechas
        .slice(1)
        .map((f, i) => (f - fechas[i]) / 86400000)
        .sort((a, b) => a - b)
      const yaEnTanda = enTanda.has(c.clienteId)
      const motivoBloqueo = c.optOut
        ? 'Pidió no recibir mensajes'
        : c.topeAlcanzado
          ? 'Llegó al máximo de 4 contactos en 30 días'
          : c.cooldownHasta
            ? 'Todavía no pasaron 48 horas desde el último contacto'
            : yaEnTanda
              ? 'Ya está en una tanda en curso'
              : c.toquesDesdeUltimoPedido >= 3
                ? 'Ya recibió los 3 mensajes; esperá su próximo pedido'
                : null
      return {
        ...c,
        pedidosDia,
        ticketPromedio: c.totalGastado / (c.cantidadPedidos || 1),
        cadencia: intervalos.length
          ? intervalos[Math.floor(intervalos.length / 2)]
          : null,
        productoFavorito:
          Array.from(productos.get(c.clienteId)?.entries() ?? []).sort(
            (a, b) => b[1] - a[1],
          )[0]?.[0] ?? null,
        horaHabitual,
        yaEnTanda,
        elegible: !motivoBloqueo && diasAbiertos.includes(dia),
        motivo:
          motivoBloqueo ??
          (pedidosDia
            ? `Pidió ${pedidosDia} ${pedidosDia === 1 ? 'vez' : 'veces'} un ${analisis.dias[dia].nombre.toLowerCase()}`
            : 'Puede volver a pedir; hace más de 7 días que no compra'),
      }
    })
    .sort(
      (a, b) =>
        Number(b.pedidosDia > 0) - Number(a.pedidosDia > 0) ||
        pesos[b.segmento] - pesos[a.segmento] ||
        b.totalGastado - a.totalGastado ||
        (franja
          ? Math.abs(a.horaHabitual - Number(franja.horaInicio.slice(0, 2))) -
            Math.abs(b.horaHabitual - Number(franja.horaInicio.slice(0, 2)))
          : 0) ||
        a.clienteId - b.clienteId,
    )
  return { ...analisis, candidatos }
}

export async function diasValleDelLocal(
  db: MySql2Database<any>,
  restauranteId: number,
) {
  const analisis = await obtenerDiasFlojos(db, restauranteId)
  if (analisis.semanasConPedidos < 4) return [1, 2, 3]
  const abiertos = analisis.dias
    .filter((d) => d.abierto)
    .sort((a, b) => a.pedidosPromedio - b.pedidosPromedio)
  return abiertos.slice(0, 3).map((d) => d.diaSemana)
}
