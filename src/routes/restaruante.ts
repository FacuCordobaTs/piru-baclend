import { Hono } from 'hono'
import { pool } from '../db'
import { restaurante as RestauranteTable, mesa as MesaTable, producto as ProductoTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3"
import UUID = require("uuid-js")

// Configuración de R2
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, '')

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID!,
    secretAccessKey: R2_SECRET_ACCESS_KEY!,
  },
})

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/jpg"]

async function saveImage(base64String: string): Promise<string> {
  const match = base64String.match(/^data:(image\/\w+);base64,/)
  if (!match) {
    throw new Error('Formato de base64 inválido')
  }
  const mimeType = match[1]
  const fileExtension = mimeType.split('/')[1] || 'png'

  const base64Data = base64String.replace(/^data:image\/\w+;base64,/, "")
  const buffer = Buffer.from(base64Data, "base64")

  const uuid = UUID.create().toString()
  const fileName = `restaurantes/${uuid}.${fileExtension}`

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: fileName,
    Body: buffer,
    ContentType: mimeType,
  })

  try {
    await s3Client.send(command)
    const publicUrl = `${R2_PUBLIC_URL}/${fileName}`
    console.log(`Imagen de restaurante guardada en R2: ${publicUrl}`)
    return publicUrl
  } catch (error) {
    console.error(`Error al subir imagen a R2:`, error)
    throw new Error("Error al guardar la imagen")
  }
}

async function deleteImage(imageUrl: string): Promise<void> {
  if (!imageUrl || !R2_PUBLIC_URL || !imageUrl.startsWith(R2_PUBLIC_URL)) {
    return
  }
  try {
    const urlObject = new URL(imageUrl)
    const key = urlObject.pathname.substring(1)
    if (!key) return

    const command = new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    })

    await s3Client.send(command)
    console.log(`Imagen eliminada de R2: ${key}`)
  } catch (error: any) {
    console.error(`Error al eliminar imagen de R2:`, error)
  }
}

const restauranteRoute = new Hono()

restauranteRoute.use('*', authMiddleware)

const completeProfileSchema = z.object({
  nombre: z.string().min(3),
  direccion: z.string().min(3),
  telefono: z.string().min(3),
  imagenUrl: z.string().min(3),
})

const updateProfileSchema = z.object({
  nombre: z.string().min(3).optional(),
  direccion: z.string().min(1).optional(),
  telefono: z.string().min(1).optional(),
  image: z.string().min(10).optional(), // Base64 de la imagen
})

restauranteRoute.get('/profile', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const restaurante = await db.select().from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId))
  const mesas = await db.select().from(MesaTable).where(eq(MesaTable.restauranteId, restauranteId))
  // Obtener TODOS los productos (activos e inactivos) para el admin
  const productos = await db.select().from(ProductoTable).where(eq(ProductoTable.restauranteId, restauranteId))

  try {
    return c.json({ message: 'Profile retrieved successfully', success: true, data: { restaurante, mesas, productos } }, 200)
  } catch (error) {
    console.error('Error getting profile:', error)
    return c.json({ message: 'Error getting profile', error: (error as Error).message }, 500)
  }

})

restauranteRoute.post('/complete-profile', zValidator('json', completeProfileSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { nombre, direccion, telefono, imagenUrl } = c.req.valid('json')

  try {
    await db.update(RestauranteTable).set({ nombre, direccion, telefono, imagenUrl }).where(eq(RestauranteTable.id, restauranteId))
    return c.json({ message: 'Profile completed successfully', success: true }, 200)

  } catch (error) {
    console.error('Error completing profile:', error)
    return c.json({ message: 'Error completing profile', error: (error as Error).message }, 500)
  }

})

// Actualizar perfil del restaurante
restauranteRoute.put('/update', zValidator('json', updateProfileSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { nombre, direccion, telefono, image } = c.req.valid('json')

  try {
    // Obtener datos actuales del restaurante
    const currentRestaurante = await db.select()
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)

    if (!currentRestaurante || currentRestaurante.length === 0) {
      return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
    }

    // Preparar datos a actualizar
    const updateData: { [key: string]: any } = {}

    if (nombre !== undefined) updateData.nombre = nombre
    if (direccion !== undefined) updateData.direccion = direccion
    if (telefono !== undefined) updateData.telefono = telefono

    // Procesar imagen si se proporciona
    if (image && image.startsWith('data:image')) {
      // Validar tipo MIME
      const mimeMatch = image.match(/^data:(image\/\w+);base64,/)
      if (mimeMatch) {
        const mimeType = mimeMatch[1]
        if (ALLOWED_MIME_TYPES.includes(mimeType)) {
          // Validar tamaño
          const base64Data = image.replace(/^data:image\/\w+;base64,/, "")
          const buffer = Buffer.from(base64Data, "base64")

          if (buffer.byteLength <= MAX_FILE_SIZE) {
            // Eliminar imagen anterior si existe
            if (currentRestaurante[0].imagenUrl) {
              await deleteImage(currentRestaurante[0].imagenUrl)
            }
            // Guardar nueva imagen
            updateData.imagenUrl = await saveImage(image)
          }
        }
      }
    }

    // Verificar que hay algo que actualizar
    if (Object.keys(updateData).length === 0) {
      return c.json({ message: 'No se proporcionaron datos para actualizar', success: false }, 400)
    }

    // Actualizar en la base de datos
    await db.update(RestauranteTable)
      .set(updateData)
      .where(eq(RestauranteTable.id, restauranteId))

    // Obtener datos actualizados
    const updatedRestaurante = await db.select()
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)

    return c.json({
      message: 'Perfil actualizado correctamente',
      success: true,
      data: updatedRestaurante[0]
    }, 200)

  } catch (error) {
    console.error('Error updating profile:', error)
    return c.json({ message: 'Error al actualizar perfil', error: (error as Error).message, success: false }, 500)
  }
})

// Toggle modo carrito
restauranteRoute.put('/toggle-carrito', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    // Obtener el estado actual
    const [restaurante] = await db.select({ esCarrito: RestauranteTable.esCarrito })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))

    if (!restaurante) {
      return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
    }

    // Toggle
    const nuevoEstado = !restaurante.esCarrito

    await db.update(RestauranteTable)
      .set({ esCarrito: nuevoEstado })
      .where(eq(RestauranteTable.id, restauranteId))

    console.log(`🛒 Modo carrito ${nuevoEstado ? 'activado' : 'desactivado'} para restaurante ${restauranteId}`)

    return c.json({
      message: nuevoEstado ? 'Modo carrito activado' : 'Modo restaurante activado',
      success: true,
      esCarrito: nuevoEstado
    }, 200)

  } catch (error) {
    console.error('Error updating carrito mode:', error)
    return c.json({ message: 'Error al cambiar modo carrito', error: (error as Error).message, success: false }, 500)
  }
})

export { restauranteRoute }