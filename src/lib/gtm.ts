/** Formato público de los contenedores web de Google Tag Manager. */
const GTM_CONTAINER_ID = /^GTM-[A-Z0-9]{4,32}$/

export function normalizarGtmContainerId(value: string | null | undefined): string | null {
  if (value == null) return null
  const normalizado = value.trim().toUpperCase()
  return normalizado === '' ? null : normalizado
}

export function esGtmContainerIdValido(value: string | null | undefined): boolean {
  const normalizado = normalizarGtmContainerId(value)
  return normalizado === null || GTM_CONTAINER_ID.test(normalizado)
}
