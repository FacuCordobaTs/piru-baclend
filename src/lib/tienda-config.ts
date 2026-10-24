/** Contrato público de la tienda. Todo es opcional; la plantilla por defecto la elige el cliente. */
import { errorImagenDataUrl } from './producto-imagenes'

export interface TiendaConfig {
  plantilla?: 'elegante' | 'moderna' | 'artesanal'
  colores?: { fondo?: string; texto?: string; acento?: string; superficie?: string }
  fuentes?: { titulos?: string; cuerpo?: string; cssUrl?: string; pesoTitulos?: number }
  frase?: string
  bajada?: string
  portadaUrl?: string
  galeria?: string[]
  cinta?: string[]
  historia?: { titulo?: string; texto?: string }
  instagram?: string
  whatsapp?: string
}

type Objeto = Record<string, unknown>
const objeto = (v: unknown): Objeto => v && typeof v === 'object' && !Array.isArray(v) ? v as Objeto : {}
export function objetoTienda(raw: unknown): Objeto {
  if (typeof raw === 'string') {
    try { return objeto(JSON.parse(raw)) } catch { return {} }
  }
  return objeto(raw)
}
const texto = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
const url = (v: unknown) => typeof v === 'string' && /^(https:\/\/|\/(?!\/))/i.test(v.trim()) ? v.trim() : undefined
const familia = (v: unknown) => { const s = texto(v, 60); return s && /^[\p{L}\p{N} ]+$/u.test(s) ? s : undefined }
const color = (v: unknown) => typeof v === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(v.trim()) ? v.trim() : undefined
const compacto = <T>(v: T): T => JSON.parse(JSON.stringify(v))

/** Sólo guarda claves conocidas y valores válidos, igual que web/src/lib/tienda.ts. */
export function normalizarTienda(raw: unknown): TiendaConfig | null {
  const t = objetoTienda(raw), c = objeto(t.colores), f = objeto(t.fuentes), h = objeto(t.historia)
  const config: TiendaConfig = {}
  if (typeof t.plantilla === 'string' && ['elegante', 'moderna', 'artesanal'].includes(t.plantilla)) config.plantilla = t.plantilla as TiendaConfig['plantilla']
  const colores = compacto({ fondo: color(c.fondo), texto: color(c.texto), acento: color(c.acento), superficie: color(c.superficie) })
  if (Object.keys(colores).length) config.colores = colores
  const peso = Number(f.pesoTitulos)
  const fuentes = compacto({ titulos: familia(f.titulos), cuerpo: familia(f.cuerpo),
    cssUrl: typeof f.cssUrl === 'string' && /^https:\/\//.test(f.cssUrl.trim()) ? f.cssUrl.trim() : undefined,
    pesoTitulos: Number.isFinite(peso) && peso >= 100 && peso <= 900 ? peso : undefined })
  if (Object.keys(fuentes).length) config.fuentes = fuentes
  config.frase = texto(t.frase, 90)
  config.bajada = texto(t.bajada, 220)
  config.portadaUrl = url(t.portadaUrl)
  const galeria = Array.isArray(t.galeria) ? t.galeria.map(url).filter((v): v is string => !!v).slice(0, 8) : []
  if (galeria.length) config.galeria = galeria
  const cinta = Array.isArray(t.cinta) ? t.cinta.map(v => texto(v, 40)).filter((v): v is string => !!v).slice(0, 10) : []
  if (cinta.length) config.cinta = cinta
  const historia = compacto({ titulo: texto(h.titulo, 80), texto: texto(h.texto, 1200) })
  if (Object.keys(historia).length) config.historia = historia
  config.instagram = texto(t.instagram, 60)?.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/$/, '') || undefined
  config.whatsapp = texto(t.whatsapp, 30)?.replace(/\D/g, '') || undefined
  const limpio = compacto(config)
  return Object.keys(limpio).length ? limpio : null
}

export class ImagenTiendaInvalida extends Error {}
const fotos = (t: TiendaConfig | null) => [t?.portadaUrl, ...(t?.galeria ?? [])].filter((v): v is string => !!v)

/** Sube antes de guardar; borra las fotos retiradas sólo después del commit. Si falla, limpia las nuevas. */
export async function actualizarTienda(
  entrada: unknown,
  previa: unknown,
  imagenes: { guardar: (data: string) => Promise<string>; borrar: (url: string) => Promise<void> },
  persistir: (config: TiendaConfig | null) => Promise<unknown>,
): Promise<TiendaConfig | null> {
  const t = { ...objetoTienda(entrada) }
  if (Array.isArray(t.galeria)) t.galeria = t.galeria.filter(v => url(v) || (typeof v === 'string' && v.startsWith('data:'))).slice(0, 8)
  const candidatas = [t.portadaUrl, ...(Array.isArray(t.galeria) ? t.galeria : [])]
  for (const v of candidatas) {
    if (typeof v === 'string' && v.startsWith('data:')) {
      const error = errorImagenDataUrl(v)
      if (error) throw new ImagenTiendaInvalida(error)
      const base64 = v.slice(v.indexOf(',') + 1)
      if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new ImagenTiendaInvalida('Formato de imagen inválido')
    }
  }
  const nuevas = new Map<string, string>()
  const borrar = async (urls: string[]) => {
    // El adaptador sólo permite borrar archivos del restaurante autenticado.
    await Promise.allSettled(urls.map(u => imagenes.borrar(u)))
  }
  const resolver = async (v: unknown) => {
    if (typeof v !== 'string' || !v.startsWith('data:')) return v
    if (!nuevas.has(v)) nuevas.set(v, await imagenes.guardar(v))
    return nuevas.get(v)
  }
  let config: TiendaConfig | null
  try {
    t.portadaUrl = await resolver(t.portadaUrl)
    if (Array.isArray(t.galeria)) {
      const galeria = []
      for (const v of t.galeria.slice(0, 8)) galeria.push(await resolver(v))
      t.galeria = galeria
    }
    config = normalizarTienda(t)
    await persistir(config)
  } catch (error) {
    await borrar([...nuevas.values()])
    throw error
  }
  const enUso = new Set(fotos(config))
  await borrar([...new Set(fotos(normalizarTienda(previa)))].filter(u => !enUso.has(u)))
  return config
}
