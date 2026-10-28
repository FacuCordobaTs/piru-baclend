import { esAsset } from './sitios-reglas'

/** Ajustes del sitio (título, descripción, imagen OG, ícono y colores), como se guardan. */
export type MetaSitio = {
  titulo?: string
  descripcion?: string
  /** Path de un asset del sitio (`assets/og.jpg`). */
  ogImage?: string
  icono?: string
  themeColor?: string
  loadingBackground?: string
}

const color = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined)
export const corto = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)

export function normalizarMeta(bruto: unknown): MetaSitio {
  if (!bruto || typeof bruto !== 'object') return {}
  const m = bruto as Record<string, unknown>
  const asset = (v: unknown) => (typeof v === 'string' && esAsset(v) && /\.(png|jpe?g|webp|avif|gif|svg)$/i.test(v) ? v : undefined)
  const meta: MetaSitio = {
    titulo: corto(m.titulo, 80),
    descripcion: corto(m.descripcion, 200),
    ogImage: asset(m.ogImage),
    icono: asset(m.icono),
    themeColor: color(m.themeColor),
    loadingBackground: color(m.loadingBackground),
  }
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) as MetaSitio
}

