/** Formato público de los píxeles de Meta del local (hoy "Dataset ID").
 * Es un número de 15 o 16 dígitos y se guarda como texto para no perder ceros. */
const META_PIXEL_ID = /^\d{15,16}$/

export function normalizarMetaPixelId(value: string | null | undefined): string | null {
  if (value == null) return null
  const normalizado = value.trim()
  return normalizado === '' ? null : normalizado
}

export function esMetaPixelIdValido(value: string | null | undefined): boolean {
  const normalizado = normalizarMetaPixelId(value)
  return normalizado === null || META_PIXEL_ID.test(normalizado)
}
