/**
 * Implementación MySQL/Drizzle de `RepositorioConexionQr`: la conexión de cada local con la aplicación
 * de Mercado Pago creada para "Código QR" (tabla `mp_conexion_qr`).
 *
 * Reglas de este archivo:
 * - Los instantes (`expira_at`, `created_at`, `updated_at`) los escribe la app (DATETIME): nunca se
 *   comparan en SQL con `NOW()`. El vencimiento se compara en JS.
 * - Renovar un token es una operación con efectos en Mercado Pago (rota el `refresh_token`), por eso se
 *   hace bajo lock de la fila: dos renovaciones simultáneas no se pisan ni gastan el mismo refresh token.
 * - Los tokens no salen de esta capa más que hacia `mp-conexion-qr.ts`; nunca se loguean.
 */
import { eq, sql } from 'drizzle-orm'
import { mpCajaQr as CajaTable, mpConexionQr as ConexionTable } from '../db/schema'
import { MODULE_KEYS, tieneModuloActivo } from './modulos'
import { autorizacionPerdida, type TokensOAuth } from './mp-qr-oauth'
import type { ConexionQr, RepositorioConexionQr } from './mp-conexion-qr'

const aConexion = (fila: typeof ConexionTable.$inferSelect): ConexionQr => ({
  restauranteId: fila.restauranteId,
  mpUserId: fila.mpUserId,
  accessToken: fila.accessToken,
  refreshToken: fila.refreshToken,
  scope: fila.scope,
  expiraAt: fila.expiraAt,
  conectado: fila.conectado,
})

export function crearRepositorioConexionQr(db: any): RepositorioConexionQr {
  const leerFila = async (ejecutor: any, restauranteId: number) => {
    const [fila] = await ejecutor.select().from(ConexionTable).where(eq(ConexionTable.restauranteId, restauranteId)).limit(1)
    return (fila ?? null) as typeof ConexionTable.$inferSelect | null
  }
  const bloquear = (tx: any, restauranteId: number) =>
    tx.execute(sql`SELECT id FROM mp_conexion_qr WHERE restaurante_id = ${restauranteId} FOR UPDATE`)

  return {
    moduloActivo: (restauranteId) => tieneModuloActivo(db, restauranteId, MODULE_KEYS.MERCADOPAGO),

    async leer(restauranteId) {
      const fila = await leerFila(db, restauranteId)
      return fila ? aConexion(fila) : null
    },

    async guardar(restauranteId, tokens, ahora) {
      return db.transaction(async (tx: any) => {
        // Sin `FOR UPDATE`: con la fila inexistente tomaría un gap lock y dos autorizaciones simultáneas
        // de un local nuevo podrían interbloquearse al insertar. El upsert de abajo ya serializa la escritura.
        const previa = await leerFila(tx, restauranteId)
        const cuentaCambiada = !!previa && previa.mpUserId !== tokens.mpUserId
        const valores = {
          mpUserId: tokens.mpUserId,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          scope: tokens.scope,
          expiraAt: tokens.expiraAt,
          conectado: true,
          updatedAt: ahora,
        }
        // `onDuplicateKeyUpdate` cubre dos autorizaciones simultáneas de un local sin conexión previa.
        await tx.insert(ConexionTable)
          .values({ restauranteId, ...valores, createdAt: ahora })
          .onDuplicateKeyUpdate({ set: valores })
        // Las cajas son de la cuenta de Mercado Pago anterior: con otra cuenta ya no existen para ella.
        if (cuentaCambiada) await tx.update(CajaTable).set({ activo: false }).where(eq(CajaTable.restauranteId, restauranteId))
        return { cuentaCambiada }
      })
    },

    async renovar(restauranteId, tokenFallido, renovarEnMp, ahora) {
      return db.transaction(async (tx: any) => {
        await bloquear(tx, restauranteId)
        const actual = await leerFila(tx, restauranteId)
        if (!actual || !actual.conectado) return null
        // Otro proceso ya lo renovó mientras éste esperaba el lock: no se gasta el refresh token.
        if (tokenFallido !== null && actual.accessToken !== tokenFallido) return actual.accessToken
        if (!actual.refreshToken) {
          await tx.update(ConexionTable).set({ conectado: false, updatedAt: ahora }).where(eq(ConexionTable.restauranteId, restauranteId))
          return null
        }
        let nuevos: TokensOAuth
        try {
          nuevos = await renovarEnMp(actual.refreshToken)
        } catch (error) {
          // Autorización revocada o vencida: sólo reconectando se recupera. Un corte de red no la pierde.
          if (autorizacionPerdida(error)) {
            await tx.update(ConexionTable).set({ conectado: false, updatedAt: ahora }).where(eq(ConexionTable.restauranteId, restauranteId))
          }
          return null
        }
        // Fuera del `try`: un fallo al guardar no se disfraza de "no se pudo renovar" (el refresh token
        // anterior ya se gastó) y llega a quien llama, que lo registra.
        await tx.update(ConexionTable).set({
          accessToken: nuevos.accessToken,
          // Mercado Pago rota el refresh token: el anterior deja de servir.
          refreshToken: nuevos.refreshToken ?? actual.refreshToken,
          scope: nuevos.scope ?? actual.scope,
          expiraAt: nuevos.expiraAt,
          updatedAt: ahora,
        }).where(eq(ConexionTable.restauranteId, restauranteId))
        return nuevos.accessToken
      })
    },

    async desconectar(restauranteId) {
      await db.transaction(async (tx: any) => {
        await bloquear(tx, restauranteId)
        await tx.delete(ConexionTable).where(eq(ConexionTable.restauranteId, restauranteId))
        await tx.update(CajaTable).set({ activo: false }).where(eq(CajaTable.restauranteId, restauranteId))
      })
    },
  }
}
