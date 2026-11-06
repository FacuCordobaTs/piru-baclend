import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

/**
 * Fotos de producto que llegan desde una URL externa (importación de carta en JSON).
 * Se guardan bajo un prefijo por local y se devuelve la URL pública de R2.
 *
 * `producto.ts` sigue usando su `saveImage` para los data URLs del admin; este helper
 * es sólo para el flujo de importación y comparte las mismas variables de entorno.
 */
export async function guardarImagenProductoImportada(
  restauranteId: number,
  contenido: Buffer,
  mime: 'image/jpeg' | 'image/png' | 'image/webp',
): Promise<string> {
  const base = process.env.R2_PUBLIC_URL?.replace(/\/$/, '')
  if (!base?.startsWith('https://')) throw new Error('Falta configurar R2_PUBLIC_URL')
  if (!process.env.R2_BUCKET_NAME) throw new Error('Falta configurar R2_BUCKET_NAME')

  const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]
  const key = `productos/${restauranteId}/${crypto.randomUUID()}.${extension}`
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })

  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: contenido,
    ContentType: mime,
    CacheControl: 'public, max-age=31536000, immutable',
  }))

  return `${base}/${key}`
}

/** `true` si la URL ya es una foto de producto de este local en R2. */
export function esImagenProductoPropia(restauranteId: number, url: string): boolean {
  const base = process.env.R2_PUBLIC_URL?.replace(/\/$/, '')
  return !!base && url.startsWith(`${base}/productos/${restauranteId}/`)
}
