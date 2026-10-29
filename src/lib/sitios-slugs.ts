import { isStoreSubdomain } from './public-store-origin'

/**
 * Qué subdominios puede ocupar un sitio de Páginas (docs/PAGINAS_PROPIAS.md, §10.2).
 *
 * - Un label DNS válido que no sea infraestructura (`public-store-origin.ts`, duplicado en
 *   `web/src/lib/store-domain.ts`).
 * - Ninguna clave de `web/src/store-sites/registry.ts`: esos subdominios ya tienen un diseño que
 *   mantiene Piru. La lista se duplica acá a propósito; `sitios-slugs.test.ts` la compara con el
 *   registro de `web/` cuando está en el mismo checkout.
 */
export const SLUGS_REGISTRADOS = ['burgers10'] as const

export function slugDisponible(slug: string): { ok: true } | { ok: false; motivo: string } {
  if (!isStoreSubdomain(slug))
    return { ok: false, motivo: `"${slug}" no puede ser un subdominio de Páginas. Cambiá el link de tu tienda en las preferencias de Páginas.` }
  if ((SLUGS_REGISTRADOS as readonly string[]).includes(slug))
    return { ok: false, motivo: `"${slug}.piru.app" ya tiene un diseño hecho por Piru.` }
  return { ok: true }
}
