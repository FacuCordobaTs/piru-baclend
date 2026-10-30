import { normalizarTienda, objetoTienda, type TiendaConfig } from './tienda-config'

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
}

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
  return {
    ...tienda,
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
  }
}

/** El archivo `contenido.ts`: tipos para el editor y el JSON editable entre marcadores. */
export function archivoContenido(contenido: ContenidoSitio): string {
  const json = JSON.stringify(contenido, null, 2)
  return `// Piru · Contenido de esta página.
// Esto es parte del código: cambialo, movelo o reemplazalo. El diseño lo importa desde acá.
// Las fotos y los logos son URLs públicas; la carta, los precios y los pedidos siguen viniendo del SDK.
export type ContenidoSitio = {
  plantilla?: "elegante" | "moderna" | "artesanal"
  detalleProducto?: "pasos" | "dialogo" | "hoja"
  checkout?: "pasos" | "hoja" | "pagina"
  marca: { colorPrimario: string; colorSecundario: string; usarColorUnico: boolean }
  logo: string | null
  logoClaro: string | null
  colores?: { fondo?: string; texto?: string; acento?: string; superficie?: string }
  fuentes?: { titulos?: string; cuerpo?: string; cssUrl?: string; pesoTitulos?: number }
  productoDestacadoId?: number
  frase?: string
  bajada?: string
  portadaUrl?: string
  galeria?: string[]
  cinta?: string[]
  historia?: { titulo?: string; texto?: string }
  instagram?: string
  whatsapp?: string
}

export const CONTENIDO: ContenidoSitio = /* piru:contenido */
${json}
/* /piru:contenido */
`
}

