import { Hono } from 'hono'
import { pool } from '../db'
import { restaurante as RestauranteTable, mesa as MesaTable, producto as ProductoTable, categoria as CategoriaTable, etiqueta as EtiquetaTable, horarioRestaurante as HorarioRestauranteTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3"
import UUID = require("uuid-js")
import { configurarWebhookCliente } from '../services/cucuru'

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
  image: z.string().min(10).optional(), // Base64 de la imagen dark
  imageLight: z.string().min(10).optional(), // Base64 de la imagen light
  username: z.string().min(3).optional(),
  deliveryFee: z.string().optional(),
  whatsappEnabled: z.boolean().optional(),
  whatsappNumber: z.string().optional(),
  transferenciaAlias: z.string().optional(),
  colorPrimario: z.string().optional(),
  colorSecundario: z.string().optional(),
  disenoAlternativo: z.boolean().optional(),
})

restauranteRoute.get('/profile', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    const restaurante = await db.select().from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId))
    const mesas = await db.select().from(MesaTable).where(eq(MesaTable.restauranteId, restauranteId))

    // Obtener TODOS los productos (activos e inactivos) con categoría
    const productosRaw = await db
      .select({
        id: ProductoTable.id,
        restauranteId: ProductoTable.restauranteId,
        categoriaId: ProductoTable.categoriaId,
        nombre: ProductoTable.nombre,
        descripcion: ProductoTable.descripcion,
        precio: ProductoTable.precio,
        activo: ProductoTable.activo,
        imagenUrl: ProductoTable.imagenUrl,
        createdAt: ProductoTable.createdAt,
        categoriaNombre: CategoriaTable.nombre,
        descuento: ProductoTable.descuento,
      })
      .from(ProductoTable)
      .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
      .where(eq(ProductoTable.restauranteId, restauranteId))

    // Obtener todas las etiquetas del restaurante en una sola query
    const todasEtiquetas = await db
      .select({
        id: EtiquetaTable.id,
        nombre: EtiquetaTable.nombre,
        productoId: EtiquetaTable.productoId,
      })
      .from(EtiquetaTable)
      .where(eq(EtiquetaTable.restauranteId, restauranteId))

    // Agrupar etiquetas por productoId
    const etiquetasPorProducto = new Map<number, Array<{ id: number; nombre: string }>>()
    for (const et of todasEtiquetas) {
      if (!etiquetasPorProducto.has(et.productoId)) {
        etiquetasPorProducto.set(et.productoId, [])
      }
      etiquetasPorProducto.get(et.productoId)!.push({ id: et.id, nombre: et.nombre })
    }

    // Enriquecer productos con categoría y etiquetas
    const productos = productosRaw.map((p) => ({
      id: p.id,
      restauranteId: p.restauranteId,
      categoriaId: p.categoriaId,
      nombre: p.nombre,
      descripcion: p.descripcion,
      precio: p.precio,
      activo: p.activo,
      imagenUrl: p.imagenUrl,
      createdAt: p.createdAt,
      categoria: p.categoriaNombre || null,
      descuento: p.descuento,
      etiquetas: etiquetasPorProducto.get(p.id) || [],
    }))

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
  const { nombre, direccion, telefono, image, imageLight, username, deliveryFee, whatsappEnabled, whatsappNumber, transferenciaAlias, colorPrimario, colorSecundario, disenoAlternativo } = c.req.valid('json')

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
    if (deliveryFee !== undefined) updateData.deliveryFee = deliveryFee
    if (whatsappEnabled !== undefined) updateData.whatsappEnabled = whatsappEnabled
    if (whatsappNumber !== undefined) updateData.whatsappNumber = whatsappNumber
    if (transferenciaAlias !== undefined) updateData.transferenciaAlias = transferenciaAlias
    if (colorPrimario !== undefined) updateData.colorPrimario = colorPrimario
    if (colorSecundario !== undefined) updateData.colorSecundario = colorSecundario
    if (disenoAlternativo !== undefined) updateData.disenoAlternativo = disenoAlternativo
    if (username !== undefined) {
      if (!username || username.trim() === '') {
        updateData.username = null
      } else {
        const usernameRegex = /^[a-zA-Z0-9_-]+$/
        if (!usernameRegex.test(username)) {
          return c.json({ message: 'El alias solo puede contener letras, números, guiones y guiones bajos', success: false }, 400)
        }

        // Verifica que no exista otro restaurante con este username
        const existente = await db.select().from(RestauranteTable).where(and(eq(RestauranteTable.username, username), require('drizzle-orm').ne(RestauranteTable.id, restauranteId))).limit(1)
        if (existente && existente.length > 0) {
          return c.json({ message: 'El alias ya está en uso', success: false }, 400)
        }

        updateData.username = username
      }
    }

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

    // Procesar imagen light si se proporciona
    if (imageLight && imageLight.startsWith('data:image')) {
      const mimeMatchLight = imageLight.match(/^data:(image\/\w+);base64,/)
      if (mimeMatchLight) {
        const mimeTypeLight = mimeMatchLight[1]
        if (ALLOWED_MIME_TYPES.includes(mimeTypeLight)) {
          const base64DataLight = imageLight.replace(/^data:image\/\w+;base64,/, "")
          const bufferLight = Buffer.from(base64DataLight, "base64")
          if (bufferLight.byteLength <= MAX_FILE_SIZE) {
            // Eliminar imagen anterior si existe
            if (currentRestaurante[0].imagenLightUrl) {
              await deleteImage(currentRestaurante[0].imagenLightUrl)
            }
            updateData.imagenLightUrl = await saveImage(imageLight)
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

// Toggle modo split payment
restauranteRoute.put('/toggle-split-payment', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    // Obtener el estado actual
    const [restaurante] = await db.select({ splitPayment: RestauranteTable.splitPayment })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))

    if (!restaurante) {
      return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
    }

    // Toggle
    const nuevoEstado = !restaurante.splitPayment

    await db.update(RestauranteTable)
      .set({ splitPayment: nuevoEstado })
      .where(eq(RestauranteTable.id, restauranteId))

    console.log(`💳 Split Payment ${nuevoEstado ? 'activado' : 'desactivado'} para restaurante ${restauranteId}`)

    return c.json({
      message: nuevoEstado ? 'Split Payment activado' : 'Split Payment desactivado',
      success: true,
      splitPayment: nuevoEstado
    }, 200)

  } catch (error) {
    console.error('Error updating split payment mode:', error)
    return c.json({ message: 'Error al cambiar modo split payment', error: (error as Error).message, success: false }, 500)
  }
})

// Toggle seguimiento de items (item tracking)
restauranteRoute.put('/toggle-item-tracking', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    // Obtener el estado actual
    const [restaurante] = await db.select({ itemTracking: RestauranteTable.itemTracking })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))

    if (!restaurante) {
      return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
    }

    // Toggle
    const nuevoEstado = !restaurante.itemTracking

    await db.update(RestauranteTable)
      .set({ itemTracking: nuevoEstado })
      .where(eq(RestauranteTable.id, restauranteId))

    console.log(`📋 Item Tracking ${nuevoEstado ? 'activado' : 'desactivado'} para restaurante ${restauranteId}`)

    return c.json({
      message: nuevoEstado ? 'Seguimiento de items activado' : 'Seguimiento de items desactivado',
      success: true,
      itemTracking: nuevoEstado
    }, 200)

  } catch (error) {
    console.error('Error updating item tracking mode:', error)
    return c.json({ message: 'Error al cambiar seguimiento de items', error: (error as Error).message, success: false }, 500)
  }
})

// Toggle solo carta digital (sin confirmación, se borra tras 20 min)
restauranteRoute.put('/toggle-solo-carta-digital', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    // Obtener el estado actual
    const [restaurante] = await db.select({ soloCartaDigital: RestauranteTable.soloCartaDigital })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))

    if (!restaurante) {
      return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
    }

    // Toggle
    const nuevoEstado = !restaurante.soloCartaDigital

    await db.update(RestauranteTable)
      .set({ soloCartaDigital: nuevoEstado })
      .where(eq(RestauranteTable.id, restauranteId))

    console.log(`📱 Solo Carta Digital ${nuevoEstado ? 'activado' : 'desactivado'} para restaurante ${restauranteId}`)

    return c.json({
      message: nuevoEstado ? 'Modo Sólo Carta Digital activado' : 'Modo Sólo Carta Digital desactivado',
      success: true,
      soloCartaDigital: nuevoEstado
    }, 200)

  } catch (error) {
    console.error('Error updating solo carta digital mode:', error)
    return c.json({ message: 'Error al cambiar modo Sólo Carta Digital', error: (error as Error).message, success: false }, 500)
  }
})

// Toggle sistema de puntos
restauranteRoute.put('/toggle-sistema-puntos', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    // Obtener el estado actual
    const [restaurante] = await db.select({ sistemaPuntos: RestauranteTable.sistemaPuntos })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))

    if (!restaurante) {
      return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
    }

    // Toggle
    const nuevoEstado = !restaurante.sistemaPuntos

    await db.update(RestauranteTable)
      .set({ sistemaPuntos: nuevoEstado })
      .where(eq(RestauranteTable.id, restauranteId))

    console.log(`⭐ Sistema de puntos ${nuevoEstado ? 'activado' : 'desactivado'} para restaurante ${restauranteId}`)

    return c.json({
      message: nuevoEstado ? 'Sistema de puntos activado' : 'Sistema de puntos desactivado',
      success: true,
      sistemaPuntos: nuevoEstado
    }, 200)

  } catch (error) {
    console.error('Error updating points system mode:', error)
    return c.json({ message: 'Error al cambiar sistema de puntos', error: (error as Error).message, success: false }, 500)
  }
})

// Toggle pedido entre amigos (order group)
restauranteRoute.put('/toggle-order-group-enabled', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    const [restaurante] = await db.select({ orderGroupEnabled: RestauranteTable.orderGroupEnabled })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))

    if (!restaurante) {
      return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
    }

    const nuevoEstado = !restaurante.orderGroupEnabled

    await db.update(RestauranteTable)
      .set({ orderGroupEnabled: nuevoEstado })
      .where(eq(RestauranteTable.id, restauranteId))

    return c.json({
      message: nuevoEstado ? 'Pedido entre amigos activado' : 'Pedido entre amigos desactivado',
      success: true,
      orderGroupEnabled: nuevoEstado
    }, 200)
  } catch (error) {
    console.error('Error updating order group enabled:', error)
    return c.json({ message: 'Error al cambiar configuración', error: (error as Error).message, success: false }, 500)
  }
})

// Toggle habilitar/deshabilitar uso de códigos de descuento en checkout
restauranteRoute.put('/toggle-codigo-descuento-enabled', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    const [restaurante] = await db.select({ codigoDescuentoEnabled: RestauranteTable.codigoDescuentoEnabled })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))

    if (!restaurante) {
      return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
    }

    const nuevoEstado = !restaurante.codigoDescuentoEnabled

    await db.update(RestauranteTable)
      .set({ codigoDescuentoEnabled: nuevoEstado })
      .where(eq(RestauranteTable.id, restauranteId))

    return c.json({
      message: nuevoEstado ? 'Códigos de descuento habilitados' : 'Códigos de descuento deshabilitados',
      success: true,
      codigoDescuentoEnabled: nuevoEstado
    }, 200)
  } catch (error) {
    console.error('Error updating codigo descuento enabled:', error)
    return c.json({ message: 'Error al cambiar configuración de códigos de descuento', error: (error as Error).message, success: false }, 500)
  }
})

// Toggle diseño alternativo
restauranteRoute.put('/toggle-diseno-alternativo', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    // Obtener el estado actual
    const [restaurante] = await db.select({ disenoAlternativo: RestauranteTable.disenoAlternativo })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))

    if (!restaurante) {
      return c.json({ message: 'Restaurante no encontrado', success: false }, 404)
    }

    // Toggle
    const nuevoEstado = !restaurante.disenoAlternativo

    await db.update(RestauranteTable)
      .set({ disenoAlternativo: nuevoEstado })
      .where(eq(RestauranteTable.id, restauranteId))

    console.log(`🎨 Diseño alternativo ${nuevoEstado ? 'activado' : 'desactivado'} para restaurante ${restauranteId}`)

    return c.json({
      message: nuevoEstado ? 'Diseño alternativo activado' : 'Diseño alternativo desactivado',
      success: true,
      disenoAlternativo: nuevoEstado
    }, 200)

  } catch (error) {
    console.error('Error updating design option:', error)
    return c.json({ message: 'Error al cambiar opción de diseño', error: (error as Error).message, success: false }, 500)
  }
})

// Actualizar proveedor de pasarela de pago y credenciales Talo
const updatePasarelaPagoSchema = z.object({
  proveedorPago: z.enum(['cucuru', 'talo', 'mercadopago', 'manual']).optional(),
  taloApiKey: z.string().nullish(),
  taloUserId: z.string().nullish(),
})

restauranteRoute.put('/pasarela-pago', zValidator('json', updatePasarelaPagoSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const body = c.req.valid('json')

  try {
    const updateData: { [key: string]: any } = {}

    if (body.proveedorPago !== undefined) updateData.proveedorPago = body.proveedorPago
    if (body.taloApiKey !== undefined) updateData.taloApiKey = body.taloApiKey || null
    if (body.taloUserId !== undefined) updateData.taloUserId = body.taloUserId || null

    if (Object.keys(updateData).length === 0) {
      return c.json({ message: 'No se proporcionaron datos para actualizar', success: false }, 400)
    }

    await db.update(RestauranteTable)
      .set(updateData)
      .where(eq(RestauranteTable.id, restauranteId))

    const [updated] = await db.select({
      proveedorPago: RestauranteTable.proveedorPago,
      taloApiKey: RestauranteTable.taloApiKey,
      taloUserId: RestauranteTable.taloUserId,
    }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1)

    return c.json({
      message: 'Pasarela de pago actualizada correctamente',
      success: true,
      data: updated,
    }, 200)
  } catch (error) {
    console.error('Error actualizando pasarela de pago:', error)
    return c.json({ message: 'Error al actualizar pasarela de pago', error: (error as Error).message, success: false }, 500)
  }
})

// Configurar Cucuru (Webhook)
const configCucuruSchema = z.object({
  apiKey: z.string().min(1),
  collectorId: z.string().min(1)
})

restauranteRoute.post('/configurar-cucuru', zValidator('json', configCucuruSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { apiKey, collectorId } = c.req.valid('json')

  try {
    await configurarWebhookCliente(apiKey, collectorId)

    await db.update(RestauranteTable)
      .set({
        cucuruApiKey: apiKey,
        cucuruCollectorId: collectorId,
        cucuruConfigurado: true
      })
      .where(eq(RestauranteTable.id, restauranteId))

    return c.json({ message: 'Cucuru configurado exitosamente', success: true }, 200)
  } catch (error) {
    console.error('Error configurando Cucuru:', error)
    return c.json({ message: 'Error configurando Cucuru', error: (error as Error).message, success: false }, 500)
  }
})

// Reenviar webhook Cucuru (usa las credenciales ya guardadas)
restauranteRoute.post('/reconfigurar-webhook-cucuru', authMiddleware, async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    const [rest] = await db.select({
      cucuruApiKey: RestauranteTable.cucuruApiKey,
      cucuruCollectorId: RestauranteTable.cucuruCollectorId
    }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1)

    if (!rest?.cucuruApiKey || !rest?.cucuruCollectorId) {
      return c.json({ message: 'No hay credenciales de Cucuru configuradas', success: false }, 400)
    }

    await configurarWebhookCliente(rest.cucuruApiKey, rest.cucuruCollectorId)
    return c.json({ message: 'Webhook Cucuru reenviado correctamente', success: true }, 200)
  } catch (error) {
    console.error('Error reconfigurando webhook Cucuru:', error)
    return c.json({ message: 'Error al reenviar webhook', error: (error as Error).message, success: false }, 500)
  }
})

// Configurar Talo (API Key y User ID)
const configTaloSchema = z.object({
  taloApiKey: z.string().min(1),
  taloUserId: z.string().min(1),
})

restauranteRoute.post('/configurar-talo', zValidator('json', configTaloSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { taloApiKey, taloUserId } = c.req.valid('json')

  try {
    await db.update(RestauranteTable)
      .set({
        taloApiKey: taloApiKey.trim(),
        taloUserId: taloUserId.trim(),
      })
      .where(eq(RestauranteTable.id, restauranteId))

    return c.json({ message: 'Talo configurado exitosamente', success: true }, 200)
  } catch (error) {
    console.error('Error configurando Talo:', error)
    return c.json({ message: 'Error configurando Talo', error: (error as Error).message, success: false }, 500)
  }
})

// Configurar Rapiboy (Token)
const configRapiboySchema = z.object({
  token: z.string().min(1)
})

restauranteRoute.post('/configurar-rapiboy', zValidator('json', configRapiboySchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { token } = c.req.valid('json')

  try {
    await db.update(RestauranteTable)
      .set({
        rapiboyToken: token
      })
      .where(eq(RestauranteTable.id, restauranteId))

    return c.json({ message: 'Rapiboy configurado exitosamente', success: true }, 200)
  } catch (error) {
    console.error('Error configurando Rapiboy:', error)
    return c.json({ message: 'Error configurando Rapiboy', error: (error as Error).message, success: false }, 500)
  }
})

// GET horarios del restaurante autenticado
restauranteRoute.get('/horarios', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  try {
    const horarios = await db
      .select({
        id: HorarioRestauranteTable.id,
        diaSemana: HorarioRestauranteTable.diaSemana,
        horaApertura: HorarioRestauranteTable.horaApertura,
        horaCierre: HorarioRestauranteTable.horaCierre,
      })
      .from(HorarioRestauranteTable)
      .where(eq(HorarioRestauranteTable.restauranteId, restauranteId))

    return c.json({ message: 'Horarios obtenidos', success: true, horarios }, 200)
  } catch (error) {
    console.error('Error getting horarios:', error)
    return c.json({ message: 'Error al obtener horarios', success: false }, 500)
  }
})

// PUT reemplazar todos los horarios del restaurante
const horarioItemSchema = z.object({
  diaSemana: z.number().int().min(0).max(6),
  horaApertura: z.string().regex(/^\d{2}:\d{2}$/),
  horaCierre: z.string().regex(/^\d{2}:\d{2}$/),
})

const updateHorariosSchema = z.object({
  horarios: z.array(horarioItemSchema),
})

restauranteRoute.put('/horarios', zValidator('json', updateHorariosSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { horarios } = c.req.valid('json')

  try {
    await db.delete(HorarioRestauranteTable).where(eq(HorarioRestauranteTable.restauranteId, restauranteId))

    if (horarios.length > 0) {
      await db.insert(HorarioRestauranteTable).values(
        horarios.map((h) => ({
          restauranteId,
          diaSemana: h.diaSemana,
          horaApertura: h.horaApertura,
          horaCierre: h.horaCierre,
        }))
      )
    }

    return c.json({ message: 'Horarios actualizados correctamente', success: true }, 200)
  } catch (error) {
    console.error('Error updating horarios:', error)
    return c.json({ message: 'Error al actualizar horarios', success: false }, 500)
  }
})

export { restauranteRoute }