import { randomBytes } from 'node:crypto'

/**
 * Carrito de handoff entre un sitio de Páginas y el checkout de `my.piru.app`
 * (docs/PAGINAS_PROPIAS.md, sección 9.1). Es puro: valida y normaliza; la base la toca
 * `routes/carritos-publicos.ts`.
 *
 * No lleva precios, nombre, teléfono ni dirección: sólo IDs, cantidades, opciones y la nota que
 * escribe el comprador. El checkout lo vuelve a validar contra el catálogo real.
 */

export const CARRITO_TTL_MS = 2 * 60 * 60 * 1000
export const MAX_ITEMS = 50

export type ItemCarritoPublico = {
  productoId: number
  cantidad: number
  varianteId?: number
  varianteSecundariaId?: number
  agregados: number[]
  ingredientesExcluidos: number[]
  nota?: string
}

export type ContextoCarrito = {
  campaniaSlug?: string
  recetaToken?: string
  codigoPromocional?: string
  visitorId?: string
  sesionUuid?: string
}

const idPositivo = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0

const listaIds = (v: unknown): number[] | null => {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > 30 || !v.every(idPositivo)) return null
  return [...new Set(v as number[])]
}

const textoCorto = (v: unknown, max: number): string | undefined | null => {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') return null
  const limpio = v.trim()
  if (!limpio) return undefined
  return limpio.length > max ? null : limpio
}

export function validarItems(bruto: unknown): { items: ItemCarritoPublico[] } | { error: string } {
  if (!Array.isArray(bruto) || bruto.length === 0) return { error: 'El carrito está vacío' }
  if (bruto.length > MAX_ITEMS) return { error: `Un carrito admite hasta ${MAX_ITEMS} líneas` }
  const items: ItemCarritoPublico[] = []
  for (const [i, valor] of bruto.entries()) {
    if (!valor || typeof valor !== 'object') return { error: `Línea ${i + 1} inválida` }
    const v = valor as Record<string, unknown>
    if (!idPositivo(v.productoId)) return { error: `Línea ${i + 1}: producto inválido` }
    const cantidad = v.cantidad === undefined ? 1 : v.cantidad
    if (!Number.isSafeInteger(cantidad) || (cantidad as number) < 1 || (cantidad as number) > 99)
      return { error: `Línea ${i + 1}: cantidad inválida` }
    for (const campo of ['varianteId', 'varianteSecundariaId'] as const)
      if (v[campo] !== undefined && v[campo] !== null && !idPositivo(v[campo]))
        return { error: `Línea ${i + 1}: variante inválida` }
    const agregados = listaIds(v.agregados)
    const ingredientesExcluidos = listaIds(v.ingredientesExcluidos)
    if (!agregados || !ingredientesExcluidos) return { error: `Línea ${i + 1}: opciones inválidas` }
    const nota = textoCorto(v.nota, 300)
    if (nota === null) return { error: `Línea ${i + 1}: nota inválida` }
    items.push({
      productoId: v.productoId as number,
      cantidad: cantidad as number,
      ...(idPositivo(v.varianteId) ? { varianteId: v.varianteId } : {}),
      ...(idPositivo(v.varianteSecundariaId) ? { varianteSecundariaId: v.varianteSecundariaId } : {}),
      agregados,
      ingredientesExcluidos,
      ...(nota ? { nota } : {}),
    })
  }
  return { items }
}

/** Sólo los campos conocidos, cortos y como texto. Nada de PII. */
export function validarContexto(bruto: unknown): ContextoCarrito {
  if (!bruto || typeof bruto !== 'object') return {}
  const v = bruto as Record<string, unknown>
  const contexto: ContextoCarrito = {}
  const campos: [keyof ContextoCarrito, number][] = [
    ['campaniaSlug', 120],
    ['recetaToken', 200],
    ['codigoPromocional', 60],
    ['visitorId', 100],
    ['sesionUuid', 100],
  ]
  for (const [campo, max] of campos) {
    const texto = textoCorto(v[campo], max)
    if (texto && /^[\w.:-]+$/.test(texto)) contexto[campo] = texto
  }
  return contexto
}

/**
 * La vuelta al sitio: sólo el subdominio del mismo local o su tienda estándar. No es un open
 * redirect: otro host se descarta y el checkout vuelve a la tienda estándar.
 */
export function validarReturnUrl(bruto: unknown, username: string): string | null {
  if (typeof bruto !== 'string' || bruto.length > 500) return null
  let url: URL
  try {
    url = new URL(bruto)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null
  const user = username.toLowerCase()
  if (url.hostname === `${user}.piru.app`) return `${url.origin}${url.pathname}`
  if (url.hostname === 'my.piru.app' && (url.pathname === `/${user}` || url.pathname.startsWith(`/${user}/`)))
    return `${url.origin}${url.pathname}`
  return null
}

export function idCarrito(): string {
  return randomBytes(24).toString('base64url')
}

export const idCarritoValido = (id: string) => /^[A-Za-z0-9_-]{32}$/.test(id)

/** Límite simple por IP y ventana; en memoria del proceso. */
export function crearLimitador(maximo: number, ventanaMs: number) {
  const usos = new Map<string, { desde: number; cantidad: number }>()
  return (clave: string, ahora = Date.now()): boolean => {
    const uso = usos.get(clave)
    if (!uso || ahora - uso.desde > ventanaMs) {
      usos.set(clave, { desde: ahora, cantidad: 1 })
      if (usos.size > 10_000) for (const [k, u] of usos) if (ahora - u.desde > ventanaMs) usos.delete(k)
      return true
    }
    uso.cantidad += 1
    return uso.cantidad <= maximo
  }
}
