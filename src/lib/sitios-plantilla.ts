import { readFileSync } from 'node:fs'
import type { Borrador } from './sitios-reglas'

const leer = (archivo: string) => readFileSync(new URL(`./sitios-plantilla/${archivo}`, import.meta.url), 'utf8')

/**
 * Borrador inicial de un sitio nuevo: una tienda completa (portada, categorías, carta, pedido y
 * estados) que usa sólo `@piru/tienda`, `react`, `motion` y `lucide-react`. También es el ejemplo
 * funcional de la Guía para Claude. Vive como `.txt` para que el backend no lo compile como propio.
 */
export const PLANTILLA_INICIAL: Borrador = {
  'page.tsx': leer('page.tsx.txt'),
  'style.css': leer('style.css.txt'),
}
