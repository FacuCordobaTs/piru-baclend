import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

/**
 * Dónde viven los sitios publicados (docs/PAGINAS_PROPIAS.md, sección 13):
 *
 * - R2 (bucket `R2_SITIOS_BUCKET`, por defecto `piru-sitios`): bundles, CSS y assets. Se escribe con
 *   las mismas credenciales S3 de las fotos (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
 *   `R2_SECRET_ACCESS_KEY`), que tienen que alcanzar a ese bucket.
 * - KV (`SITIOS_KV_NAMESPACE_ID`): el manifiesto `sitio:<slug>` que lee el Worker de `*.piru.app`.
 *   Se escribe por la API de Cloudflare con `CLOUDFLARE_ACCOUNT_ID` y `CLOUDFLARE_SITIOS_TOKEN`
 *   (token acotado a ese namespace y a la purga de caché de la zona `CLOUDFLARE_ZONE_ID`).
 *
 * El backend sólo escribe; el Worker sólo lee. La interfaz es inyectable para los tests.
 */

export type ManifiestoSitio = {
  versionId: number
  restauranteId: number
  username: string
  runtime: string
  bundle: string
  css: string | null
  meta: MetaPublicada
  status: 'activo'
}

/** Metadatos ya resueltos para el HTML: los assets son paths `/_piru/a/<sha>.<ext>`. */
export type MetaPublicada = {
  titulo: string
  descripcion: string
  ogImage: string | null
  icono: string | null
  themeColor: string | null
  loadingBackground: string | null
}

export interface AlmacenSitios {
  subir(key: string, cuerpo: Uint8Array | string, contentType: string): Promise<void>
  existe(key: string): Promise<boolean>
  leer(key: string): Promise<{ cuerpo: Uint8Array; contentType: string } | null>
  escribirManifiesto(slug: string, manifiesto: ManifiestoSitio): Promise<void>
  borrarManifiesto(slug: string): Promise<void>
  /** Best-effort: un error no deshace la publicación. */
  purgar(slug: string): Promise<void>
}

export class ErrorConfiguracionSitios extends Error {}

const bucket = () => process.env.R2_SITIOS_BUCKET || 'piru-sitios'

let s3: S3Client | null = null
function cliente() {
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY)
    throw new ErrorConfiguracionSitios('Falta configurar R2 para publicar sitios')
  s3 ??= new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  })
  return s3
}

async function api(path: string, init: RequestInit) {
  const cuenta = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_SITIOS_TOKEN
  if (!cuenta || !token) throw new ErrorConfiguracionSitios('Falta configurar Cloudflare para publicar sitios')
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cuenta}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`Cloudflare respondió ${res.status}`)
  return res
}

function namespace() {
  const id = process.env.SITIOS_KV_NAMESPACE_ID
  if (!id) throw new ErrorConfiguracionSitios('Falta configurar el namespace KV de sitios')
  return id
}

export const almacenCloudflare: AlmacenSitios = {
  async subir(key, cuerpo, contentType) {
    await cliente().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: typeof cuerpo === 'string' ? Buffer.from(cuerpo) : cuerpo,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    )
  },
  async existe(key) {
    try {
      await cliente().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
      return true
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false
      throw e
    }
  },
  async leer(key) {
    try {
      const res = await cliente().send(new GetObjectCommand({ Bucket: bucket(), Key: key }))
      if (!res.Body) return null
      return { cuerpo: await res.Body.transformToByteArray(), contentType: res.ContentType ?? 'application/octet-stream' }
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null
      throw e
    }
  },
  async escribirManifiesto(slug, manifiesto) {
    await api(`/storage/kv/namespaces/${namespace()}/values/${encodeURIComponent(`sitio:${slug}`)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manifiesto),
    })
  },
  async borrarManifiesto(slug) {
    await api(`/storage/kv/namespaces/${namespace()}/values/${encodeURIComponent(`sitio:${slug}`)}`, { method: 'DELETE' })
  },
  async purgar(slug) {
    const zona = process.env.CLOUDFLARE_ZONE_ID
    const token = process.env.CLOUDFLARE_SITIOS_TOKEN
    if (!zona || !token) return
    try {
      await fetch(`https://api.cloudflare.com/client/v4/zones/${zona}/purge_cache`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hosts: [`${slug}.piru.app`] }),
      })
    } catch {
      console.error('[sitios] No se pudo purgar la caché de', slug)
    }
  },
}

export const claveBundle = (username: string, hash: string, ext: 'js' | 'css') => `sitios/${username}/s/${hash}.${ext}`
export const claveAsset = (username: string, sha: string, ext: string) => `sitios/${username}/a/${sha}${ext}`
