/** Denegar por omisión: el token delegado nunca habilita la operación del dueño. */
export function marketerPuede(metodo: string, ruta: string): boolean {
  const method = metodo.toUpperCase()
  const path = ruta.split('?')[0].replace(/\/+$/, '')
  // Rechazar paths ambiguos en lugar de normalizarlos a un endpoint autorizado.
  if (!path.startsWith('/api/') || /%|\\|\/\/|\/(?:\.|\.\.)(?:\/|$)/.test(path))
    return false
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false
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

export function marketerPuedeSocketAdmin(decoded: {
  id?: unknown
  scope?: unknown
  marketerId?: unknown
}): boolean {
  return (
    Number.isInteger(decoded.id) &&
    Number(decoded.id) > 0 &&
    decoded.scope !== 'marketer' &&
    decoded.marketerId === undefined
  )
}
