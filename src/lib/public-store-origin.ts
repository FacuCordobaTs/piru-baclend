/**
 * Orígenes de tiendas propias (`<tienda>.piru.app`) para CORS.
 *
 * Es el equivalente a `lib/public-event-origin.ts` de Crow. El navegador de una tienda llama a la
 * API desde su subdominio; se habilitan sólo los caminos públicos y de pago que ya usa la tienda de
 * `my.piru.app`. La autorización real sigue en cada endpoint.
 *
 * La lista de nombres reservados y la validación del label están duplicadas a propósito en
 * `web/src/lib/store-domain.ts` (el Worker no puede importar código del backend). Si cambian, cambian
 * las dos y sus tests.
 */
const RESERVED = new Set([
  'www',
  'admin',
  'api',
  'mail',
  'smtp',
  'imap',
  'pop',
  'ftp',
  'cdn',
  'assets',
  'static',
  'status',
  'support',
  'docs',
  'autodiscover',
  'autoconfig',
  'dev',
  'staging',
  'my',
  'info',
  'marketing',
  'mozos',
  'interno',
  'images',
  'app',
  'panel',
  'pagos',
  'pago',
  // Páginas propias (docs/PAGINAS_PROPIAS.md): el editor y rutas de plataforma.
  'pages',
  'paginas',
  'sitios',
  'checkout',
  'blog',
  'ayuda',
  'soporte',
])

export function isStoreSubdomain(slug: string): boolean {
  return (
    slug.length >= 2 &&
    slug.length <= 63 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
    !RESERVED.has(slug)
  )
}

/** Slug de tienda para un hostname de producción, o `null` si es infraestructura o no es un subdominio. */
export function storeSlugFromHostname(hostname: string): string | null {
  const host = hostname.toLowerCase()
  if (!host.endsWith('.piru.app')) return null
  const slug = host.slice(0, -'.piru.app'.length)
  return isStoreSubdomain(slug) ? slug : null
}

/** Un origen `https://<tienda>.piru.app` exacto, sin puerto, ruta ni credenciales. */
export function publicStoreOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.origin === origin &&
      url.hostname.endsWith('.piru.app') &&
      storeSlugFromHostname(url.hostname) !== null
    )
  } catch {
    return false
  }
}

const RUTAS_DE_PAGO = new Set(['/mp/process-brick', '/mp/crear-preferencia-externo'])

/**
 * Caminos que puede llamar el navegador de una tienda propia. Hono puede ver la ruta con o sin el
 * prefijo `/api` según el proxy de producción; se aceptan las dos formas.
 */
export function publicStoreApiPath(path: string): boolean {
  const ruta = path.startsWith('/api/') ? path.slice(4) : path
  return ruta.startsWith('/public/') || RUTAS_DE_PAGO.has(ruta)
}
