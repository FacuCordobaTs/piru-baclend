/**
 * Datos de ejemplo de la demo de prospección. Ver docs/AUTH_AND_ONBOARDING.md ("Panel de la demo").
 *
 * El fundador arma la tienda de un prospecto y le manda el link `/:username?demo`; el botón "Ver tu
 * panel de administrador" lo lleva al panel de ese local. Para que no vea todo vacío, al terminar de
 * armar la tienda un lote deja en ella clientes, pedidos, dos campañas y un cupón de ejemplo. Todo
 * lleva la marca "EJEMPLO" en el nombre y se puede borrar de una vez (`datos-ejemplo-db.ts`).
 *
 * Este archivo es el plan, puro y determinista: dado el "ahora" y los productos reales del local
 * decide qué filas crear. No toca la base; `datos-ejemplo-db.ts` las escribe.
 *
 * Los datos cuentan la misma historia que la demo de la tienda (web/src/lib/demo.ts) y la landing:
 * Martina pidió 7 veces, cada ~12 días, y hace 3 semanas que no pide: "se está yendo". Los segmentos
 * salen del cálculo real (`clientes-rfm.ts`), así que si cambian sus umbrales hay que revisar los
 * perfiles de acá: el test del plan verifica el segmento de cada uno.
 */

export const MARCA_EJEMPLO = 'EJEMPLO'

const MIN_MS = 60_000
const HORA_MS = 3_600_000
const DIA_MS = 86_400_000
/** Argentina no tiene horario de verano: siempre UTC-3. */
const OFFSET_AR_MS = 3 * HORA_MS

const modulo = (a: number, n: number) => ((a % n) + n) % n

/** La medianoche argentina (como instante) del día al que pertenece `ms`. */
export function inicioDiaAR(ms: number): number {
  const local = ms - OFFSET_AR_MS
  return local - modulo(local, DIA_MS) + OFFSET_AR_MS
}

/** 0 = domingo … 6 = sábado, en horario argentino. */
export function diaSemanaAR(ms: number): number {
  return new Date(ms - OFFSET_AR_MS).getUTCDay()
}

/** Un producto real del local, con la primera opción de cada grupo de variantes. */
export interface ProductoEjemplo {
  id: number
  nombre: string
  precio: number
  variante: { id: number; nombre: string; precio: number } | null
  varianteSecundaria: { id: number; nombre: string; precio: number } | null
}

export interface ItemPlan {
  productoId: number
  cantidad: number
  precioUnitario: number
  varianteId: number | null
  varianteNombre: string | null
  varianteSecundariaId: number | null
  varianteSecundariaNombre: string | null
}

export type ClaveCampana = 'instagram' | 'qr'
export type MetodoPagoEjemplo = 'mercadopago_checkout' | 'manual_transfer' | 'cash'
/** Los de hoy están en curso; los históricos ya se despacharon (`archived`, como "Despachar"). */
export type EstadoPedidoEjemplo = 'pending' | 'received' | 'preparing' | 'archived'

export interface ClientePlan {
  clave: string
  nombre: string
  telefono: string
  telefonoNormalizado: string
  direccion: string | null
  puntos: number
  creadoAt: Date
}

export interface PedidoPlan {
  clienteClave: string
  nombreCliente: string
  telefono: string
  creadoAt: Date
  estado: EstadoPedidoEjemplo
  tipo: 'delivery' | 'takeaway'
  metodoPago: MetodoPagoEjemplo
  pagado: boolean
  items: ItemPlan[]
  subtotal: number
  envio: number
  descuento: number
  total: number
  direccion: string | null
  latitud: string | null
  longitud: string | null
  campanaClave: ClaveCampana | null
  usaCupon: boolean
  puntosGanados: number
  nota: string | null
}

export interface CampanaPlan {
  clave: ClaveCampana
  nombre: string
  slug: string
  categoria: 'historias_instagram' | 'qr_salon_mostrador'
  inversionManual: number
  visitas: number
  usos: number
  conCupon: boolean
  activadaAt: Date
}

export interface SesionPlan {
  campanaClave: ClaveCampana
  creadoAt: Date
}

export interface CuponPlan {
  codigo: string
  porcentaje: number
  limiteUsos: number
  usos: number
}

export interface PlanDatosEjemplo {
  clientes: ClientePlan[]
  pedidos: PedidoPlan[]
  campanas: CampanaPlan[]
  sesiones: SesionPlan[]
  cupon: CuponPlan
}

export interface EntradaPlan {
  ahora: Date
  productos: ProductoEjemplo[]
  /** Costo de envío del local, para los pedidos de delivery. */
  envio?: number
  /** Dónde queda el local: los pedidos de delivery caen cerca, así el mapa se ve bien. */
  ubicacion?: { lat: number; lng: number } | null
  /** Cuántos pesos suman un punto (1 punto cada $100 por defecto). */
  pesosPorPunto?: number
  /** Cambia sólo el desorden de los horarios; el mismo número da el mismo plan. */
  semilla?: number
}

interface Perfil {
  nombre: string
  pedidos: number
  /** Días entre un pedido y el siguiente. */
  cadencia: number
  /** Hace cuántos días fue el último. */
  ultimoHace: number
  /** Si el último fue hoy: hace cuántos minutos y en qué estado está. */
  hoy?: { minutos: number; estado: Exclude<EstadoPedidoEjemplo, 'archived'>; impago?: boolean }
  tipo: 'delivery' | 'takeaway'
  pago: MetodoPagoEjemplo
  campana?: { clave: ClaveCampana; recientes: number }
  /** Cuántos de sus últimos pedidos usaron el cupón por su cuenta (sin campaña). */
  cuponRecientes?: number
  /** El segmento que le da el cálculo real; lo verifica el test del plan. */
  segmento: 'vip' | 'activo' | 'nuevo' | 'en_riesgo' | 'dormido' | 'perdido'
}

/**
 * Dieciséis clientes que cuentan una base real: algunos fieles, algunos nuevos por una campaña y,
 * lo importante para vender, unos cuantos que "se están yendo" o ya no vuelven. Las edades de los
 * últimos pedidos están a mitad de cada banda del cálculo (1,5×, 3× y 6× la cadencia) para que
 * correr un día un pedido por el día de la semana no cambie el segmento.
 */
const PERFILES: Perfil[] = [
  { nombre: 'Camila', pedidos: 9, cadencia: 7, ultimoHace: 3, tipo: 'delivery', pago: 'mercadopago_checkout', campana: { clave: 'instagram', recientes: 1 }, segmento: 'vip' },
  { nombre: 'Tomás', pedidos: 8, cadencia: 9, ultimoHace: 0, hoy: { minutos: 55, estado: 'preparing' }, tipo: 'delivery', pago: 'manual_transfer', segmento: 'vip' },
  { nombre: 'Lucía', pedidos: 7, cadencia: 8, ultimoHace: 0, hoy: { minutos: 24, estado: 'received' }, tipo: 'delivery', pago: 'mercadopago_checkout', campana: { clave: 'instagram', recientes: 1 }, segmento: 'vip' },
  { nombre: 'Mateo', pedidos: 4, cadencia: 11, ultimoHace: 6, tipo: 'takeaway', pago: 'cash', campana: { clave: 'qr', recientes: 1 }, segmento: 'activo' },
  { nombre: 'Valentina', pedidos: 3, cadencia: 14, ultimoHace: 9, tipo: 'delivery', pago: 'mercadopago_checkout', cuponRecientes: 1, segmento: 'activo' },
  { nombre: 'Joaquín', pedidos: 5, cadencia: 10, ultimoHace: 4, tipo: 'delivery', pago: 'manual_transfer', campana: { clave: 'qr', recientes: 1 }, segmento: 'activo' },
  { nombre: 'Sofía', pedidos: 4, cadencia: 12, ultimoHace: 10, tipo: 'takeaway', pago: 'mercadopago_checkout', cuponRecientes: 1, segmento: 'activo' },
  { nombre: 'Bruno', pedidos: 1, cadencia: 0, ultimoHace: 1, tipo: 'delivery', pago: 'mercadopago_checkout', campana: { clave: 'instagram', recientes: 1 }, segmento: 'nuevo' },
  { nombre: 'Julieta', pedidos: 1, cadencia: 0, ultimoHace: 6, tipo: 'takeaway', pago: 'cash', campana: { clave: 'instagram', recientes: 1 }, segmento: 'nuevo' },
  { nombre: 'Franco', pedidos: 1, cadencia: 0, ultimoHace: 0, hoy: { minutos: 7, estado: 'pending', impago: true }, tipo: 'takeaway', pago: 'cash', campana: { clave: 'instagram', recientes: 1 }, segmento: 'nuevo' },
  { nombre: 'Martina', pedidos: 7, cadencia: 12, ultimoHace: 21, tipo: 'delivery', pago: 'manual_transfer', segmento: 'en_riesgo' },
  { nombre: 'Nicolás', pedidos: 5, cadencia: 10, ultimoHace: 18, tipo: 'delivery', pago: 'mercadopago_checkout', segmento: 'en_riesgo' },
  { nombre: 'Agustina', pedidos: 4, cadencia: 14, ultimoHace: 25, tipo: 'takeaway', pago: 'cash', segmento: 'en_riesgo' },
  { nombre: 'Ezequiel', pedidos: 4, cadencia: 8, ultimoHace: 30, tipo: 'delivery', pago: 'mercadopago_checkout', segmento: 'dormido' },
  { nombre: 'Paula', pedidos: 3, cadencia: 10, ultimoHace: 38, tipo: 'takeaway', pago: 'manual_transfer', segmento: 'dormido' },
  { nombre: 'Gonzalo', pedidos: 3, cadencia: 7, ultimoHace: 55, tipo: 'delivery', pago: 'cash', segmento: 'perdido' },
]

/** Para los tests: el segmento que cada perfil debe tener, por nombre. */
export const SEGMENTOS_ESPERADOS: Record<string, Perfil['segmento']> = Object.fromEntries(
  PERFILES.map((p) => [`${p.nombre} ${MARCA_EJEMPLO}`, p.segmento]),
)

const CAMPANAS: Record<ClaveCampana, Omit<CampanaPlan, 'usos' | 'activadaAt'> & { diasActiva: number }> = {
  instagram: {
    clave: 'instagram',
    nombre: `Historias de Instagram · ${MARCA_EJEMPLO}`,
    slug: 'ejemplo-historias-instagram',
    categoria: 'historias_instagram',
    inversionManual: 18000,
    visitas: 132,
    conCupon: false,
    diasActiva: 27,
  },
  qr: {
    clave: 'qr',
    nombre: `QR del mostrador · ${MARCA_EJEMPLO}`,
    slug: 'ejemplo-qr-mostrador',
    categoria: 'qr_salon_mostrador',
    inversionManual: 5000,
    visitas: 46,
    conCupon: true,
    diasActiva: 20,
  },
}

/** El descuento del cupón de ejemplo (`EJEMPLO10`). */
export const PORCENTAJE_CUPON = 10
const LIMITE_CUPON = 100

const CALLES = [
  'Belgrano 820', 'Mitre 1530', 'Sarmiento 440', 'Rivadavia 2210', 'San Martín 1450', '9 de Julio 960',
  'Alsina 315', 'Urquiza 1180', 'Moreno 705', 'Pellegrini 1620', 'Córdoba 2040', 'Entre Ríos 890',
]
/** Las horas de pedido, en milisegundos desde la medianoche: almuerzo y, sobre todo, cena. */
const HORARIOS = [20.5, 21.25, 13.17, 21.67, 12.83, 22.08, 20.83, 13.5].map((h) => Math.round(h * HORA_MS))

/** Jueves a domingo concentran los pedidos; los martes y miércoles se dejan para pocos (días flojos). */
const DIAS_FUERTES = [4, 5, 6, 0]
const DIAS_CON_FLOJOS = [2, 3, 4, 5, 6, 0]

function aleatorio(semilla: number) {
  let t = semilla >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/** Retrocede hasta el último día de la semana que le gusta a ese pedido (a lo sumo tres días). */
function diaPreferido(ms: number, permitidos: number[]): number {
  let dia = ms
  for (let i = 0; i < 3 && !permitidos.includes(diaSemanaAR(dia)); i++) dia -= DIA_MS
  return dia
}

const redondear = (n: number) => Math.round(n * 100) / 100

function armarItems(productos: ProductoEjemplo[], cliente: number, pedido: number): ItemPlan[] {
  const cantidadDistinta = 1 + ((cliente + pedido) % 3 === 0 ? 1 : 0) + ((cliente + pedido) % 5 === 0 ? 1 : 0)
  const elegidos = new Set<number>()
  const items: ItemPlan[] = []
  for (let t = 0; t < cantidadDistinta; t++) {
    // Cada cliente vuelve sobre unos pocos favoritos: los más pedidos le salen distintos a cada uno.
    const producto = productos[(cliente * 3 + t * 2 + (pedido % 2)) % productos.length]
    if (elegidos.has(producto.id)) continue
    elegidos.add(producto.id)
    const base = producto.variante?.precio ?? producto.precio
    const adicional = producto.varianteSecundaria?.precio ?? 0
    items.push({
      productoId: producto.id,
      cantidad: 1 + ((cliente + pedido + t) % 4 === 0 ? 1 : 0),
      precioUnitario: redondear(base + adicional),
      varianteId: producto.variante?.id ?? null,
      varianteNombre: producto.variante?.nombre ?? null,
      varianteSecundariaId: producto.varianteSecundaria?.id ?? null,
      varianteSecundariaNombre: producto.varianteSecundaria?.nombre ?? null,
    })
  }
  return items
}

export function planificarDatosEjemplo(entrada: EntradaPlan): PlanDatosEjemplo {
  const ahora = entrada.ahora.getTime()
  const productos = entrada.productos.filter((p) => p.precio > 0)
  if (productos.length === 0) throw new Error('Hacen falta productos con precio para armar los datos de ejemplo')
  const envioLocal = Math.max(0, entrada.envio ?? 0)
  const pesosPorPunto = entrada.pesosPorPunto && entrada.pesosPorPunto > 0 ? entrada.pesosPorPunto : 100
  const azar = aleatorio(entrada.semilla ?? 1)
  const hoy0 = inicioDiaAR(ahora)

  const clientes: ClientePlan[] = []
  const pedidos: PedidoPlan[] = []

  PERFILES.forEach((perfil, i) => {
    const clave = `c${i + 1}`
    const nombre = `${perfil.nombre} ${MARCA_EJEMPLO}`
    const sufijo = String(101 + i).padStart(4, '0')
    // Los números no existen (los abonados no empiezan con 0): nadie recibe un mensaje de la demo.
    const telefono = `+54 9 11 0000-${sufijo}`
    const telefonoNormalizado = `549110000${sufijo}`
    const direccion = perfil.tipo === 'delivery' ? CALLES[i % CALLES.length] : null

    const propios: PedidoPlan[] = []
    for (let k = 0; k < perfil.pedidos; k++) {
      // k = 0 es el último pedido; los demás retroceden de a una cadencia.
      let creado: number
      if (k === 0 && perfil.hoy) {
        creado = Math.max(hoy0 + MIN_MS, ahora - perfil.hoy.minutos * MIN_MS)
      } else {
        const base = ahora - (perfil.ultimoHace + k * perfil.cadencia) * DIA_MS
        const permitidos = (i + k) % 5 === 0 ? DIAS_CON_FLOJOS : DIAS_FUERTES
        const dia = inicioDiaAR(diaPreferido(base, permitidos))
        creado = dia + HORARIOS[(i + k) % HORARIOS.length] + Math.floor(azar() * 14) * MIN_MS
        // Nunca en el futuro ni en el mismo día que "hoy" salvo los que lo piden.
        creado = Math.min(creado, ahora - 30 * MIN_MS)
      }

      const items = armarItems(productos, i, k)
      const subtotal = redondear(items.reduce((s, it) => s + it.cantidad * it.precioUnitario, 0))
      const delivery = perfil.tipo === 'delivery'
      const campanaReciente = perfil.campana && k < perfil.campana.recientes ? perfil.campana.clave : null
      const usaCupon =
        (campanaReciente !== null && CAMPANAS[campanaReciente].conCupon) ||
        (perfil.cuponRecientes !== undefined && k < perfil.cuponRecientes)
      const descuento = usaCupon ? redondear(subtotal * (PORCENTAJE_CUPON / 100)) : 0
      const envio = delivery ? envioLocal : 0
      const total = redondear(subtotal + envio - descuento)
      const enCurso = k === 0 && perfil.hoy ? perfil.hoy : null
      const pagado = !(enCurso?.impago ?? false)
      const ubicacion = entrada.ubicacion
      propios.push({
        clienteClave: clave,
        nombreCliente: nombre,
        telefono,
        creadoAt: new Date(creado),
        estado: enCurso ? enCurso.estado : 'archived',
        tipo: perfil.tipo,
        metodoPago: perfil.pago,
        pagado,
        items,
        subtotal,
        envio,
        descuento,
        total,
        direccion: delivery ? CALLES[(i + k) % CALLES.length] : null,
        latitud: delivery && ubicacion ? (ubicacion.lat + (azar() - 0.5) * 0.024).toFixed(7) : null,
        longitud: delivery && ubicacion ? (ubicacion.lng + (azar() - 0.5) * 0.024).toFixed(7) : null,
        campanaClave: campanaReciente,
        usaCupon,
        puntosGanados: pagado ? Math.floor(Math.max(0, subtotal - descuento) / pesosPorPunto) : 0,
        nota: k === 0 && i === 0 ? 'Pedido de ejemplo: así se ve una aclaración del cliente.' : null,
      })
    }

    const primero = Math.min(...propios.map((p) => p.creadoAt.getTime()))
    clientes.push({
      clave,
      nombre,
      telefono,
      telefonoNormalizado,
      direccion,
      puntos: propios.reduce((s, p) => s + p.puntosGanados, 0),
      creadoAt: new Date(primero - 5 * MIN_MS),
    })
    pedidos.push(...propios)
  })

  // El más antiguo primero: así los ids crecen con el tiempo, como en un local real.
  pedidos.sort((a, b) => a.creadoAt.getTime() - b.creadoAt.getTime())

  const campanas: CampanaPlan[] = (Object.keys(CAMPANAS) as ClaveCampana[]).map((clave) => {
    const { diasActiva, ...campana } = CAMPANAS[clave]
    return {
      ...campana,
      usos: pedidos.filter((p) => p.campanaClave === clave).length,
      activadaAt: new Date(inicioDiaAR(ahora - diasActiva * DIA_MS) + 12 * HORA_MS),
    }
  })

  // Visitas fechadas: el resumen de marketing cuenta sesiones dentro del período, no el contador.
  const sesiones: SesionPlan[] = []
  for (const campana of campanas) {
    const desde = campana.activadaAt.getTime()
    const ventana = ahora - 10 * MIN_MS - desde
    for (let n = 0; n < campana.visitas; n++) {
      const posicion = (n + azar()) / campana.visitas
      sesiones.push({ campanaClave: campana.clave, creadoAt: new Date(desde + posicion * ventana) })
    }
  }

  return {
    clientes,
    pedidos,
    campanas,
    sesiones,
    cupon: {
      codigo: `${MARCA_EJEMPLO}${PORCENTAJE_CUPON}`,
      porcentaje: PORCENTAJE_CUPON,
      limiteUsos: LIMITE_CUPON,
      usos: pedidos.filter((p) => p.usaCupon).length,
    },
  }
}
