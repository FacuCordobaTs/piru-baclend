// src/lib/recompra-tandas.ts
//
// Recompra por tandas. El dueño no entra todos los días: entra cuando quiere empujar ventas, dice a
// cuántos clientes escribirles y cuánto invertir en beneficios, y este módulo arma la tanda:
//
//   1. quiénes: de toda la base, los que más vale la pena contactar AHORA (valor × momento);
//   2. qué beneficio: reparte el presupuesto con rendimientos decrecientes, sin gastarlo todo en uno
//      ni dividirlo parejo. Cada peso va donde más mueve la aguja (un perdido de ticket alto antes
//      que un VIP que vuelve solo). Con el club de puntos activo, los beneficios son puntos;
//   3. qué decirle: un mensaje armado con su historia (día habitual, favorito, cadencia, lo que
//      pidió la última vez) combinando muchas piezas para que dos clientes no reciban lo mismo;
//   4. por qué: frases cortas que el dueño entiende sin conocer el modelo.
//
// Es puro: sin DB, sin Hono, sin WhatsApp. La ruta (routes/recompra-tandas.ts) carga los datos,
// crea cupones, links y tokens con lo que devuelve, y persiste la tanda.

import { computarPerfilesRFM, type SegmentoCliente } from './clientes-rfm'
import {
  compraMinimaParaPuntos,
  evaluarSaldoParaRecordatorio,
  maximoPuntosParaCompra,
  valorPuntoEnPesos,
  type ConfigIncentivosPuntos,
} from './puntos-incentivos'

const MS_DIA = 24 * 60 * 60 * 1000
/** Un cliente al que se le escribió (tanda, recompra o campaña) no entra en otra tanda por estos días. */
export const DIAS_DESCANSO_TANDA = 5
export const TANDA_MAXIMO = 60
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const DIAS_PLURAL = ['domingos', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados']

// ─── Entrada ────────────────────────────────────────────────────────────────

export interface ItemPedidoTanda {
  productoId: number
  cantidad: number
  varianteId?: number | null
  varianteSecundariaId?: number | null
  agregadoIds?: number[]
}

export interface PedidoTanda {
  fecha: number
  total: number
  delivery: boolean
  items: ItemPedidoTanda[]
  /** Sucursal donde se hizo el pedido; null (o ausente) = el local, sin sucursal. */
  sucursalId?: number | null
}

/**
 * A qué pedidos mira una tanda. Con sucursales, cada número es un punto de envío distinto y la
 * tanda se arma sólo con los clientes que pidieron ahí: `sucursal` es una sede puntual, `local`
 * los pedidos sin sucursal y `todo` la base completa (local sin sucursales o respaldo).
 */
export type AlcanceTanda = 'todo' | 'local' | 'sucursal'

export interface PuntoTanda {
  alcance: AlcanceTanda
  sucursalId: number | null
}

export interface ClienteTanda {
  id: number
  nombre: string
  /** Listo para wa.me (sólo dígitos) o null si no sirve. */
  telefono: string | null
  optOut: boolean
  puntos: number
  pedidos: PedidoTanda[]
  /** Último contacto de marketing (tanda, recompra o campaña), en ms. */
  ultimoContacto: number | null
}

export interface ProductoTanda {
  id: number
  nombre: string
  precio: number
  imagenUrl: string | null
  puntosGanados: number
  tieneVariantes: boolean
  activo: boolean
}

export interface LocalTanda {
  nombre: string
  deliveryEnabled: boolean
  deliveryFee: number
  /** Configuración del club si está activo; con ella los beneficios son puntos. */
  puntos: ConfigIncentivosPuntos | null
}

// ─── Perfil ─────────────────────────────────────────────────────────────────

export type Angulo =
  | 'segunda'
  | 'su_dia'
  | 'a_tiempo'
  | 'lo_de_siempre'
  | 'vip'
  | 'extranamos'
  | 'novedad'
  | 'puntos'

export interface PerfilTanda {
  cliente: ClienteTanda
  segmento: SegmentoCliente
  esVip: boolean
  pedidos: number
  totalGastado: number
  ticket: number
  cadencia: number | null
  diasDesdeUltimo: number
  /** Día de la semana en que más pide (0 = domingo), si es un hábito (≥ 35 % y ≥ 3 pedidos). */
  diaHabitual: { dia: number; veces: number } | null
  favorito: { producto: ProductoTanda; veces: number } | null
  /** La línea más reciente del favorito, con sus opciones, para armar el link. */
  favoritoItem: ItemPedidoTanda | null
  ultimoCarrito: ItemPedidoTanda[]
  /** El último pedido se repite (mismo conjunto de productos que el anterior o el favorito en la mitad). */
  repite: boolean
  sugerido: ProductoTanda | null
  delivery: boolean
  momento: number
  puntaje: number
}

const diaAR = (ms: number) => new Date(ms - 3 * 60 * 60 * 1000).getUTCDay()

/** Los pedidos del cliente que caen en el punto; `todo` no filtra. */
function pedidosDelPunto(pedidos: PedidoTanda[], punto?: PuntoTanda): PedidoTanda[] {
  if (!punto || punto.alcance === 'todo') return pedidos
  const sucursalId = punto.alcance === 'sucursal' ? punto.sucursalId : null
  return pedidos.filter((p) => (p.sucursalId ?? null) === sucursalId)
}

function perfilar(
  clientes: ClienteTanda[],
  productos: Map<number, ProductoTanda>,
  populares: ProductoTanda[],
  ahora: number,
  punto?: PuntoTanda,
): PerfilTanda[] {
  // Con un punto elegido, el perfil se arma con los pedidos de ese punto: el mensaje habla de esa
  // sucursal y no de otra. Sin punto (o con `todo`) mira la base completa, como siempre.
  const conjuntos = clientes
    .map((cliente) => ({ cliente, pedidos: pedidosDelPunto(cliente.pedidos, punto) }))
    .filter(({ pedidos }) => !punto || punto.alcance === 'todo' || pedidos.length > 0)
  const rfm = computarPerfilesRFM(conjuntos.map(({ pedidos }) => ({
    cantidadPedidos: pedidos.length,
    totalGastado: pedidos.reduce((s, p) => s + p.total, 0),
    fechasPedidos: pedidos.map((p) => p.fecha),
  })), ahora)
  const hoy = diaAR(ahora)
  return conjuntos.map(({ cliente, pedidos: delPunto }, i) => {
    const perfil = rfm[i]
    const pedidos = [...delPunto].sort((a, b) => b.fecha - a.fecha)
    const total = pedidos.reduce((s, p) => s + p.total, 0)

    const porDia = new Array(7).fill(0)
    for (const p of pedidos) porDia[diaAR(p.fecha)]++
    const mejorDia = porDia.indexOf(Math.max(...porDia))
    const diaHabitual = pedidos.length >= 3 && porDia[mejorDia] / pedidos.length >= 0.35
      ? { dia: mejorDia, veces: porDia[mejorDia] }
      : null

    const conteo = new Map<number, number>()
    for (const p of pedidos) for (const it of p.items) {
      if (productos.get(it.productoId)?.activo) conteo.set(it.productoId, (conteo.get(it.productoId) ?? 0) + Math.max(1, it.cantidad))
    }
    const [favId, veces] = [...conteo.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0]
    const favorito = favId != null ? { producto: productos.get(favId)!, veces } : null
    const favoritoItem = favId != null
      ? pedidos.flatMap((p) => p.items).find((it) => it.productoId === favId) ?? null
      : null
    const ultimoCarrito = (pedidos[0]?.items ?? []).filter((it) => productos.get(it.productoId)?.activo)
    const firma = (p?: PedidoTanda) => [...new Set(p?.items.map((it) => it.productoId))].sort().join(',')
    const repite = ultimoCarrito.length > 0 && (
      (pedidos.length >= 2 && firma(pedidos[0]) === firma(pedidos[1])) ||
      (favId != null && pedidos.filter((p) => p.items.some((it) => it.productoId === favId)).length / pedidos.length >= 0.5 && pedidos.length >= 2)
    )
    const probados = new Set(pedidos.flatMap((p) => p.items.map((it) => it.productoId)))
    const sugerido = populares.find((p) => !probados.has(p.id)) ?? null
    const delivery = pedidos.length > 0 && pedidos.filter((p) => p.delivery).length / pedidos.length >= 0.5

    const dias = perfil.diasDesdeUltimo ?? 0
    // Aunque en este punto haga tiempo que no pide, si pidió en otro punto hace menos de dos días
    // no se le escribe: sería un mensaje cruzado de dos números de la misma marca.
    const pidioEnOtro = !!punto && punto.alcance !== 'todo'
      && cliente.pedidos.some((p) => !delPunto.includes(p) && ahora - p.fecha < 2 * MS_DIA)
    const momento = pidioEnOtro ? 0 : calcularMomento(perfil.segmento, dias, perfil.cadenciaDias)
    const ticket = pedidos.length ? total / pedidos.length : 0
    const frecuencia = 1 + Math.min(pedidos.length, 12) / 12
    const boostDia = diaHabitual?.dia === hoy ? 1.25 : 1
    const puntaje = ticket * frecuencia * momento * boostDia * (perfil.esVip ? 1.2 : 1)

    return {
      cliente,
      segmento: perfil.segmento,
      esVip: perfil.esVip,
      pedidos: pedidos.length,
      totalGastado: total,
      ticket,
      cadencia: perfil.cadenciaDias,
      diasDesdeUltimo: dias,
      diaHabitual,
      favorito,
      favoritoItem,
      ultimoCarrito,
      repite,
      sugerido,
      delivery,
      momento,
      puntaje,
    }
  })
}

/** Qué tan buen momento es hoy para escribirle (0..1). 0 = todavía no. */
function calcularMomento(segmento: SegmentoCliente, dias: number, cadencia: number | null): number {
  if (dias < 2) return 0
  if (segmento === 'nuevo') return dias < 4 ? 0 : dias <= 21 ? 1 : dias <= 60 ? 0.7 : 0.4
  const ratio = dias / Math.max(1, cadencia ?? 21)
  if (ratio < 0.7) return 0
  if (ratio < 1.5) return 1
  if (ratio < 3) return 0.95
  if (ratio < 6) return 0.65
  return 0.35
}

export interface Elegibles {
  perfiles: PerfilTanda[]
  /** Los que están en su momento (momento ≥ 0,9): base de la cantidad recomendada. */
  enSuMomento: number
}

/** Los clientes a los que tiene sentido escribirles hoy, del más al menos conveniente. */
export function elegibles(
  clientes: ClienteTanda[],
  productos: Map<number, ProductoTanda>,
  populares: ProductoTanda[],
  ahora: number = Date.now(),
  punto?: PuntoTanda,
): Elegibles {
  const perfiles = perfilar(clientes, productos, populares, ahora, punto)
    .filter((p) => p.cliente.telefono && !p.cliente.optOut && p.pedidos > 0 && p.momento > 0)
    .filter((p) => p.cliente.ultimoContacto == null || ahora - p.cliente.ultimoContacto >= DIAS_DESCANSO_TANDA * MS_DIA)
    .sort((a, b) => b.puntaje - a.puntaje)
  return { perfiles, enSuMomento: perfiles.filter((p) => p.momento >= 0.9).length }
}

export interface Preparacion {
  elegibles: number
  recomendado: number
  maximo: number
  presupuestoSugerido: number
  ticketPromedio: number
}

const redondear = (n: number, paso: number) => Math.max(0, Math.round(n / paso) * paso)

/** Cuántos contactar y cuánto invertir, como sugerencia: el dueño decide. */
export function preparar(e: Elegibles): Preparacion {
  const total = e.perfiles.length
  const maximo = Math.min(total, TANDA_MAXIMO)
  const recomendado = Math.min(maximo, Math.max(Math.min(5, maximo), Math.min(25, e.enSuMomento)))
  const top = e.perfiles.slice(0, recomendado)
  const ticketPromedio = top.length ? top.reduce((s, p) => s + p.ticket, 0) / top.length : 0
  return {
    elegibles: total,
    recomendado,
    maximo,
    presupuestoSugerido: redondear(recomendado * ticketPromedio * 0.07, 500),
    ticketPromedio: Math.round(ticketPromedio),
  }
}

// ─── Beneficios ─────────────────────────────────────────────────────────────

export type Beneficio =
  | { tipo: 'ninguno'; costo: 0 }
  | { tipo: 'porcentaje'; valor: number; horas: number; costo: number }
  | { tipo: 'monto_fijo'; valor: number; minimo: number; horas: number; costo: number }
  | { tipo: 'envio_gratis'; horas: number; costo: number }
  | { tipo: 'puntos'; puntos: number; minimo: number; horas: number; costo: number }

const NINGUNO: Beneficio = { tipo: 'ninguno', costo: 0 }

/** Cuánto le hace falta un empujón para volver. Un activo vuelve solo; un perdido, no. */
const NECESIDAD: Record<SegmentoCliente, number> = {
  nuevo: 0.6, activo: 0.15, vip: 0.1, en_riesgo: 0.6, dormido: 0.9, perdido: 1,
}
/** Retorno mínimo esperado por peso invertido: debajo de esto el beneficio no se justifica. */
const RETORNO_MINIMO = 1.5

function opciones(p: PerfilTanda, local: LocalTanda): Beneficio[] {
  const t = p.ticket
  if (t <= 0) return [NINGUNO]
  if (local.puntos) {
    const config = local.puntos
    const valor = valorPuntoEnPesos(config)
    const tope = maximoPuntosParaCompra(config, t * 1.3)
    const lista: Beneficio[] = [NINGUNO]
    for (let pts = 100; pts <= tope; pts += 100) {
      const minimo = compraMinimaParaPuntos(config, pts)
      if (minimo > t * 1.3) break
      lista.push({ tipo: 'puntos', puntos: pts, minimo: redondear(minimo, 500), horas: pts >= 400 ? 48 : 72, costo: Math.round(pts * valor) })
    }
    return lista
  }
  const lista: Beneficio[] = [NINGUNO]
  if (local.deliveryEnabled && local.deliveryFee > 0 && p.delivery) {
    lista.push({ tipo: 'envio_gratis', horas: 72, costo: Math.round(local.deliveryFee) })
  }
  const fuerte = p.segmento === 'dormido' || p.segmento === 'perdido' || (p.esVip && p.segmento === 'en_riesgo')
  for (const pct of fuerte ? [10, 15, 20] : [10, 15]) {
    lista.push({ tipo: 'porcentaje', valor: pct, horas: pct >= 20 ? 24 : pct >= 15 ? 48 : 72, costo: Math.round(t * pct / 100) })
  }
  const minimo = redondear(t * 0.9, 500)
  for (const factor of [0.12, 0.2]) {
    const valor = redondear(t * factor, 500)
    if (valor >= 500 && minimo > valor * 2) lista.push({ tipo: 'monto_fijo', valor, minimo, horas: 72, costo: valor })
  }
  return lista.sort((a, b) => a.costo - b.costo)
}

const FACTOR: Record<Beneficio['tipo'], number> = {
  ninguno: 0, porcentaje: 1, monto_fijo: 1.05, envio_gratis: 1.2, puntos: 0.85,
}

function ganancia(p: PerfilTanda, b: Beneficio): number {
  if (b.tipo === 'ninguno' || p.ticket <= 0) return 0
  const fuerza = b.costo / p.ticket
  return p.ticket * NECESIDAD[p.segmento] * (1 - Math.exp(-fuerza / 0.08)) * FACTOR[b.tipo]
}

export type MotivoSinBeneficio = 'sin_presupuesto' | 'no_lo_necesita' | 'presupuesto_agotado'

export interface Asignacion {
  beneficio: Beneficio
  sinBeneficio: MotivoSinBeneficio | null
}

/**
 * Reparte el presupuesto con rendimientos decrecientes: en cada paso compra la mejora (de un
 * cliente a un beneficio más fuerte) que más retorno esperado da por peso, mientras entre en el
 * presupuesto, no se lleve más que su parte razonable y rinda al menos `RETORNO_MINIMO`.
 */
export function asignarBeneficios(perfiles: PerfilTanda[], local: LocalTanda, presupuesto: number): Asignacion[] {
  const n = perfiles.length
  if (presupuesto <= 0) return perfiles.map(() => ({ beneficio: NINGUNO, sinBeneficio: 'sin_presupuesto' }))
  const tope = n === 1 ? presupuesto : Math.max(presupuesto * 0.3, (presupuesto / n) * 2.5)
  const ops = perfiles.map((p) => opciones(p, local))
  const elegido = perfiles.map(() => 0)
  let gastado = 0
  let bloqueadoPorPresupuesto = new Set<number>()
  for (;;) {
    let mejor: { i: number; j: number; ratio: number } | null = null
    bloqueadoPorPresupuesto = new Set()
    for (let i = 0; i < n; i++) {
      const actual = ops[i][elegido[i]]
      for (let j = elegido[i] + 1; j < ops[i].length; j++) {
        const op = ops[i][j]
        const delta = op.costo - actual.costo
        if (delta <= 0 || op.costo > tope) continue
        const ratio = (ganancia(perfiles[i], op) - ganancia(perfiles[i], actual)) / delta
        if (ratio < RETORNO_MINIMO) continue
        if (gastado + delta > presupuesto) { bloqueadoPorPresupuesto.add(i); continue }
        if (!mejor || ratio > mejor.ratio) mejor = { i, j, ratio }
      }
    }
    if (!mejor) break
    gastado += ops[mejor.i][mejor.j].costo - ops[mejor.i][elegido[mejor.i]].costo
    elegido[mejor.i] = mejor.j
  }
  return perfiles.map((_, i) => {
    const beneficio = ops[i][elegido[i]]
    return {
      beneficio,
      sinBeneficio: beneficio.tipo !== 'ninguno' ? null : bloqueadoPorPresupuesto.has(i) ? 'presupuesto_agotado' : 'no_lo_necesita',
    }
  })
}

// ─── Mensajes ───────────────────────────────────────────────────────────────

/** Generador determinístico: la misma tanda se arma igual, pero cada cliente cae en otra mezcla. */
function rng(semilla: number) {
  let a = semilla >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Elige entre variantes la menos usada en la tanda (desempata al azar): evita mensajes repetidos. */
class Variedad {
  private usos = new Map<string, number>()
  constructor(private azar: () => number) {}
  elegir<T>(clave: string, opciones: T[]): T {
    const conteos = opciones.map((_, i) => this.usos.get(`${clave}:${i}`) ?? 0)
    const min = Math.min(...conteos)
    const candidatos = opciones.map((_, i) => i).filter((i) => conteos[i] === min)
    const i = candidatos[Math.floor(this.azar() * candidatos.length)]
    this.usos.set(`${clave}:${i}`, min + 1)
    return opciones[i]
  }
  cuenta(clave: string) {
    return this.usos.get(clave) ?? 0
  }
  sumar(clave: string) {
    this.usos.set(clave, this.cuenta(clave) + 1)
  }
}

export const pesos = (n: number) => {
  try {
    return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n)
  } catch {
    return `$${Math.round(n)}`
  }
}

export function primerNombre(nombre: string): string {
  const palabra = nombre.trim().split(/\s+/)[0] ?? ''
  if (!palabra) return ''
  return palabra.charAt(0).toLocaleUpperCase('es-AR') + palabra.slice(1).toLocaleLowerCase('es-AR')
}

export function tiempo(dias: number): string {
  if (dias < 10) return `${dias} días`
  if (dias < 14) return 'más de una semana'
  if (dias < 28) return `${Math.round(dias / 7)} semanas`
  if (dias < 45) return 'un mes'
  if (dias < 180) return `${Math.round(dias / 30)} meses`
  if (dias < 330) return 'más de medio año'
  return 'más de un año'
}

export function vigencia(horas: number): string {
  if (horas <= 24) return '24 hs'
  if (horas <= 48) return '48 hs'
  if (horas < 168) return `${Math.round(horas / 24)} días`
  return 'una semana'
}

function textoCarrito(items: ItemPedidoTanda[], productos: Map<number, ProductoTanda>): string {
  const partes = items.slice(0, 3).map((it) => {
    const nombre = productos.get(it.productoId)?.nombre ?? ''
    return it.cantidad > 1 ? `${it.cantidad} ${nombre}` : nombre
  }).filter(Boolean)
  const resto = items.length - 3
  return partes.join(' + ') + (resto > 0 ? ` y ${resto} más` : '')
}

interface Contexto {
  nombre: string
  local: string
  producto: string
  dia: string
  diaPlural: string
  dias: number
  tiempo: string
  carrito: string
  pedidos: number
  sugerido: string
  saldo: number
}

const cap = (s: string) => s.charAt(0).toLocaleUpperCase('es-AR') + s.slice(1)

const GANCHOS: Record<Angulo, ((c: Contexto) => string)[]> = {
  segunda: [
    (c) => `¿Qué tal estuvo ${c.producto}? Nos encantaría que vuelvas a ${c.local}.`,
    (c) => `Hace ${c.tiempo} hiciste tu primer pedido en ${c.local} y nos quedamos con ganas de que vuelvas.`,
    (c) => `Ya conocés ${c.producto}; la segunda vez siempre sale mejor 😉`,
    (c) => `Gracias por elegirnos la primera vez. ¿Repetimos ${c.producto}?`,
  ],
  su_dia: [
    (c) => `Es ${c.dia} y los ${c.diaPlural} tienen gusto a ${c.producto} 😋`,
    (c) => `${cap(c.dia)} otra vez. ¿Arrancamos con ${c.producto}, como siempre?`,
    (c) => `Los ${c.diaPlural} sos de pedir ${c.producto}, así que hoy pensamos en vos.`,
  ],
  a_tiempo: [
    (c) => `Ya pasaron ${c.dias} días desde tu último ${c.producto}. ¿Se viene otro?`,
    (c) => `Por cómo venís pidiendo, ya te toca ${c.producto} 😉`,
    (c) => `¿Antojo? Sabemos que ${c.producto} no falla.`,
  ],
  lo_de_siempre: [
    (c) => `Te dejamos armado lo de siempre: ${c.carrito}.`,
    (c) => `¿Lo mismo de siempre? ${c.carrito}, listo para confirmar.`,
    (c) => `${c.carrito}: ya lo tenés armado, sólo falta que lo confirmes.`,
  ],
  vip: [
    (c) => `Sos de las personas que más eligen ${c.local} y queríamos agradecértelo.`,
    (c) => `Con ${c.pedidos} pedidos ya sos de la casa. ¿Hoy ${c.producto}?`,
    (c) => `Clientes como vos son los que hacen ${c.local}. ¿Te tentamos con ${c.producto}?`,
  ],
  extranamos: [
    (c) => `Hace ${c.tiempo} que no pasás por ${c.local} y te extrañamos.`,
    (c) => `¡Tanto tiempo! Hace ${c.tiempo} que no pedís ${c.producto}.`,
    (c) => `${cap(c.producto)} sigue igual de rico que la última vez. ¿Volvés?`,
  ],
  novedad: [
    (c) => `¿Ya probaste ${c.sugerido}? Es de lo más pedido en ${c.local}.`,
    (c) => `Esta vez te recomendamos ${c.sugerido}, uno de los favoritos de ${c.local}.`,
    (c) => `Si te gustó ${c.producto}, ${c.sugerido} te va a encantar.`,
  ],
  puntos: [
    (c) => `Tenés ${c.saldo} puntos en el club de ${c.local}.`,
    (c) => `Tus ${c.saldo} puntos en ${c.local} te están esperando.`,
  ],
}

const SALUDOS = ['¡Hola', '¡Buenas', '¡Hola, hola', '¡Qué tal']
const CIERRES = ['Te lo dejamos listo acá 👇', 'Pedilo en dos toques 👇', 'Entrá y pedí cuando quieras 👇', 'Acá tenés tu link 👇']
const CIERRES_CARRITO = ['Tu pedido ya está armado, sólo confirmás 👇', 'Lo armamos por vos, revisalo y listo 👇']

function lineaBeneficio(b: Beneficio, v: Variedad): string | null {
  switch (b.tipo) {
    case 'porcentaje': return v.elegir('b-pct', [
      `Tenés ${b.valor}% off en tu pedido por ${vigencia(b.horas)}.`,
      `Te regalamos ${b.valor}% de descuento, válido por ${vigencia(b.horas)}.`,
      `Sólo para vos: ${b.valor}% off durante ${vigencia(b.horas)}.`,
    ])
    case 'monto_fijo': return v.elegir('b-monto', [
      `Te descontamos ${pesos(b.valor)} en tu pedido desde ${pesos(b.minimo)}, por ${vigencia(b.horas)}.`,
      `Tenés ${pesos(b.valor)} de regalo para pedidos desde ${pesos(b.minimo)} durante ${vigencia(b.horas)}.`,
    ])
    case 'envio_gratis': return v.elegir('b-envio', [
      `El envío va por nuestra cuenta durante ${vigencia(b.horas)}.`,
      `Te regalamos el envío si pedís dentro de ${vigencia(b.horas)}.`,
      `Envío gratis para vos por ${vigencia(b.horas)} 🛵`,
    ])
    case 'puntos': return v.elegir('b-pts', [
      `Pedí dentro de ${vigencia(b.horas)} y sumás ${b.puntos} puntos extra (en pedidos desde ${pesos(b.minimo)}).`,
      `Te regalamos ${b.puntos} puntos extra con tu próximo pedido desde ${pesos(b.minimo)}, válido por ${vigencia(b.horas)}.`,
      `${b.puntos} puntos de regalo si pedís dentro de ${vigencia(b.horas)} (desde ${pesos(b.minimo)}).`,
    ])
    default: return null
  }
}

/** Sin presupuesto pero con club: lo que suma su favorito, o qué tan cerca está de un premio. */
function lineaPuntosSinBonus(p: PerfilTanda, config: ConfigIncentivosPuntos, v: Variedad): string | null {
  const saldo = Math.max(0, Math.trunc(p.cliente.puntos))
  const recordatorio = evaluarSaldoParaRecordatorio(config, saldo)
  if (recordatorio.puedeCanjear && recordatorio.premio) {
    return `Ya te alcanza para canjear ${recordatorio.premio.descripcion}.`
  }
  if (recordatorio.premio && recordatorio.faltan > 0 && recordatorio.convieneRecordar) {
    return `Te faltan sólo ${recordatorio.faltan} puntos para ${recordatorio.premio.descripcion}.`
  }
  const prod = p.favorito?.producto
  if (!prod) return null
  const suma = prod.puntosGanados > 0 ? prod.puntosGanados : Math.floor(prod.precio / Math.max(1, config.pesosPorPunto))
  if (suma <= 0) return null
  return v.elegir('b-suma', [
    `Comprando ${prod.nombre} sumás ${suma} puntos en el club.`,
    `Cada ${prod.nombre} te suma ${suma} puntos para canjear.`,
  ])
}

export interface MensajePlanificado {
  perfil: PerfilTanda
  angulo: Angulo
  beneficio: Beneficio
  beneficioEtiqueta: string | null
  saludo: string
  gancho: string
  linea: string | null
  cierre: string
  /** Lo que el link deja armado. Vacío = la tienda (o el último pedido si el link lo reconstruye). */
  carrito: ItemPedidoTanda[]
  /** Producto que abre el link cuando tiene opciones que elegir. */
  productoDestino: number | null
  imagenUrl: string | null
  motivos: string[]
}

function angulosPosibles(p: PerfilTanda, local: LocalTanda, hoy: number): Angulo[] {
  const lista: Angulo[] = []
  if (local.puntos && p.cliente.puntos >= 50) lista.push('puntos')
  if (p.segmento === 'nuevo') return [...lista, 'segunda', ...(p.sugerido ? ['novedad' as const] : [])]
  if (p.diaHabitual?.dia === hoy && p.favorito) lista.push('su_dia')
  if (p.repite && p.ultimoCarrito.length > 0) lista.push('lo_de_siempre')
  if (p.esVip) lista.push('vip')
  if (p.segmento === 'dormido' || p.segmento === 'perdido') lista.push('extranamos')
  else if (p.favorito) lista.push('a_tiempo')
  if (p.sugerido && p.favorito && p.pedidos >= 3) lista.push('novedad')
  return lista.length ? lista : ['extranamos']
}

export function etiquetaBeneficio(b: Beneficio): string | null {
  switch (b.tipo) {
    case 'porcentaje': return `${b.valor}% off · ${vigencia(b.horas)}`
    case 'monto_fijo': return `${pesos(b.valor)} off · ${vigencia(b.horas)}`
    case 'envio_gratis': return `Envío gratis · ${vigencia(b.horas)}`
    case 'puntos': return `+${b.puntos} puntos · ${vigencia(b.horas)}`
    default: return null
  }
}

function motivosDe(p: PerfilTanda, a: Asignacion, angulo: Angulo, local: LocalTanda): string[] {
  const m: string[] = []
  if (p.segmento === 'nuevo') {
    m.push(`Hizo un solo pedido, hace ${tiempo(p.diasDesdeUltimo)}. El segundo pedido es el que lo vuelve cliente.`)
  } else {
    const estado = p.segmento === 'dormido' ? 'Se está enfriando.' : p.segmento === 'perdido' ? 'Hace mucho que no vuelve.'
      : p.segmento === 'en_riesgo' ? 'Se está atrasando.' : 'Está justo en su momento.'
    m.push(`Pide cada ~${p.cadencia ?? '?'} días y lleva ${p.diasDesdeUltimo} sin pedir. ${estado}`)
  }
  if (p.diaHabitual) m.push(`Los ${DIAS_PLURAL[p.diaHabitual.dia]} son su día (${p.diaHabitual.veces} de ${p.pedidos} pedidos).`)
  if (p.favorito && p.favorito.veces > 1) m.push(`Su favorito: ${p.favorito.producto.nombre} (${p.favorito.veces} veces).`)
  m.push(`${p.esVip ? 'De tus mejores clientes: gastó' : 'Gastó'} ${pesos(p.totalGastado)} en ${p.pedidos} ${p.pedidos === 1 ? 'pedido' : 'pedidos'} (ticket promedio ${pesos(p.ticket)}).`)
  if (angulo === 'novedad' && p.sugerido) m.push(`Le sugerimos ${p.sugerido.nombre}: de lo más pedido y todavía no lo probó.`)

  const b = a.beneficio
  const razon: Record<SegmentoCliente, string> = {
    perdido: 'recuperarlo vale más que el beneficio',
    dormido: 'un empujón fuerte antes de perderlo',
    en_riesgo: 'para que no se enfríe',
    nuevo: 'para asegurar la segunda compra',
    vip: 'un mimo a uno de tus mejores clientes',
    activo: 'para que no se le pase',
  }
  if (b.tipo === 'ninguno') {
    if (a.sinBeneficio === 'sin_presupuesto') {
      m.push(local.puntos ? 'Sin bonus: le recordamos lo que suma en el club.' : 'Va sin beneficio: elegiste no invertir en esta tanda.')
    } else if (a.sinBeneficio === 'presupuesto_agotado') {
      m.push('Va sin beneficio: el presupuesto rindió más en clientes con más riesgo de no volver.')
    } else {
      m.push('Va sin beneficio: pide seguido y suele volver solo; el mensaje alcanza.')
    }
  } else if (b.tipo === 'envio_gratis') {
    m.push(`Envío gratis (${pesos(b.costo)}): casi siempre pide delivery; ${razon[p.segmento]}.`)
  } else if (b.tipo === 'porcentaje') {
    m.push(`${b.valor}% por ${vigencia(b.horas)} (~${pesos(b.costo)} en su ticket): ${razon[p.segmento]}.`)
  } else if (b.tipo === 'monto_fijo') {
    m.push(`${pesos(b.valor)} de regalo desde ${pesos(b.minimo)}: el costo queda acotado; ${razon[p.segmento]}.`)
  } else {
    m.push(`${b.puntos} puntos extra (valen ~${pesos(b.costo)}) pidiendo desde ${pesos(b.minimo)}: premia la vuelta sin regalar margen.`)
  }
  return m
}

/**
 * Arma la tanda: elige los `cantidad` mejores, reparte el presupuesto y compone un mensaje distinto
 * para cada uno. La ruta completa el link de cada mensaje y persiste el resultado.
 */
export function planificarTanda(params: {
  elegibles: PerfilTanda[]
  cantidad: number
  presupuesto: number
  local: LocalTanda
  productos: Map<number, ProductoTanda>
  semilla: number
  ahora?: number
}): MensajePlanificado[] {
  const ahora = params.ahora ?? Date.now()
  const hoy = diaAR(ahora)
  const elegidos = params.elegibles.slice(0, Math.max(0, Math.min(params.cantidad, TANDA_MAXIMO)))
  const asignaciones = asignarBeneficios(elegidos, params.local, params.presupuesto)
  const azar = rng(params.semilla)
  const v = new Variedad(azar)

  return elegidos.map((p, i) => {
    const a = asignaciones[i]
    const posibles = angulosPosibles(p, params.local, hoy)
    // El ángulo menos usado en la tanda entre los que tienen sentido para este cliente.
    const angulo = posibles.slice().sort((x, y) => v.cuenta(`ang:${x}`) - v.cuenta(`ang:${y}`))[0]
    v.sumar(`ang:${angulo}`)

    const fav = p.favorito?.producto ?? null
    const ctx: Contexto = {
      nombre: primerNombre(p.cliente.nombre),
      local: params.local.nombre,
      producto: fav?.nombre ?? 'lo de siempre',
      dia: DIAS[hoy],
      diaPlural: DIAS_PLURAL[hoy],
      dias: p.diasDesdeUltimo,
      tiempo: tiempo(p.diasDesdeUltimo),
      carrito: textoCarrito(p.ultimoCarrito, params.productos),
      pedidos: p.pedidos,
      sugerido: p.sugerido?.nombre ?? '',
      saldo: Math.trunc(p.cliente.puntos),
    }
    const gancho = v.elegir(`g-${angulo}`, GANCHOS[angulo])(ctx)
    let linea = lineaBeneficio(a.beneficio, v)
    if (!linea && params.local.puntos) linea = lineaPuntosSinBonus(p, params.local.puntos, v)

    let carrito: ItemPedidoTanda[] = []
    let productoDestino: number | null = null
    let foco: ProductoTanda | null = fav
    if (angulo === 'lo_de_siempre') {
      carrito = p.ultimoCarrito
    } else if (angulo === 'novedad' && p.sugerido) {
      foco = p.sugerido
      if (p.sugerido.tieneVariantes) productoDestino = p.sugerido.id
      else carrito = [{ productoId: p.sugerido.id, cantidad: 1 }]
    } else if (p.favoritoItem && fav) {
      carrito = [{ ...p.favoritoItem, cantidad: Math.max(1, p.favoritoItem.cantidad) }]
    }

    // La foto acompaña cuando el mensaje habla de un producto, no siempre: así la tanda no se ve
    // como un catálogo y el producto que se muestra es el que se nombra.
    const hablaDeProducto = angulo === 'novedad' || angulo === 'su_dia' || angulo === 'a_tiempo' || angulo === 'extranamos'
    const imagenUrl = foco?.imagenUrl && (angulo === 'novedad' || (hablaDeProducto && azar() < 0.6)) ? foco.imagenUrl : null

    return {
      perfil: p,
      angulo,
      beneficio: a.beneficio,
      beneficioEtiqueta: etiquetaBeneficio(a.beneficio),
      saludo: v.elegir('saludo', SALUDOS),
      gancho,
      linea,
      cierre: carrito.length > 1 ? v.elegir('cierre-carrito', CIERRES_CARRITO) : v.elegir('cierre', CIERRES),
      carrito,
      productoDestino,
      imagenUrl,
      motivos: motivosDe(p, a, angulo, params.local),
    }
  })
}

/**
 * El texto del modo manual (sale del WhatsApp del local, con el link al final) y la parte personal
 * de la plantilla de Meta, que va en una sola línea: Meta rechaza saltos de línea en una variable.
 */
export function componerTextos(m: MensajePlanificado, link: string): { texto: string; textoPlantilla: string } {
  const nombre = primerNombre(m.perfil.cliente.nombre)
  const cuerpo = [m.gancho, m.linea].filter(Boolean).join(' ')
  const texto = `${m.saludo}${nombre ? ` ${nombre}` : ''}! 👋\n\n${cuerpo}\n\n${m.cierre}\n${link}`
  const textoPlantilla = cuerpo.replace(/\s+/g, ' ').trim().slice(0, 900)
  return { texto, textoPlantilla }
}

/** Carrito en el formato durable de los links (`v2:`), sin precios ni nombres. */
export function carritoRep(items: ItemPedidoTanda[]): string | null {
  if (!items.length) return null
  const rep = `v2:${JSON.stringify(items.slice(0, 30).map((it) => ({
    p: it.productoId,
    q: Math.min(99, Math.max(1, Math.trunc(it.cantidad))),
    ...(it.varianteId ? { v: it.varianteId } : {}),
    ...(it.varianteSecundariaId ? { s: it.varianteSecundariaId } : {}),
    a: [...new Set(it.agregadoIds ?? [])],
  })))}`
  return rep.length <= 2000 ? rep : null
}

export interface DatosMensaje {
  pedidos: number
  totalGastado: number
  ticketPromedio: number
  diasDesdeUltimo: number
  cadenciaDias: number | null
  diaHabitual: string | null
  favorito: string | null
  puntos: number | null
  esVip: boolean
}

export function datosDe(p: PerfilTanda, conPuntos: boolean): DatosMensaje {
  return {
    pedidos: p.pedidos,
    totalGastado: Math.round(p.totalGastado),
    ticketPromedio: Math.round(p.ticket),
    diasDesdeUltimo: p.diasDesdeUltimo,
    cadenciaDias: p.cadencia,
    diaHabitual: p.diaHabitual ? DIAS_PLURAL[p.diaHabitual.dia] : null,
    favorito: p.favorito?.producto.nombre ?? null,
    puntos: conPuntos ? Math.trunc(p.cliente.puntos) : null,
    esVip: p.esVip,
  }
}
