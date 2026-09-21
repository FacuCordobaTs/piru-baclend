/**
 * Lógica pura de la tienda de indumentaria (ver docs/ORDERS.md).
 *
 * Sin imports de DB ni de red a propósito: el cálculo de totales y la validación de
 * talle/color son las dos reglas que no queremos que se rompan cuando alguien toque el
 * router, así que viven acá y se cubren con tests unitarios (src/lib/ropa.test.ts).
 */

export interface RopaColor {
  nombre: string
  hex: string
}

export interface RopaProductoRow {
  id: number
  nombre: string
  precio: string | number
  imagenes: unknown
  talles: unknown
  colores: unknown
  stock: number | null
  activo: boolean
}

export interface ItemPedidoSolicitado {
  productoId: number
  talle: string | null
  colorNombre: string | null
  cantidad: number
}

export interface ItemPedidoCalculado {
  productoId: number
  nombreProducto: string
  imagenUrl: string | null
  talle: string | null
  colorNombre: string | null
  colorHex: string | null
  cantidad: number
  precioUnitario: number
}

/** Los JSON de MySQL llegan como string o ya parseados según el driver; normalizamos siempre. */
export function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return []
}

export function leerImagenes(raw: unknown): string[] {
  return parseJsonArray<string>(raw).filter((u) => typeof u === 'string' && u.length > 0)
}

export function leerTalles(raw: unknown): string[] {
  return parseJsonArray<string>(raw).filter((t) => typeof t === 'string' && t.length > 0)
}

export function leerColores(raw: unknown): RopaColor[] {
  return parseJsonArray<unknown>(raw)
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .map((c) => ({
      nombre: String(c.nombre ?? '').trim(),
      hex: String(c.hex ?? '').trim(),
    }))
    .filter((c) => c.nombre.length > 0)
}

/**
 * Valida que el talle y el color elegidos existan en el producto.
 * Devuelve el motivo del rechazo, o `null` si la combinación es válida.
 *
 * Se corre en el servidor además de en la UI: el talle y el color llegan en el body
 * del pedido y no se puede confiar en que el cliente haya elegido de la lista real.
 */
export function validarVariante(
  producto: Pick<RopaProductoRow, 'nombre' | 'talles' | 'colores'>,
  talle: string | null | undefined,
  colorNombre: string | null | undefined,
): string | null {
  const talles = leerTalles(producto.talles)
  if (talles.length > 0) {
    if (!talle || !talles.includes(talle)) {
      return `Talle inválido para "${producto.nombre}": se esperaba uno de ${talles.join(', ')}`
    }
  }

  const colores = leerColores(producto.colores)
  if (colores.length > 0) {
    if (!colorNombre || !colores.some((c) => c.nombre === colorNombre)) {
      return `Color inválido para "${producto.nombre}": se esperaba uno de ${colores.map((c) => c.nombre).join(', ')}`
    }
  }

  return null
}

/** Resuelve el hex del color elegido, o `null` si el producto no maneja colores. */
export function hexDeColor(producto: Pick<RopaProductoRow, 'colores'>, colorNombre: string | null): string | null {
  if (!colorNombre) return null
  return leerColores(producto.colores).find((c) => c.nombre === colorNombre)?.hex ?? null
}

export interface TotalesRopa {
  subtotal: number
  costoEnvio: number
  total: number
}

/**
 * Calcula subtotal, costo de envío y total a partir de los ítems ya resueltos contra la DB.
 *
 * Todo en centavos antes de volver a pesos para evitar los errores de coma flotante de
 * sumar precios decimales (0.1 + 0.2). Los precios vienen de MySQL como string decimal,
 * así que se redondean a centavos al entrar.
 */
export function calcularTotales(
  items: ReadonlyArray<Pick<ItemPedidoCalculado, 'cantidad' | 'precioUnitario'>>,
  tipoEntrega: 'retiro' | 'envio',
  costoEnvioConfigurado: number,
): TotalesRopa {
  const enCentavos = (n: number) => Math.round((Number(n) || 0) * 100)

  const subtotalCentavos = items.reduce(
    (acc, item) => acc + enCentavos(item.precioUnitario) * (Number(item.cantidad) || 0),
    0,
  )

  // El envío sólo se cobra en modalidad "envio", y nunca si el costo configurado es 0 o negativo.
  const envioCentavos =
    tipoEntrega === 'envio' ? Math.max(0, enCentavos(costoEnvioConfigurado)) : 0

  return {
    subtotal: subtotalCentavos / 100,
    costoEnvio: envioCentavos / 100,
    total: (subtotalCentavos + envioCentavos) / 100,
  }
}
