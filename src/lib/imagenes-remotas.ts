/**
 * Descarga de fotos de producto desde una URL externa (la que devuelve un LLM al armar
 * la carta en JSON). El onboarding las copia a R2 para que la tienda no dependa del
 * servidor de origen.
 *
 * Sin imports de DB ni de R2: sólo red, DNS y validación. La subida la hace el caller
 * (`producto-imagenes-r2.ts`) y las reglas puras se testean en `imagenes-remotas.test.ts`.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const MAX_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 3

export class ImagenRemotaInvalida extends Error {}

function ipv4Privada(ip: string): boolean {
  const partes = ip.split('.').map(Number)
  if (partes.length !== 4 || partes.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b, c] = partes
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24 y 192.0.2/24
    (a === 192 && b === 168) || // 192.168/16
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15
    (a === 198 && b === 51 && c === 100) || // 198.51.100/24
    (a === 203 && b === 0 && c === 113) || // 203.0.113/24
    a >= 224 // multicast y reservado
  )
}

/** Expande una IPv6 a 8 grupos de 16 bits. `null` si no se puede interpretar. */
function expandirIpv6(ip: string): number[] | null {
  let sinZona = ip.split('%')[0].toLowerCase()
  // IPv6 con IPv4 embebida al final: ::ffff:127.0.0.1
  const ultimoBloque = sinZona.slice(sinZona.lastIndexOf(':') + 1)
  if (ultimoBloque.includes('.')) {
    const v4 = ultimoBloque.split('.').map(Number)
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const hex = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]].map((n) => n.toString(16))
    sinZona = sinZona.slice(0, sinZona.lastIndexOf(':') + 1) + hex.join(':')
  }
  if (sinZona === '::') return Array(8).fill(0)
  const lados = sinZona.split('::')
  if (lados.length > 2) return null
  const izquierda = lados[0] ? lados[0].split(':') : []
  const derecha = lados.length === 2 && lados[1] ? lados[1].split(':') : []
  const faltan = 8 - izquierda.length - derecha.length
  if (faltan < 0) return null
  const grupos = [...izquierda, ...Array(faltan).fill('0'), ...derecha]
  if (grupos.length !== 8) return null
  const numeros = grupos.map((g) => Number.parseInt(g || '0', 16))
  return numeros.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? numeros : null
}

function ipv6Privada(ip: string): boolean {
  const g = expandirIpv6(ip)
  if (!g) return true
  const todosCero = g.every((n) => n === 0)
  const loopback = g.slice(0, 7).every((n) => n === 0) && g[7] === 1
  if (todosCero || loopback) return true

  // IPv4 mapeada / compatible: ::ffff:a.b.c.d o ::a.b.c.d
  const primerosSeisCero = g.slice(0, 5).every((n) => n === 0)
  if (primerosSeisCero) {
    const sexto = g[5]
    if (sexto === 0 || sexto === 0xffff) {
      const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.')
      return ipv4Privada(v4)
    }
  }

  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7 (unique local)
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10 (link-local)
  if ((g[0] & 0xff00) === 0xff00) return true // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentación
  return false
}

/** `true` si la IP no debe ser alcanzada desde el backend. Exportada para tests. */
export function ipPrivada(ip: string): boolean {
  const limpia = ip.replace(/^\[|\]$/g, '')
  const version = isIP(limpia)
  if (version === 4) return ipv4Privada(limpia)
  if (version === 6) return ipv6Privada(limpia)
  return true
}

async function validarDestino(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImagenRemotaInvalida('La URL de la imagen tiene que ser http o https')
  }
  if (url.username || url.password) throw new ImagenRemotaInvalida('La URL no puede llevar credenciales')
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new ImagenRemotaInvalida('La URL de la imagen usa un puerto no permitido')
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!host) throw new ImagenRemotaInvalida('La URL no tiene un host válido')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new ImagenRemotaInvalida('La URL apunta a una dirección interna')
  }

  if (isIP(host)) {
    if (ipPrivada(host)) throw new ImagenRemotaInvalida('La URL apunta a una dirección interna')
    return
  }

  let direcciones: { address: string }[]
  try {
    direcciones = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new ImagenRemotaInvalida('No se pudo resolver el dominio de la imagen')
  }
  if (direcciones.length === 0) throw new ImagenRemotaInvalida('No se pudo resolver el dominio de la imagen')
  if (direcciones.some((d) => ipPrivada(d.address))) {
    throw new ImagenRemotaInvalida('La URL apunta a una dirección interna')
  }
}

/** Firma real del archivo: no confiamos sólo en el Content-Type del servidor. */
export function mimePorFirma(contenido: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (contenido.length >= 3 && contenido[0] === 0xff && contenido[1] === 0xd8 && contenido[2] === 0xff) return 'image/jpeg'
  if (
    contenido.length >= 8 &&
    contenido[0] === 0x89 && contenido[1] === 0x50 && contenido[2] === 0x4e && contenido[3] === 0x47 &&
    contenido[4] === 0x0d && contenido[5] === 0x0a && contenido[6] === 0x1a && contenido[7] === 0x0a
  ) return 'image/png'
  if (
    contenido.length >= 12 &&
    contenido[0] === 0x52 && contenido[1] === 0x49 && contenido[2] === 0x46 && contenido[3] === 0x46 &&
    contenido[8] === 0x57 && contenido[9] === 0x45 && contenido[10] === 0x42 && contenido[11] === 0x50
  ) return 'image/webp'
  return null
}

async function leerConTope(respuesta: Response): Promise<Buffer> {
  if (!respuesta.body) throw new ImagenRemotaInvalida('La imagen vino vacía')
  const lector = respuesta.body.getReader()
  const partes: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await lector.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await lector.cancel().catch(() => {})
      throw new ImagenRemotaInvalida('La imagen supera los 5 MB')
    }
    partes.push(value)
  }
  return Buffer.concat(partes.map((p) => Buffer.from(p)))
}

export interface ImagenDescargada {
  contenido: Buffer
  mime: 'image/jpeg' | 'image/png' | 'image/webp'
  extension: 'jpg' | 'png' | 'webp'
}

/**
 * Descarga una imagen validando protocolo, destino (sin SSRF), redirects, tamaño y
 * formato real. Lanza `ImagenRemotaInvalida` con un mensaje apto para mostrar.
 */
export async function descargarImagenRemota(valor: string): Promise<ImagenDescargada> {
  let actual: URL
  try {
    actual = new URL(valor.trim())
  } catch {
    throw new ImagenRemotaInvalida('La URL de la imagen no es válida')
  }

  for (let salto = 0; salto <= MAX_REDIRECTS; salto++) {
    await validarDestino(actual)

    let respuesta: Response
    try {
      respuesta = await fetch(actual, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'image/*', 'User-Agent': 'Piru/1.0 (+https://piru.app)' },
      })
    } catch {
      throw new ImagenRemotaInvalida('No se pudo descargar la imagen')
    }

    if (respuesta.status >= 300 && respuesta.status < 400) {
      const location = respuesta.headers.get('location')
      if (!location) throw new ImagenRemotaInvalida('La imagen redirige a una URL inválida')
      if (salto === MAX_REDIRECTS) throw new ImagenRemotaInvalida('La imagen tiene demasiadas redirecciones')
      try {
        actual = new URL(location, actual)
      } catch {
        throw new ImagenRemotaInvalida('La imagen redirige a una URL inválida')
      }
      continue
    }

    if (!respuesta.ok) throw new ImagenRemotaInvalida(`El servidor de la imagen respondió ${respuesta.status}`)
    const largo = Number(respuesta.headers.get('content-length') || 0)
    if (largo > MAX_BYTES) throw new ImagenRemotaInvalida('La imagen supera los 5 MB')

    const contenido = await leerConTope(respuesta)
    const mime = mimePorFirma(contenido)
    if (!mime) throw new ImagenRemotaInvalida('El archivo no es una imagen JPG, PNG o WebP')
    return { contenido, mime, extension: mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] as 'png' | 'webp') }
  }

  throw new ImagenRemotaInvalida('No se pudo descargar la imagen')
}
