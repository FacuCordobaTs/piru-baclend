import { normalizarTienda, objetoTienda, type TiendaConfig } from './tienda-config'
import { errorImagenDataUrl } from './producto-imagenes'

/** Los colores de marca que quedan escritos en el código del sitio. */
export type MarcaSitio = { colorPrimario: string; colorSecundario: string; usarColorUnico: boolean }

/** Los estilos del detalle de producto que genera la plantilla (en `components/DetalleProducto.tsx`). */
export const DETALLES_PRODUCTO = ['pasos', 'dialogo', 'hoja'] as const
export type DetalleProducto = (typeof DETALLES_PRODUCTO)[number]

/** Las formas del checkout de Páginas (en `components/Checkout.tsx`, implementadas por el runtime). */
export const CHECKOUTS_SITIO = ['pasos', 'hoja', 'pagina'] as const
export type CheckoutSitio = (typeof CHECKOUTS_SITIO)[number]

/**
 * El contenido inicial de una página de Páginas. No se guarda como configuración del local:
 * se escribe en `contenido.ts` dentro del borrador del sitio y de ahí sale el diseño.
 * Incluye dos decisiones propias de Páginas que no viajan a `tienda_config`: `detalleProducto` y
 * `checkout`.
 */
export type ContenidoSitio = TiendaConfig & {
  plantilla: NonNullable<TiendaConfig['plantilla']>
  /** Cómo se muestra el detalle de producto. Sólo de Páginas: no viaja a `tienda_config`. */
  detalleProducto?: DetalleProducto
  /** Cómo se abre el checkout. Sólo de Páginas: no viaja a `tienda_config`. */
  checkout?: CheckoutSitio
  marca: MarcaSitio
  logo: string | null
  logoClaro: string | null
  /** La página: secciones en orden, con sus propiedades. Las edita el editor visual. */
  secciones?: SeccionSitio[]
  /** Fuentes subidas por el local (`assets/*.woff2`); el editor escribe su `@font-face` en `fuentes.css`. */
  fuentesPropias?: FuentePropia[]
}

/**
 * Una sección de la página. `tipo` elige el componente de `secciones/` y `props` sus propiedades;
 * no hay HTML, CSS ni JS en las propiedades (docs/PLAN_PAGINAS.md, §5.3).
 */
export type SeccionSitio = {
  id: string
  tipo: string
  visible: boolean
  /** Nombre interno que el dueño le pone en la lista ("Promo de los martes"). */
  nombre?: string
  props: Record<string, unknown>
}

export type FuentePropia = { familia: string; archivo: string }

export const LIMITES_SECCIONES = { secciones: 40, profundidad: 5, claves: 40, items: 60, texto: 4000, bytes: 200_000 }
const ID_SECCION = /^[a-z0-9][a-z0-9-]{0,39}$/
const TIPO_SECCION = /^[a-z][a-z0-9-]{0,39}$/
const CLAVE_PROP = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

/** Sólo datos planos: textos sin data URLs, números finitos, booleanos, listas y objetos acotados. */
function limpiarValor(v: unknown, profundidad: number): unknown {
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string') return v.startsWith('data:') ? undefined : v.slice(0, LIMITES_SECCIONES.texto)
  if (profundidad >= LIMITES_SECCIONES.profundidad) return undefined
  if (Array.isArray(v))
    return v
      .slice(0, LIMITES_SECCIONES.items)
      .map((x) => limpiarValor(x, profundidad + 1))
      .filter((x) => x !== undefined)
  if (typeof v === 'object') return limpiarProps(v, profundidad + 1)
  return undefined
}

function limpiarProps(v: unknown, profundidad = 0): Record<string, unknown> {
  const fuente = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const props: Record<string, unknown> = {}
  for (const [clave, valor] of Object.entries(fuente).slice(0, LIMITES_SECCIONES.claves)) {
    if (!CLAVE_PROP.test(clave)) continue
    const limpio = limpiarValor(valor, profundidad)
    if (limpio !== undefined) props[clave] = limpio
  }
  return props
}

/** Normaliza la lista de secciones. `undefined` si no hay lista (página anterior al editor visual). */
export function normalizarSecciones(entrada: unknown): SeccionSitio[] | undefined {
  if (!Array.isArray(entrada)) return undefined
  const vistos = new Set<string>()
  const secciones: SeccionSitio[] = []
  for (const s of entrada.slice(0, LIMITES_SECCIONES.secciones)) {
    const o = s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : null
    if (!o || typeof o.id !== 'string' || typeof o.tipo !== 'string') continue
    if (!ID_SECCION.test(o.id) || !TIPO_SECCION.test(o.tipo) || vistos.has(o.id)) continue
    vistos.add(o.id)
    const nombre = typeof o.nombre === 'string' && o.nombre.trim() ? o.nombre.trim().slice(0, 60) : undefined
    secciones.push({ id: o.id, tipo: o.tipo, visible: o.visible !== false, ...(nombre ? { nombre } : {}), props: limpiarProps(o.props) })
  }
  if (JSON.stringify(secciones).length > LIMITES_SECCIONES.bytes) throw new RangeError('La página tiene demasiado contenido')
  return secciones
}

export function normalizarFuentesPropias(entrada: unknown): FuentePropia[] | undefined {
  if (!Array.isArray(entrada)) return undefined
  const fuentes = entrada
    .map((f) => (f && typeof f === 'object' ? (f as Record<string, unknown>) : {}))
    .filter(
      (f) =>
        typeof f.familia === 'string' &&
        /^[\p{L}\p{N} ]{1,60}$/u.test(f.familia.trim()) &&
        typeof f.archivo === 'string' &&
        /^assets\/[A-Za-z0-9_][A-Za-z0-9_.\/-]{0,180}\.woff2$/.test(f.archivo) &&
        !f.archivo.includes('..'),
    )
    .slice(0, 6)
    .map((f) => ({ familia: (f.familia as string).trim(), archivo: f.archivo as string }))
  return fuentes.length ? fuentes : undefined
}

/**
 * La página por defecto, armada con el contenido de siempre (frase, portada, cinta, historia,
 * galería y destacado). Es lo que recibe una página nueva sin secciones y la migración de una
 * página anterior al editor visual. El editor (`sitios/src/editor/documento.ts`) arma la misma.
 */
export function seccionesIniciales(c: Partial<ContenidoSitio>): SeccionSitio[] {
  const s = (tipo: string, props: Record<string, unknown> = {}, visible = true): SeccionSitio => ({ id: `${tipo}-1`, tipo, visible, props })
  return [
    s('aviso', { mostrarCampana: true }),
    s('portada', {
      titulo: c.frase ?? '',
      bajada: c.bajada ?? '',
      medio: c.portadaUrl ? { url: c.portadaUrl, tipo: 'imagen' } : null,
      destacadoId: c.productoDestacadoId ?? null,
      boton: { texto: 'Ver la carta', accion: 'carta' },
      botonSecundario: { texto: 'Escribinos', accion: 'whatsapp' },
      animacion: 'suave',
    }),
    s('cinta', { items: c.cinta ?? [] }, (c.cinta?.length ?? 0) > 0),
    s('carta', { mostrarCategorias: true, estilo: 'plantilla' }),
    s('grupo', {
      titulo: 'Pedí entre varios',
      texto: 'Armá un pedido en grupo: compartís el link, cada uno elige lo suyo desde su celular y llega todo junto.',
      boton: 'Armar pedido en grupo',
    }),
    s('puntos', { titulo: 'Canjeá tus puntos' }),
    s('historia', { kicker: 'Nuestra historia', titulo: c.historia?.titulo ?? 'La casa', texto: c.historia?.texto ?? '' }, !!c.historia?.texto),
    s('galeria', { fotos: c.galeria ?? [] }, (c.galeria?.length ?? 0) > 0),
    s('ubicacion', { titulo: 'Dónde estamos', mostrarMapa: true, mostrarHorarios: true }),
    s('pie', { mostrarDireccion: true, mostrarRedes: true }),
  ]
}

/** Los campos de antes del editor visual: pasan a las secciones y dejan de escribirse sueltos. */
const CAMPOS_MIGRADOS = ['frase', 'bajada', 'portadaUrl', 'galeria', 'cinta', 'historia', 'productoDestacadoId'] as const

const COLOR = /^#(?:[\da-f]{3}|[\da-f]{6})$/i

export function marcaPorDefecto(colorPrimario?: string | null, colorSecundario?: string | null, usarColorUnico?: boolean | null): MarcaSitio {
  return {
    colorPrimario: colorPrimario && COLOR.test(colorPrimario) ? colorPrimario : '#FF7A00',
    colorSecundario: colorSecundario && COLOR.test(colorSecundario) ? colorSecundario : '#FFFFFF',
    usarColorUnico: usarColorUnico === true,
  }
}

/** Sólo acepta colores válidos y completa con la marca actual del local. */
export function normalizarMarcaSitio(entrada: unknown, base: MarcaSitio): MarcaSitio {
  const m = objetoTienda(entrada)
  const color = (v: unknown) => (typeof v === 'string' && COLOR.test(v.trim()) ? v.trim() : undefined)
  return {
    colorPrimario: color(m.colorPrimario) ?? base.colorPrimario,
    colorSecundario: color(m.colorSecundario) ?? base.colorSecundario,
    usarColorUnico: typeof m.usarColorUnico === 'boolean' ? m.usarColorUnico : base.usarColorUnico,
  }
}

/**
 * Normaliza el contenido que llega del editor y le agrega la marca y los logos. Las fotos
 * con data URL se resuelven antes, en la ruta, porque necesitan subirse a R2.
 */
export function normalizarContenidoSitio(entrada: unknown, base: { marca: MarcaSitio; logo: string | null; logoClaro: string | null }): ContenidoSitio {
  const t = objetoTienda(entrada)
  const tienda = normalizarTienda(t) ?? {}
  const logo = (v: unknown) => (typeof v === 'string' && /^(https:\/\/|\/(?!\/))/i.test(v.trim()) ? v.trim() : null)
  // Una página con secciones ya no usa los campos sueltos de la portada: viven en sus propiedades.
  const secciones = normalizarSecciones(t.secciones) ?? seccionesIniciales(tienda)
  const resto: TiendaConfig = { ...tienda }
  for (const campo of CAMPOS_MIGRADOS) delete resto[campo]
  const fuentesPropias = normalizarFuentesPropias(t.fuentesPropias)
  return {
    ...resto,
    plantilla: tienda.plantilla ?? 'artesanal',
    detalleProducto: DETALLES_PRODUCTO.includes(t.detalleProducto as DetalleProducto)
      ? (t.detalleProducto as DetalleProducto)
      : 'pasos',
    checkout: CHECKOUTS_SITIO.includes(t.checkout as CheckoutSitio)
      ? (t.checkout as CheckoutSitio)
      : 'pasos',
    marca: normalizarMarcaSitio(t.marca, base.marca),
    logo: t.logo === null ? null : logo(t.logo) ?? base.logo,
    logoClaro: t.logoClaro === null ? null : logo(t.logoClaro) ?? base.logoClaro,
    ...(fuentesPropias ? { fuentesPropias } : {}),
    secciones,
  }
}

/** El archivo `contenido.ts`: tipos para el editor y el JSON editable entre marcadores. */
export function archivoContenido(contenido: ContenidoSitio): string {
  const json = JSON.stringify(contenido, null, 2)
  return `// Piru · Contenido de esta página.
// Esto es parte del código: cambialo, movelo o reemplazalo. El diseño lo importa desde acá.
// Las fotos y los logos son URLs públicas; la carta, los precios y los pedidos siguen viniendo del SDK.
//
// La página es la lista \`secciones\`: el editor visual la reordena, oculta y edita, y
// \`secciones/index.ts\` elige el componente de cada \`tipo\`. Las propiedades son sólo datos.
export type Accion = {
  texto?: string
  /** carta · grupo · whatsapp · instagram · seccion (destino = id) · enlace (destino = https://…) · ninguna */
  accion?: "carta" | "grupo" | "whatsapp" | "instagram" | "seccion" | "enlace" | "ninguna"
  destino?: string
}

export type Medio = { url: string; tipo?: "imagen" | "video" }

export type SeccionPagina = {
  id: string
  tipo: string
  visible?: boolean
  nombre?: string
  props?: Record<string, any>
}

export type ContenidoSitio = {
  plantilla?: "elegante" | "moderna" | "artesanal"
  detalleProducto?: "pasos" | "dialogo" | "hoja"
  checkout?: "pasos" | "hoja" | "pagina"
  marca: { colorPrimario: string; colorSecundario: string; usarColorUnico: boolean }
  logo: string | null
  logoClaro: string | null
  colores?: { fondo?: string; texto?: string; acento?: string; superficie?: string }
  fuentes?: { titulos?: string; cuerpo?: string; cssUrl?: string; pesoTitulos?: number }
  fuentesPropias?: { familia: string; archivo: string }[]
  instagram?: string
  whatsapp?: string
  secciones?: SeccionPagina[]
}

export const CONTENIDO: ContenidoSitio = /* piru:contenido */
${json}
/* /piru:contenido */
`
}


const VIDEOS = ['video/mp4', 'video/webm']
export const MAX_BYTES_VIDEO = 8 * 1024 * 1024

/**
 * Las fotos de las secciones siguen las reglas de las fotos de la tienda (JPG, PNG o WebP de hasta
 * 5 MB). Una portada también puede ser un video corto (MP4 o WebM de hasta 8 MB) que se repite sin
 * sonido. `null` si se acepta; si no, el motivo.
 */
export function errorMedioDataUrl(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s)
  if (!match || !VIDEOS.includes(match[1])) return errorImagenDataUrl(dataUrl)
  const base64 = match[2]
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return 'Formato de video inválido'
  const relleno = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  if ((base64.length * 3) / 4 - relleno > MAX_BYTES_VIDEO) return 'El video puede pesar hasta 8 MB'
  return null
}
