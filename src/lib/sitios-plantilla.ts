import { readFileSync } from 'node:fs'
import type { Borrador } from './sitios-reglas'
import { archivoContenido, seccionesIniciales, type ContenidoSitio, type FuentePropia } from './sitios-contenido'

const leer = (archivo: string) => readFileSync(new URL(`./sitios-plantilla/${archivo}`, import.meta.url), 'utf8')

export const CONTENIDO_INICIAL: ContenidoSitio = {
  plantilla: 'artesanal',
  detalleProducto: 'pasos',
  checkout: 'pasos',
  marca: { colorPrimario: '#FF7A00', colorSecundario: '#FFFFFF', usarColorUnico: false },
  logo: null,
  logoClaro: null,
}

/** Las secciones de la plantilla: `tipo` → archivo en `secciones/`. El editor visual tiene su catálogo. */
export const SECCIONES_PLANTILLA = {
  aviso: 'Aviso',
  portada: 'Portada',
  cinta: 'Cinta',
  destacado: 'Destacado',
  carta: 'Carta',
  grupo: 'Grupo',
  puntos: 'Puntos',
  historia: 'Historia',
  galeria: 'Galeria',
  ubicacion: 'Ubicacion',
  preguntas: 'Preguntas',
  llamado: 'Llamado',
  bloque: 'Bloque',
  pie: 'Pie',
} as const

/**
 * `fuentes.css`: el `@font-face` de las fuentes que subió el local. Lo reescribe el editor visual
 * (`sitios/src/editor/fuentes.ts` arma exactamente el mismo texto).
 */
export function archivoFuentes(fuentes: FuentePropia[] = []): string {
  const caras = fuentes.map(
    (f) => `@font-face {\n  font-family: "${f.familia}";\n  src: url("./${f.archivo}") format("woff2");\n  font-weight: 100 900;\n  font-display: swap;\n}\n`,
  )
  return `/* Piru · Fuentes propias de esta página. Las escribe el editor (Marca → Tipografías). */\n${caras.join('\n')}`
}

/**
 * Borrador inicial de un sitio: una tienda completa armada por secciones (aviso, portada, carta,
 * pedido en grupo, historia, galería, ubicación, pie…) que usa sólo `@piru/tienda`, `react`,
 * `motion` y `lucide-react`. La página es la lista `CONTENIDO.secciones` de `contenido.ts`: el
 * editor visual la edita como datos y cada `tipo` se dibuja con su componente de `secciones/`. El
 * detalle de producto (`components/DetalleProducto.tsx`) y el checkout (`components/Checkout.tsx`,
 * que monta `<PiruCheckout />`) quedan fuera de las secciones y siempre presentes.
 * También es el ejemplo funcional de la Guía para Claude.
 */
export function plantillaInicial(contenido: ContenidoSitio = CONTENIDO_INICIAL): Borrador {
  const conSecciones: ContenidoSitio = { ...contenido, secciones: contenido.secciones ?? seccionesIniciales(contenido) }
  const borrador: Borrador = {
    'page.tsx': leer('page.tsx.txt'),
    'style.css': leer('style.css.txt'),
    'fuentes.css': archivoFuentes(conSecciones.fuentesPropias),
    'contenido.ts': archivoContenido(conSecciones),
    'components/Sitio.tsx': leer('sitio.tsx.txt'),
    'components/Pedido.tsx': leer('pedido.tsx.txt'),
    'components/DetalleProducto.tsx': leer('detalle-producto.tsx.txt'),
    'components/detalle.css': leer('detalle.css.txt'),
    'components/Checkout.tsx': leer('checkout.tsx.txt'),
    'secciones/index.ts': leer('secciones/index.ts.txt'),
  }
  for (const [tipo, archivo] of Object.entries(SECCIONES_PLANTILLA)) borrador[`secciones/${archivo}.tsx`] = leer(`secciones/${tipo}.tsx.txt`)
  return borrador
}

export const PLANTILLA_INICIAL: Borrador = plantillaInicial()
