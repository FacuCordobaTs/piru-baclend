/**
 * Registro self-serve de una tienda (como "Crear tienda gratis" de Tiendanube): mail, nombre de la
 * marca y contraseña. Crea el local en el plan Inicial, con el link armado y el onboarding asistido
 * marcado como hecho: lo que falta se completa desde la tab "Primeros pasos" del panel.
 *
 * No toca a los locales existentes ni al alta asistida de interno/prospección (que siguen en
 * Evolución por el DEFAULT de `restaurante.plan_tienda`).
 */
import { eq } from 'drizzle-orm'
import { type MySql2Database } from 'drizzle-orm/mysql2'
import * as bcrypt from 'bcrypt'
import { z } from 'zod'
import { restaurante as RestauranteTable } from '../db/schema'
import { candidatosUsername, usernameBase } from './prospeccion-tienda'
import { slugDisponible } from './sitios-slugs'
import { PLAN_GRATIS } from './planes-tienda'

type Db = MySql2Database<Record<string, never>>

export const crearTiendaSchema = z.object({
  email: z.string().trim().toLowerCase().email('Escribí un mail válido').max(255),
  nombre: z.string().trim().min(2, 'Escribí el nombre de tu marca').max(80),
  password: z.string().min(8, 'La contraseña necesita al menos 8 caracteres').max(200),
  aceptaTerminos: z.literal(true, { error: 'Tenés que aceptar los términos y condiciones' }),
})
export type DatosCrearTienda = z.infer<typeof crearTiendaSchema>

export class RegistroTiendaError extends Error {
  constructor(message: string, readonly code: 'email_en_uso' | 'sin_username', readonly status: 409 | 500) {
    super(message)
  }
}

/** Valores iniciales de la fila. Puro, para testear qué nace distinto de un alta asistida. */
export function valoresTiendaNueva(datos: DatosCrearTienda, passwordHash: string, username: string, ahora = new Date()) {
  return {
    email: datos.email,
    nombre: datos.nombre,
    password: passwordHash,
    username,
    origen: 'self_serve' as const,
    planTienda: PLAN_GRATIS,
    // El plan Inicial es gratis: no hay paywall. Un plan pago que vence vuelve a Inicial.
    requiereSuscripcion: false,
    // El onboarding asistido es de interno; acá lo reemplazan los pasos del panel.
    completedOnboarding: true,
    // Sin zonas no hay delivery que ofrecer: arranca con retiro y el paso "Entregas" lo completa.
    deliveryEnabled: false,
    takeawayEnabled: true,
    createdAt: ahora,
  }
}

async function elegirUsername(db: Db, nombre: string): Promise<string | null> {
  for (const candidato of candidatosUsername(usernameBase(undefined, nombre), 30)) {
    if (!slugDisponible(candidato).ok) continue
    const [ocupado] = await db.select({ id: RestauranteTable.id }).from(RestauranteTable).where(eq(RestauranteTable.username, candidato)).limit(1)
    if (!ocupado) return candidato
  }
  return null
}

export async function crearTiendaSelfServe(db: Db, datos: DatosCrearTienda) {
  const [existente] = await db.select({ id: RestauranteTable.id }).from(RestauranteTable).where(eq(RestauranteTable.email, datos.email)).limit(1)
  if (existente) throw new RegistroTiendaError('Ya hay una cuenta con ese mail. Iniciá sesión.', 'email_en_uso', 409)

  const username = await elegirUsername(db, datos.nombre)
  if (!username) throw new RegistroTiendaError('No pudimos armar el link de tu tienda. Probá con otro nombre.', 'sin_username', 500)

  const hash = await bcrypt.hash(datos.password, 10)
  try {
    const insert = await db.insert(RestauranteTable).values(valoresTiendaNueva(datos, hash, username))
    const id = Number((insert as any)[0].insertId)
    const [fila] = await db.select().from(RestauranteTable).where(eq(RestauranteTable.id, id)).limit(1)
    return fila
  } catch (error: any) {
    // Dos altas simultáneas con el mismo mail o el mismo link: gana una, la otra reintenta.
    if (error?.code === 'ER_DUP_ENTRY' || error?.cause?.code === 'ER_DUP_ENTRY') {
      throw new RegistroTiendaError('Ya hay una cuenta con ese mail. Iniciá sesión.', 'email_en_uso', 409)
    }
    throw error
  }
}
