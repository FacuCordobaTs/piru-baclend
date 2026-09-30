/**
 * Cableado de producción del cobro QR del POS: base MySQL, token OAuth del propio local y efectos
 * reales. Vive aparte para que `mp-qr.ts` y `pos-cobros-qr.ts` se puedan importar (y testear) sin
 * abrir el pool de la base.
 *
 * El token es el OAuth del restaurante: nunca `MP_ACCESS_TOKEN` de plataforma (docs/WHATSAPP_AND_PAYMENTS.md).
 */
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { restaurante as RestauranteTable } from '../db/schema'
import { obtenerTokenValido } from '../utils/mercadopago'
import { crearClienteMpQr } from './mp-qr'
import { crearServicioCobrosQr } from './pos-cobros-qr'
import { crearEfectosCobrosQr, crearRepositorioCobrosQr } from './pos-cobros-qr-db'

const db = drizzle(pool)

async function leerTokenMp(restauranteId: number): Promise<string | null> {
  const [fila] = await db
    .select({ token: RestauranteTable.mpAccessToken, conectado: RestauranteTable.mpConnected })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)
  return fila?.conectado && fila.token ? fila.token : null
}

export const servicioCobrosQr = crearServicioCobrosQr({
  repo: crearRepositorioCobrosQr(db),
  mp: crearClienteMpQr({
    obtenerToken: leerTokenMp,
    // Valida el token con Mercado Pago y lo renueva con el refresh token si venció.
    refrescarToken: obtenerTokenValido,
  }),
  efectos: crearEfectosCobrosQr(db),
})
