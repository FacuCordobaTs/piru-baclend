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

/** Denegar por omisión: el token delegado nunca habilita la operación del dueño. */
export function marketerPuede(metodo: string, ruta: string): boolean {
  const verificable = rutaVerificable(metodo, ruta)
  if (!verificable) return false
  const { method, path } = verificable
  if (
    method === 'GET' &&
    [
      '/api/modulos/catalogo',
      '/api/modulos/mis-modulos',
      '/api/metricas',
      '/api/producto',
      '/api/categoria',
    ].includes(path)
  )
    return true
  if (method === 'PUT' && /^\/api\/modulos\/[^/]+\/activar$/.test(path))
    return true
  if (
    method === 'POST' &&
    /^\/api\/modulos\/[^/]+\/pago-link-whatsapp$/.test(path)
  )
    return true
  if (path === '/api/clientes/indice-pos') return false
  if (
    method === 'DELETE' &&
    (/^\/api\/clientes\/[^/]+$/.test(path) ||
      /^\/api\/clientes\/[^/]+\/pedidos\/[^/]+$/.test(path))
  )
    return false
  return /^\/api\/(clientes|marketing|codigo-descuento|puntos)(?:\/|$)/.test(
    path,
  )
}

/**
 * Sesión del dueño en la app de marketers (entra desde Clientes del panel, sin login): la misma
 * superficie que el marketer, porque la app no llama nada más, y lo que sólo le toca al dueño:
 * leer su tarjeta y sus sucursales, pagar un módulo (el marketer sólo puede pedirle el link) y
 * borrar clientes o pedidos de su historial, como hacía en Clientes del panel.
 * Es su local, pero la sesión vive en otra app: el resto se sigue manejando desde el panel.
 */
export function duenioAppMarketingPuede(metodo: string, ruta: string): boolean {
  if (marketerPuede(metodo, ruta)) return true
  const verificable = rutaVerificable(metodo, ruta)
  if (!verificable) return false
  const { method, path } = verificable
  if (
    method === 'GET' &&
    ['/api/marketing-duenio/local', '/api/marketing-duenio/sucursales'].includes(
      path,
    )
  )
    return true
  if (
    method === 'DELETE' &&
    (/^\/api\/clientes\/\d+$/.test(path) ||
      /^\/api\/clientes\/\d+\/pedidos\/\d+$/.test(path))
  )
    return true
  return method === 'POST' && /^\/api\/modulos\/[^/]+\/checkout$/.test(path)
}

export function marketerPuedeSocketAdmin(decoded: {
  id?: unknown
  scope?: unknown
  marketerId?: unknown
  appMarketing?: unknown
}): boolean {
  return (
    Number.isInteger(decoded.id) &&
    Number(decoded.id) > 0 &&
    decoded.scope !== 'marketer' &&
    decoded.marketerId === undefined &&
    // La sesión del dueño en la app de marketers tampoco es el feed de pedidos del panel.
    decoded.appMarketing === undefined
  )
}
