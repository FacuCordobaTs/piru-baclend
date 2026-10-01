/**
 * Cableado de producción del cobro QR del POS: base MySQL, conexión OAuth del propio local y efectos
 * reales. Vive aparte para que `mp-qr.ts` y `pos-cobros-qr.ts` se puedan importar (y testear) sin
 * abrir el pool de la base.
 *
 * El token es el OAuth del local con la aplicación de Mercado Pago creada para "Código QR" (pagos
 * presenciales), guardado en `mp_conexion_qr`. No es el de la aplicación de pagos online
 * (`restaurante.mp_access_token`) ni `MP_ACCESS_TOKEN` de plataforma: Mercado Pago crea cada aplicación
 * para una sola solución (docs/WHATSAPP_AND_PAYMENTS.md).
 */
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { crearServicioConexionQr } from './mp-conexion-qr'
import { crearRepositorioConexionQr } from './mp-conexion-qr-db'
import { crearClienteMpQr } from './mp-qr'
import { leerConfigOAuthQr } from './mp-qr-oauth'
import { crearServicioCobrosQr } from './pos-cobros-qr'
import { crearEfectosCobrosQr, crearRepositorioCobrosQr } from './pos-cobros-qr-db'

const db = drizzle(pool)

/** Se lee del entorno en cada uso: sin las variables `MP_QR_*` el cobro con QR queda deshabilitado, no roto. */
export const servicioConexionQr = crearServicioConexionQr({
  repo: crearRepositorioConexionQr(db),
  config: () => leerConfigOAuthQr(process.env),
})

export const servicioCobrosQr = crearServicioCobrosQr({
  repo: crearRepositorioCobrosQr(db),
  mp: crearClienteMpQr({
    obtenerToken: (restauranteId) => servicioConexionQr.obtenerToken(restauranteId),
    // Tras un 401 renueva con el refresh token del local (y avisa si otro ya lo había renovado).
    refrescarToken: (restauranteId, tokenFallido) => servicioConexionQr.refrescar(restauranteId, tokenFallido),
  }),
  efectos: crearEfectosCobrosQr(db),
  appConfigurada: () => servicioConexionQr.configurada(),
})
