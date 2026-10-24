import type { MySql2Database } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import { restaurante } from '../db/schema'

export class AltaIncompletaError extends Error {}

/**
 * Cierra el alta asistida de una tienda: queda completa, lista para mostrarse en la demo
 * (`/:username?demo`) y para que el dueño la reclame (`/mi-tienda/:token`).
 *
 * NO inicia la prueba. El reloj de los 5 días arranca cuando el dueño verifica su WhatsApp en el
 * claim (`arrancarTrialClaim`, routes/claim.ts) o cuando el fundador la inicia a mano desde interno.
 * Si corriera desde acá, la prueba vencería antes de que el dueño vea la tienda y a los
 * 5 días + 7 de gracia la tienda pública quedaría "cerrada temporalmente" (`estaPausadoPorSuscripcion`).
 *
 * Tampoco toca `requiereSuscripcion`: lo fija el alta y el claim, y hacerlo acá le sacaría el panel a
 * una cuenta que ya operaba y se reconstruye desde interno.
 */
export async function completarAltaInterna(db: MySql2Database<Record<string, never>>, id: number) {
  return db.transaction(async (tx) => {
    // El bloqueo serializa el doble clic y los reintentos.
    const [local] = await tx
      .select({ id: restaurante.id, username: restaurante.username })
      .from(restaurante)
      .where(eq(restaurante.id, id))
      .limit(1)
      .for('update')
    if (!local?.username) throw new AltaIncompletaError('Terminá de configurar la tienda antes de cerrar el alta')
    await tx.update(restaurante).set({ completedOnboarding: true }).where(eq(restaurante.id, id))
  })
}
