/**
 * Reglas de los archivos de un sitio de Páginas (docs/PAGINAS_PROPIAS.md, secciones 5.1 y 12).
 *
 * Es puro: no lee la base ni el disco. Lo usan la API (al guardar el borrador y al publicar) y el
 * build. La misma lista está duplicada a propósito en `sitios/src/lib/build-rules.ts`, porque el editor
 * compila la vista previa en el navegador; `sitios-reglas.test.ts` compara las dos copias. Lo que
 * vale siempre es el build del servidor.
 */

export const RUNTIME_VERSION = 'v1'

/** Paquetes que el runtime ofrece como módulos compartidos (quedan *external* en el bundle). */
export const PAQUETES_RUNTIME = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'motion/react',
  'react-router',
  '@piru/tienda',
] as const

/** Paquetes que se compilan dentro del bundle del sitio (tree-shaking). */
export const PAQUETES_EMBEBIDOS = ['lucide-react'] as const

export const EXTENSIONES_CODIGO = ['.tsx', '.ts', '.css'] as const

export const TIPOS_ASSET: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export const LIMITES = {
  archivos: 50,
  /** Suma de los archivos de código, en bytes. */
  codigoBytes: 1_000_000,
  assets: 60,
  assetBytes: 8_000_000,
  /** Salida del build, comprimida con gzip. */
  jsGzipBytes: 300_000,
  cssGzipBytes: 100_000,
} as const

export type Borrador = Record<string, string>

export function extension(path: string): string {
  const punto = path.lastIndexOf('.')
  return punto < 0 ? '' : path.slice(punto).toLowerCase()
}

/**
 * Path relativo y canónico dentro del sitio: `page.tsx`, `components/Hero.tsx`, `assets/logo.png`.
 * Sin `..`, sin barras iniciales ni dobles, sin caracteres raros.
 */
export function pathValido(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 200 &&
    /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/.test(path) &&
    !path.split('/').some((parte) => parte === '.' || parte === '..')
  )
}

export function esCodigo(path: string): boolean {
  return (EXTENSIONES_CODIGO as readonly string[]).includes(extension(path))
}

export function esAsset(path: string): boolean {
  return path.startsWith('assets/') && Object.hasOwn(TIPOS_ASSET, extension(path))
}

export type ProblemaBorrador = { archivo?: string; mensaje: string }

/** Valida la forma del borrador guardado. Devuelve los problemas; vacío si está bien. */
export function validarBorrador(bruto: unknown): { borrador: Borrador; problemas: ProblemaBorrador[] } {
  const problemas: ProblemaBorrador[] = []
  const borrador: Borrador = {}
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) {
    return { borrador, problemas: [{ mensaje: 'El borrador tiene que ser un objeto { ruta: contenido }' }] }
  }
  const entradas = Object.entries(bruto as Record<string, unknown>)
  if (entradas.length > LIMITES.archivos)
    problemas.push({ mensaje: `Un sitio admite hasta ${LIMITES.archivos} archivos de código` })
  let total = 0
  for (const [path, contenido] of entradas) {
    if (!pathValido(path)) {
      problemas.push({ archivo: path, mensaje: 'Ruta inválida' })
      continue
    }
    if (!esCodigo(path)) {
      problemas.push({ archivo: path, mensaje: 'Sólo se admiten archivos .tsx, .ts y .css (los assets se suben aparte)' })
      continue
    }
    if (typeof contenido !== 'string') {
      problemas.push({ archivo: path, mensaje: 'El contenido tiene que ser texto' })
      continue
    }
    total += Buffer.byteLength(contenido)
    borrador[path] = contenido
  }
  if (total > LIMITES.codigoBytes) problemas.push({ mensaje: 'El código supera 1 MB' })
  return { borrador, problemas }
}

/** ¿Es un bare import permitido? `react`, `@piru/tienda`, `lucide-react`… */
export function importPermitido(especificador: string): boolean {
  return (
    (PAQUETES_RUNTIME as readonly string[]).includes(especificador) ||
    (PAQUETES_EMBEBIDOS as readonly string[]).includes(especificador)
  )
}

export function esImportRelativo(especificador: string): boolean {
  return especificador.startsWith('./') || especificador.startsWith('../')
}

/** Resuelve `./x` desde `components/a.tsx` a un path canónico del sitio, o `null` si sale del sitio. */
export function resolverRelativo(desde: string, especificador: string): string | null {
  const partes = desde.split('/').slice(0, -1)
  for (const parte of especificador.split('/')) {
    if (parte === '.' || parte === '') continue
    if (parte === '..') {
      if (!partes.length) return null
      partes.pop()
    } else partes.push(parte)
  }
  const path = partes.join('/')
  return pathValido(path) ? path : null
}

/** Busca el archivo de un import relativo sin extensión, como lo haría el bundler. */
export function encontrarArchivo(path: string, existe: (p: string) => boolean): string | null {
  if (existe(path)) return path
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) if (existe(path + ext)) return path + ext
  return null
}
