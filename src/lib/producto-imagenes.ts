/**
 * Galería opcional de un producto: `producto.imagenUrl` sigue siendo la portada (la que usan la
 * tarjeta, el carrito, el POS y las campañas) y `producto.imagenes_extra` guarda, en orden, las
 * fotos adicionales que la tienda muestra en el detalle.
 *
 * Sin imports de DB ni de red: la subida a R2 se inyecta (`guardar`) para poder cubrir las reglas
 * con tests (src/lib/producto-imagenes.test.ts).
 */

/** Fotos adicionales por producto, además de la portada. */
export const MAX_IMAGENES_EXTRA = 5

const MAX_BYTES_IMAGEN = 5 * 1024 * 1024
const MIME_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg']

/** Lee la columna JSON (puede llegar como string o ya parseada) y descarta lo que no sea URL. */
export function leerImagenesExtra(raw: unknown): string[] {
  let valor = raw
  if (typeof valor === 'string') {
    try { valor = JSON.parse(valor) } catch { return [] }
  }
  if (!Array.isArray(valor)) return []
  return valor.filter((u): u is string => typeof u === 'string' && u.length > 0)
}

/** `null` si el data URL es una imagen aceptada; si no, el motivo del rechazo. */
export function errorImagenDataUrl(dataUrl: string): string | null {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s)
  if (!match) return 'Formato de imagen inválido'
  if (!MIME_PERMITIDOS.includes(match[1])) return 'Sólo se permiten imágenes JPG, PNG o WebP'
  // Tamaño decodificado sin decodificar: cada 4 caracteres base64 son 3 bytes.
  const base64 = match[2]
  const relleno = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  if ((base64.length * 3) / 4 - relleno > MAX_BYTES_IMAGEN) return 'Cada imagen puede pesar hasta 5MB'
  return null
}

export interface ImagenesPrevias {
  imagenUrl: string | null
  imagenesExtra: string[]
}

export interface CambioImagenes {
  /** Portada nueva, `null` para quitarla, `undefined` si no cambia. */
  imagenUrl: string | null | undefined
  /** Lista final de extras, `undefined` si no cambia. */
  imagenesExtra: string[] | undefined
  /** Extras que dejaron de usarse: se borran de R2 recién después de confirmar en DB. */
  huerfanas: string[]
}

/**
 * Resuelve lo que manda el admin. Cada entrada es un data URL (se sube) o una URL que el producto
 * ya tenía como portada o extra (se conserva; así se puede reordenar o promover una extra a
 * portada). Una URL ajena se ignora: no se puede apuntar el producto a cualquier archivo.
 */
export async function resolverImagenesProducto(
  entrada: { image?: string; eliminarImagen?: boolean; imagenesExtra?: string[] },
  previas: ImagenesPrevias,
  guardar: (dataUrl: string) => Promise<string>,
): Promise<CambioImagenes> {
  const conocidas = new Set([previas.imagenUrl, ...previas.imagenesExtra].filter((u): u is string => !!u))
  const resolver = async (img: string): Promise<string | null> => {
    if (img.startsWith('data:')) return guardar(img)
    return conocidas.has(img) ? img : null
  }

  let imagenUrl: string | null | undefined
  if (entrada.image) imagenUrl = (await resolver(entrada.image)) ?? undefined
  else if (entrada.eliminarImagen) imagenUrl = null
  const portadaFinal = imagenUrl === undefined ? previas.imagenUrl : imagenUrl

  let extras = previas.imagenesExtra
  if (entrada.imagenesExtra) {
    extras = []
    // +1: la lista puede repetir la portada (se filtra abajo) sin subir de más.
    for (const img of entrada.imagenesExtra.slice(0, MAX_IMAGENES_EXTRA + 1)) {
      const url = await resolver(img)
      if (url) extras.push(url)
    }
  }
  extras = [...new Set(extras)].filter(u => u !== portadaFinal).slice(0, MAX_IMAGENES_EXTRA)

  const cambiaron = extras.length !== previas.imagenesExtra.length
    || extras.some((u, i) => u !== previas.imagenesExtra[i])
  const enUso = new Set([portadaFinal, ...extras])
  return {
    imagenUrl,
    imagenesExtra: cambiaron ? extras : undefined,
    huerfanas: previas.imagenesExtra.filter(u => !enUso.has(u)),
  }
}
