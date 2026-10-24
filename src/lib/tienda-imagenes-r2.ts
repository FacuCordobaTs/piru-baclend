import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'

/** Namespace por tenant: nunca se borran fotos de productos, logos u otros restaurantes. */
export function imagenesTienda(restauranteId: number) {
  const base = process.env.R2_PUBLIC_URL?.replace(/\/$/, '')
  const prefijo = `tiendas/${restauranteId}/`
  const client = new S3Client({
    region: 'auto', endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  })
  return {
    async guardar(data: string) {
      if (!base?.startsWith('https://')) throw new Error('Falta configurar la URL pública de imágenes')
      const [, mime, contenido] = data.match(/^data:([^;,]+);base64,(.*)$/s)!
      const key = `${prefijo}${crypto.randomUUID()}.${mime.split('/')[1]}`
      await client.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key, Body: Buffer.from(contenido, 'base64'), ContentType: mime }))
      return `${base}/${key}`
    },
    async borrar(url: string) {
      if (!base || !url.startsWith(`${base}/${prefijo}`)) return
      const key = url.slice(base.length + 1)
      if (!new RegExp(`^tiendas/${restauranteId}/[\\w-]+\\.(jpeg|jpg|png|webp)$`).test(key)) return
      await client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }))
    },
  }
}
