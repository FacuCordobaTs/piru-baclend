import { readFileSync } from 'node:fs'
import type { Borrador } from './sitios-reglas'
import { archivoContenido, type ContenidoSitio } from './sitios-contenido'

const leer = (archivo: string) => readFileSync(new URL(`./sitios-plantilla/${archivo}`, import.meta.url), 'utf8')

export const CONTENIDO_INICIAL: ContenidoSitio = {
  plantilla: 'artesanal',
  marca: { colorPrimario: '#FF7A00', colorSecundario: '#FFFFFF', usarColorUnico: false },
  logo: null,
  logoClaro: null,
}

/**
 * Borrador inicial de un sitio: una tienda completa (portada, categorías, carta, pedido y
 * estados) que usa sólo `@piru/tienda`, `react`, `motion` y `lucide-react`. El contenido que el
 * dueño elige antes de crear la página queda escrito en `contenido.ts`, no en el backend.
 * También es el ejemplo funcional de la Guía para Claude.
 */
export function plantillaInicial(contenido: ContenidoSitio = CONTENIDO_INICIAL): Borrador {
  return {
    'page.tsx': leer('page.tsx.txt'),
    'style.css': leer('style.css.txt'),
    'contenido.ts': archivoContenido(contenido),
  }
}

export const PLANTILLA_INICIAL: Borrador = plantillaInicial()
