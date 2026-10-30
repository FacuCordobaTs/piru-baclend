import { readFileSync } from 'node:fs'
import type { Borrador } from './sitios-reglas'
import { archivoContenido, type ContenidoSitio } from './sitios-contenido'

const leer = (archivo: string) => readFileSync(new URL(`./sitios-plantilla/${archivo}`, import.meta.url), 'utf8')

export const CONTENIDO_INICIAL: ContenidoSitio = {
  plantilla: 'artesanal',
  detalleProducto: 'pasos',
  checkout: 'pasos',
  marca: { colorPrimario: '#FF7A00', colorSecundario: '#FFFFFF', usarColorUnico: false },
  logo: null,
  logoClaro: null,
}

/**
 * Borrador inicial de un sitio: una tienda completa (portada, categorías, carta, detalle de
 * producto, pedido y estados) que usa sólo `@piru/tienda`, `react`, `motion` y `lucide-react`. El
 * contenido que el dueño elige antes de crear la página queda escrito en `contenido.ts`, no en el
 * backend. El detalle de producto es una pieza del diseño, editable en
 * `components/DetalleProducto.tsx`, con tres estilos elegibles en Preferencias. El checkout es
 * `components/Checkout.tsx`, que monta `<PiruCheckout />` y elige una de sus tres variantes.
 * También es el ejemplo funcional de la Guía para Claude.
 */
export function plantillaInicial(contenido: ContenidoSitio = CONTENIDO_INICIAL): Borrador {
  return {
    'page.tsx': leer('page.tsx.txt'),
    'style.css': leer('style.css.txt'),
    'components/DetalleProducto.tsx': leer('detalle-producto.tsx.txt'),
    'components/detalle.css': leer('detalle.css.txt'),
    'components/Checkout.tsx': leer('checkout.tsx.txt'),
    'contenido.ts': archivoContenido(contenido),
  }
}

export const PLANTILLA_INICIAL: Borrador = plantillaInicial()
