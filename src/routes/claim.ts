// src/routes/claim.ts
// Claim flow (onboarding outbound) — endpoints PÚBLICOS (sin auth). Ver docs/ROADMAP_CLAIM_FLOW.md (Tarea 3).
//
// El fundador arma una tienda demo (prospecto) y comparte admin.piru.app/mi-tienda/{claimToken}.
// El dueño la "reclama" verificando su WhatsApp: la cuenta del prospecto y la del dueño son LA MISMA
// fila de `restaurante` (el claim sólo cambia el estado). El claim = login por teléfono con scope de
// token: reusa el mismo OTP por WhatsApp que `auth.ts` (registroTelefono + sendVerificationCodeWhatsApp),
// pero el número ya lo conoce el sistema (rest.telefono) — no se lo pedimos al usuario.
import { Hono } from 'hono'
import { randomUUID, randomInt } from 'crypto'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { setCookie } from 'hono/cookie'
import { restaurante as RestauranteTable, registroTelefono } from '../db/schema'
import { and, eq, gt } from 'drizzle-orm'
import { createAccessToken } from '../libs/jwt'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import * as bcrypt from 'bcrypt'
import { sendVerificationCodeWhatsApp } from '../services/whatsapp'
import {
  getRestaurantePorClaimToken,
  claimTokenVigente,
  computarInventarioClaim,
} from '../lib/claim'

// Mismos parámetros de OTP que el registro/login por teléfono (auth.ts), para consistencia.
const OTP_EXPIRACION_MS = 10 * 60 * 1000 // el código vive 10 minutos
const OTP_REENVIO_COOLDOWN_MS = 45 * 1000 // no permitir reenviar antes de 45s
const OTP_MAX_INTENTOS = 5 // intentos fallidos antes de invalidar la sesión

const normalizarTelefono = (raw: string): string => raw.replace(/\D/g, '')
const generarCodigo = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0')

/** Enmascara el teléfono para el preview público: sólo se ven los últimos 3 dígitos. */
const enmascararTelefono = (raw: string | null | undefined): string | null => {
  const d = normalizarTelefono(raw || '')
  if (!d) return null
  if (d.length <= 3) return '•'.repeat(d.length)
  return '••••••' + d.slice(-3)
}

const verifySchema = z.object({
  verificationId: z.string().uuid(),
  codigo: z.string().regex(/^\d{6}$/),
})

export const claimRoute = new Hono()

// 1) Preview público de la tienda reclamable. Muestra "esto es tuyo": nombre, logo, link y el
// inventario de lo ya cargado (efecto dotación). 404 si el token no existe, expiró o ya se reclamó.
claimRoute.get('/:token', async (c) => {
  const db = drizzle(pool)
  const token = c.req.param('token')

  try {
    const rest = await getRestaurantePorClaimToken(db, token)
    if (!rest) {
      return c.json({ message: 'Este link no es válido', success: false }, 404)
    }
    if (rest.claimedAt) {
      // Ya reclamada: no re-onboarding público. El dueño entra por login normal.
      return c.json({ message: 'Esta tienda ya fue reclamada', success: false, yaReclamada: true }, 404)
    }
    if (!claimTokenVigente(rest)) {
      return c.json({ message: 'Este link venció', success: false, vencido: true }, 404)
    }

    const inventario = await computarInventarioClaim(db, rest.id)

    return c.json({
      success: true,
      tienda: {
        nombre: rest.nombre ?? null,
        username: rest.username ?? null,
        imagenUrl: rest.imagenUrl ?? null,
        imagenLightUrl: rest.imagenLightUrl ?? null,
        telefonoEnmascarado: enmascararTelefono(rest.telefono),
      },
      inventario,
    }, 200)
  } catch (error) {
    console.error('Error en preview de claim:', error)
    return c.json({ message: 'Error al cargar la tienda', success: false }, 500)
  }
})

// 2) Iniciar el reclamo: manda el OTP al WhatsApp que YA está en la cuenta del prospecto (rest.telefono).
// No pedimos el número: lo conoce el sistema. Devuelve verificationId + el teléfono enmascarado.
claimRoute.post('/:token/start', async (c) => {
  const db = drizzle(pool)
  const token = c.req.param('token')

  try {
    const rest = await getRestaurantePorClaimToken(db, token)
    if (!rest) {
      return c.json({ message: 'Este link no es válido', success: false }, 404)
    }
    if (rest.claimedAt) {
      return c.json({ message: 'Esta tienda ya fue reclamada', success: false, yaReclamada: true }, 404)
    }
    if (!claimTokenVigente(rest)) {
      return c.json({ message: 'Este link venció', success: false, vencido: true }, 404)
    }

    const telefono = normalizarTelefono(rest.telefono || '')
    if (telefono.length < 8) {
      // El prospecto no tiene un teléfono cargado: el fundador debe completarlo desde interno.
      return c.json({ message: 'Esta tienda no tiene un WhatsApp asociado. Escribinos para reclamarla.', success: false }, 409)
    }

    // Anti-spam: no generar otro código para el mismo número dentro del cooldown.
    const desde = new Date(Date.now() - OTP_REENVIO_COOLDOWN_MS)
    const reciente = await db.select({ id: registroTelefono.id })
      .from(registroTelefono)
      .where(and(
        eq(registroTelefono.telefono, telefono),
        eq(registroTelefono.verificado, false),
        gt(registroTelefono.createdAt, desde),
      ))
      .limit(1)

    if (reciente.length) {
      return c.json({ message: 'Ya te enviamos un código hace unos segundos. Esperá un momento antes de pedir otro.', success: false }, 429)
    }

    const codigo = generarCodigo()
    const codigoHash = await bcrypt.hash(codigo, 10)
    const verificationId = randomUUID()
    const expiraEn = new Date(Date.now() + OTP_EXPIRACION_MS)

    // Sesión de OTP atada a ESTA cuenta (restauranteId): la verificación no crea nada, sólo la reclama.
    await db.insert(registroTelefono).values({
      id: verificationId,
      telefono,
      codigoHash,
      expiraEn,
      restauranteId: rest.id,
    })

    const envio = await sendVerificationCodeWhatsApp(c, { phone: telefono, code: codigo })
    if (!envio.success) {
      await db.delete(registroTelefono).where(eq(registroTelefono.id, verificationId))
      return c.json({ message: 'No pudimos enviar el código por WhatsApp. Intentá de nuevo.', success: false }, 502)
    }

    return c.json({
      message: 'Código enviado por WhatsApp',
      success: true,
      verificationId,
      telefonoEnmascarado: enmascararTelefono(telefono),
      expiraEnSegundos: Math.floor(OTP_EXPIRACION_MS / 1000),
    }, 200)
  } catch (error) {
    console.error('Error iniciando claim:', error)
    return c.json({ message: 'Error al iniciar el reclamo', success: false }, 500)
  }
})

// 3) Verificar el código: marca la cuenta como reclamada (claimedAt + telefonoVerificado) y devuelve
// el token admin. La cuenta ya existía (prospecto): NO se crea nada, sólo cambia de estado.
claimRoute.post('/:token/verify', zValidator('json', verifySchema), async (c) => {
  const db = drizzle(pool)
  const token = c.req.param('token')
  const { verificationId, codigo } = c.req.valid('json')

  try {
    const rest = await getRestaurantePorClaimToken(db, token)
    if (!rest) {
      return c.json({ message: 'Este link no es válido', success: false }, 404)
    }

    const [reg] = await db.select().from(registroTelefono)
      .where(eq(registroTelefono.id, verificationId))
      .limit(1)

    if (!reg) {
      return c.json({ message: 'Sesión de verificación no encontrada', success: false }, 404)
    }
    // La sesión de OTP tiene que corresponder a esta misma cuenta.
    if (reg.restauranteId !== rest.id) {
      return c.json({ message: 'Sesión de verificación no válida para esta tienda', success: false }, 400)
    }

    // Idempotencia: si ya se reclamó (doble-submit del código), devolvemos el token igual.
    if (rest.claimedAt && reg.verificado) {
      const tk = await createAccessToken({ id: rest.id })
      setCookie(c, 'token', tk as string, { path: '/', sameSite: 'None', secure: true, maxAge: 365 * 24 * 60 * 60 })
      return c.json({ message: '¡Tienda reclamada!', success: true, restaurante: rest, token: tk }, 200)
    }

    if (reg.verificado) {
      return c.json({ message: 'Esta verificación ya fue completada', success: false }, 400)
    }
    if (new Date(reg.expiraEn).getTime() < Date.now()) {
      return c.json({ message: 'El código expiró. Pedí uno nuevo.', success: false }, 400)
    }
    if (reg.intentos >= OTP_MAX_INTENTOS) {
      return c.json({ message: 'Demasiados intentos fallidos. Pedí un código nuevo.', success: false }, 429)
    }

    const codigoOk = await bcrypt.compare(codigo, reg.codigoHash)
    if (!codigoOk) {
      await db.update(registroTelefono)
        .set({ intentos: reg.intentos + 1 })
        .where(eq(registroTelefono.id, verificationId))
      const restantes = OTP_MAX_INTENTOS - (reg.intentos + 1)
      return c.json({
        message: restantes > 0 ? `Código incorrecto. Te quedan ${restantes} intentos.` : 'Código incorrecto. Pedí un código nuevo.',
        success: false,
      }, 400)
    }

    // Reclamo atómico: marcamos verificado sólo si seguía en false (evita doble-reclamo simultáneo).
    const claim = await db.update(registroTelefono)
      .set({ verificado: true })
      .where(and(eq(registroTelefono.id, verificationId), eq(registroTelefono.verificado, false)))

    if (claim[0].affectedRows === 0) {
      return c.json({ message: 'Estamos terminando de reclamar tu tienda, probá de nuevo en un momento.', success: false }, 409)
    }

    // La cuenta pasa a reclamada: es dueña verificada del número. El pipeline se deriva a 'reclamada'.
    await db.update(RestauranteTable)
      .set({ claimedAt: new Date(), telefonoVerificado: true })
      .where(eq(RestauranteTable.id, rest.id))

    const [cuenta] = await db.select().from(RestauranteTable)
      .where(eq(RestauranteTable.id, rest.id))
      .limit(1)

    const tk = await createAccessToken({ id: rest.id })
    setCookie(c, 'token', tk as string, { path: '/', sameSite: 'None', secure: true, maxAge: 365 * 24 * 60 * 60 })

    return c.json({ message: '¡Tienda reclamada!', success: true, restaurante: cuenta, token: tk }, 200)
  } catch (error) {
    console.error('Error verificando claim:', error)
    return c.json({ message: 'Error al verificar el código', success: false }, 500)
  }
})
