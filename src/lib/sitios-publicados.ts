import { and, eq, isNotNull } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { sitioTienda } from '../db/schema'

/**
 * Qué subdominios son sitios de Páginas publicados (docs/PAGINAS_PROPIAS.md, sección 10.5).
 *
 * El código de un sitio de Páginas lo escribe un tercero, así que su origen
 * (`https://<slug>.piru.app`) recibe menos que una tienda registrada o la plantilla: sólo leer la
 * tienda, resolver campañas, mandar eventos y crear el carrito de handoff. Nunca `/mp/*`, el alta de
 * pedidos, la sala, descuentos ni la búsqueda de clientes por teléfono.
 *
 * El conjunto vive en memoria, se refresca cada 60 s y se invalida al publicar o deshabilitar en este
 * proceso. Si la consulta falla (por ejemplo, sin la migración), queda el último conjunto conocido y
 * las tiendas siguen como antes.
 */

let publicados = new Set<string>()

export function esSitioDePaginas(slug: string | null | undefined): boolean {
  return !!slug && publicados.has(slug)
}

export function marcarPublicado(slug: string) {
  publicados.add(slug)
}

export function marcarDespublicado(slug: string) {
  publicados.delete(slug)
}

/** Sólo para tests. */
export function fijarPublicados(slugs: string[]) {
  publicados = new Set(slugs)
}

export async function refrescarPublicados(db: MySql2Database) {
  try {
    const filas = await db
      .select({ slug: sitioTienda.slug })
      .from(sitioTienda)
      .where(and(eq(sitioTienda.estado, 'activo'), isNotNull(sitioTienda.versionPublicadaId)))
    publicados = new Set(filas.map((f) => f.slug))
  } catch {
    // Sin tabla o sin base: se conserva el último conjunto conocido.
  }
}

export function iniciarCacheSitios(getDb: () => MySql2Database) {
  void refrescarPublicados(getDb())
  return setInterval(() => void refrescarPublicados(getDb()), 60_000)
}

/**
 * Caminos que puede llamar un sitio de Páginas. Se evalúa por path (también en el preflight, donde
 * el método es OPTIONS); con o sin el prefijo `/api`.
 */
export function paginasApiPath(path: string): boolean {
  const ruta = path.startsWith('/api/') ? path.slice(4) : path
  return (
    /^\/public\/restaurante\/id\/\d+$/.test(ruta) ||
    /^\/public\/restaurante\/[a-z0-9-]+$/i.test(ruta) ||
    /^\/public\/marketing\/campanas\/[^/]+\/[^/]+$/.test(ruta) ||
    /^\/public\/marketing\/recetas\/[^/]+\/[^/]+$/.test(ruta) ||
    ruta === '/public/marketing/events' ||
    ruta === '/public/carritos' ||
    /^\/public\/carritos\/[A-Za-z0-9_-]+$/.test(ruta)
  )
}
