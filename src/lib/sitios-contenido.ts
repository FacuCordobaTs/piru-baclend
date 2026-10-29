import { normalizarTienda, objetoTienda, type TiendaConfig } from './tienda-config'

/** Los colores de marca que quedan escritos en el código del sitio. */
export type MarcaSitio = { colorPrimario: string; colorSecundario: string; usarColorUnico: boolean }

/**
 * El contenido inicial de una página de Páginas. No se guarda como configuración del local:
 * se escribe en `contenido.ts` dentro del borrador del sitio y de ahí sale el diseño.
 */
export type ContenidoSitio = TiendaConfig & {
  plantilla: NonNullable<TiendaConfig['plantilla']>
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
  marca: { primario: string; secundario: string; usarColorUnico: boolean }
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

