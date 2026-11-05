/** Método y path verificables, o `null` si el request es ambiguo. */
function rutaVerificable(metodo: string, ruta: string) {
  const method = metodo.toUpperCase()
  const path = ruta.split('?')[0].replace(/\/+$/, '')
  // Rechazar paths ambiguos en lugar de normalizarlos a un endpoint autorizado.
  if (!path.startsWith('/api/') || /%|\\|\/\/|\/(?:\.|\.\.)(?:\/|$)/.test(path))
    return null
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null
  return { method, path }
}

/**
 * Sesión del dueño en Páginas (`pages.piru.app`, docs/PAGINAS_PROPIAS.md): sólo `/sitios/*`.
 * `/sitios/entrada` queda afuera: los pases salen únicamente de la sesión del panel.
 */
export function sitiosPuede(metodo: string, ruta: string): boolean {
  const verificable = rutaVerificable(metodo, ruta)
  if (!verificable) return false
  const { path } = verificable
  if (path === '/api/sitios/entrada' || path === '/api/sitios/sesion') return false
  return /^\/api\/sitios(?:\/|$)/.test(path)
}

/**
 * Tokens que firmaba el canal de marketers, ya retirado (el token de cartera, la llave de local
 * delegada y la sesión del dueño en la app de marketing). Pueden seguir sin vencer: se rechazan
 * para que nunca valgan como la sesión completa del dueño.
 */
export function esTokenRetirado(decoded: {
  scope?: unknown
  marketerId?: unknown
  appMarketing?: unknown
}): boolean {
  return (
    decoded.scope === 'marketer' ||
    decoded.marketerId !== undefined ||
    decoded.appMarketing !== undefined
  )
}

/** El feed de pedidos del panel (`/ws/admin`) sólo lo abre la sesión del panel o la de la demo. */
export function puedeSocketAdmin(decoded: {
  id?: unknown
  scope?: unknown
  marketerId?: unknown
  appMarketing?: unknown
  appSitios?: unknown
}): boolean {
  return (
    Number.isInteger(decoded.id) &&
    Number(decoded.id) > 0 &&
    !esTokenRetirado(decoded) &&
    // Ni la sesión de Páginas.
    decoded.appSitios === undefined
  )
}
