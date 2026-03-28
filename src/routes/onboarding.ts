import { Hono } from 'hono'
import { pool } from '../db'
import { restaurante as RestauranteTable, horarioRestaurante as HorarioRestauranteTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3"
import UUID = require("uuid-js")

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

const MAX_FILE_SIZE = 5 * 1024 * 1024
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/jpg"]

async function saveImage(base64String: string): Promise<string> {
  const match = base64String.match(/^data:(image\/\w+);base64,/)
  if (!match) throw new Error('Formato de base64 inválido')
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

  await s3Client.send(command)
  return `${R2_PUBLIC_URL}/${fileName}`
}

async function deleteImage(imageUrl: string): Promise<void> {
  if (!imageUrl || !R2_PUBLIC_URL || !imageUrl.startsWith(R2_PUBLIC_URL)) return
  try {
    const urlObject = new URL(imageUrl)
    const key = urlObject.pathname.substring(1)
    if (!key) return
    const command = new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key })
    await s3Client.send(command)
  } catch (error) {}
}

export const onboardingRoute = new Hono()
onboardingRoute.use('*', authMiddleware)

const completeOnboardingSchema = z.object({
  username: z.string().min(3),
  phone: z.string().optional(),
  address: z.string().optional(),
  notifyWhatsapp: z.boolean(),
  whatsappNumber: z.string().optional(),
  notifyPrinter: z.boolean(),
  turnos: z.array(z.object({ horaApertura: z.string(), horaCierre: z.string() })).optional(),
  deliveryPrice: z.string().optional(),
  friendsOrdering: z.boolean().optional(),
  imageLight: z.string().nullable().optional(),
  imageDark: z.string().nullable().optional(),
  proveedorPago: z.enum(['cucuru', 'talo', 'mercadopago', 'manual']).optional(),
  metodosPago: z.object({
    transferenciaManual: z.boolean().optional(),
    efectivo: z.boolean().optional(),
  }).optional()
})

onboardingRoute.put('/complete', zValidator('json', completeOnboardingSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const data = c.req.valid('json')

  try {
    const currentRestaurante = await db.select().from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1)
    if (!currentRestaurante || currentRestaurante.length === 0) {
      return c.json({ success: false, message: 'Restaurante no encontrado' }, 404)
    }

    const usernameRegex = /^[a-zA-Z0-9_-]+$/
    if (!usernameRegex.test(data.username)) {
      return c.json({ success: false, message: 'El alias solo puede contener letras, números, guiones y guiones bajos' }, 400)
    }

    const existente = await db.select().from(RestauranteTable).where(and(eq(RestauranteTable.username, data.username), require('drizzle-orm').ne(RestauranteTable.id, restauranteId))).limit(1)
    if (existente && existente.length > 0) {
      return c.json({ success: false, message: 'El alias ya está en uso' }, 400)
    }

    const updateData: any = {
      username: data.username,
      telefono: data.phone || null,
      direccion: data.address || null,
      notificarClientesWhatsapp: data.notifyWhatsapp,
      whatsappNumber: data.notifyWhatsapp && data.whatsappNumber ? data.whatsappNumber : null,
      deliveryFee: data.deliveryPrice || "0",
      orderGroupEnabled: data.friendsOrdering ?? true,
      completedOnboarding: true
    }

    if (data.proveedorPago) {
      updateData.proveedorPago = data.proveedorPago
    }
    
    // We update the metodos de pago from manual config
    if (data.metodosPago) {
      const currentMetodos = currentRestaurante[0].metodosPagoConfig || {}
      updateData.metodosPagoConfig = {
        ...(typeof currentMetodos === 'object' ? currentMetodos : {}),
        transferenciaManual: data.metodosPago.transferenciaManual ?? false,
        efectivo: data.metodosPago.efectivo ?? true,
      }
    }

    if (data.imageLight && data.imageLight.startsWith('data:image')) {
      if (currentRestaurante[0].imagenLightUrl) await deleteImage(currentRestaurante[0].imagenLightUrl)
      updateData.imagenLightUrl = await saveImage(data.imageLight)
    }

    if (data.imageDark && data.imageDark.startsWith('data:image')) {
      if (currentRestaurante[0].imagenUrl) await deleteImage(currentRestaurante[0].imagenUrl)
      updateData.imagenUrl = await saveImage(data.imageDark)
    }

    await db.update(RestauranteTable).set(updateData).where(eq(RestauranteTable.id, restauranteId))

    // Handle horarios: duplicate input mapping to all days if passed
    if (data.turnos && data.turnos.length > 0) {
      await db.delete(HorarioRestauranteTable).where(eq(HorarioRestauranteTable.restauranteId, restauranteId));
      for (let dia = 0; dia <= 6; dia++) {
        for (const turno of data.turnos) {
          await db.insert(HorarioRestauranteTable).values({
            restauranteId: restauranteId,
            diaSemana: dia,
            horaApertura: turno.horaApertura,
            horaCierre: turno.horaCierre
          });
        }
      }
    }

    return c.json({ success: true, message: 'Onboarding completado exitosamente' })
  } catch (error) {
    console.error('Error completing onboarding:', error)
    return c.json({ success: false, message: 'Error interno del servidor', error: (error as Error).message }, 500)
  }
})
