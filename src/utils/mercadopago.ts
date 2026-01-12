/**
 * Utilidades para MercadoPago OAuth
 * Manejo de refresh tokens y renovación de credenciales
 */

import { drizzle } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import { pool } from '../db'
import { restaurante as RestauranteTable } from '../db/schema'

const MP_CLIENT_ID = process.env.MP_CLIENT_ID
const MP_CLIENT_SECRET = process.env.MP_CLIENT_SECRET

/**
 * Renueva el access_token de un restaurante usando el refresh_token
 * IMPORTANTE: MercadoPago devuelve un nuevo refresh_token que reemplaza al anterior
 * 
 * @param restauranteId - ID del restaurante en la base de datos
 * @param currentRefreshToken - El refresh_token actual del restaurante
 * @returns El nuevo access_token o null si falla
 */
export async function refrescarTokenRestaurante(
  restauranteId: number, 
  currentRefreshToken: string
): Promise<string | null> {
  const db = drizzle(pool)
  
  if (!MP_CLIENT_ID || !MP_CLIENT_SECRET) {
    console.error('❌ [RefreshToken] Faltan credenciales de MercadoPago')
    return null
  }

  try {
    console.log(`🔄 [RefreshToken] Renovando token para restaurante ${restauranteId}...`)
    
    const response = await fetch('https://api.mercadopago.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: MP_CLIENT_ID,
        client_secret: MP_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: currentRefreshToken
      })
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('❌ [RefreshToken] Error renovando token:', data)
      
      // Si el refresh token ya no es válido, marcar como desconectado
      if (response.status === 400 || response.status === 401) {
        await db.update(RestauranteTable)
          .set({
            mpConnected: false,
            // No limpiamos los tokens por si el admin quiere volver a intentar
          })
          .where(eq(RestauranteTable.id, restauranteId))
        
        console.log(`⚠️ [RefreshToken] Restaurante ${restauranteId} marcado como desconectado de MP`)
      }
      
      return null
    }

    // MercadoPago devuelve un NUEVO access_token Y un NUEVO refresh_token
    // El refresh_token anterior deja de ser válido
    await db.update(RestauranteTable)
      .set({
        mpAccessToken: data.access_token,
        mpRefreshToken: data.refresh_token, // Guardar el nuevo refresh token
        mpPublicKey: data.public_key || null,
      })
      .where(eq(RestauranteTable.id, restauranteId))

    console.log(`✅ [RefreshToken] Token renovado exitosamente para restaurante ${restauranteId}`)
    
    return data.access_token
  } catch (error) {
    console.error('❌ [RefreshToken] Error inesperado:', error)
    return null
  }
}

/**
 * Obtiene un access_token válido para un restaurante
 * Si el token actual ha expirado (error 401), intenta renovarlo automáticamente
 * 
 * @param restauranteId - ID del restaurante
 * @returns El access_token válido o null si no se puede obtener
 */
export async function obtenerTokenValido(restauranteId: number): Promise<string | null> {
  const db = drizzle(pool)
  
  try {
    const restaurante = await db.select({
      mpAccessToken: RestauranteTable.mpAccessToken,
      mpRefreshToken: RestauranteTable.mpRefreshToken,
      mpConnected: RestauranteTable.mpConnected,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

    if (!restaurante || restaurante.length === 0) {
      console.error(`❌ [ObtenerToken] Restaurante ${restauranteId} no encontrado`)
      return null
    }

    const { mpAccessToken, mpRefreshToken, mpConnected } = restaurante[0]

    if (!mpConnected || !mpAccessToken) {
      console.log(`⚠️ [ObtenerToken] Restaurante ${restauranteId} no tiene MP conectado`)
      return null
    }

    // Verificar si el token es válido haciendo una petición simple a MP
    const testResponse = await fetch('https://api.mercadopago.com/users/me', {
      headers: {
        'Authorization': `Bearer ${mpAccessToken}`
      }
    })

    if (testResponse.ok) {
      return mpAccessToken
    }

    // Si el token expiró (401), intentar renovar
    if (testResponse.status === 401 && mpRefreshToken) {
      console.log(`🔄 [ObtenerToken] Token expirado, intentando renovar para restaurante ${restauranteId}`)
      const nuevoToken = await refrescarTokenRestaurante(restauranteId, mpRefreshToken)
      return nuevoToken
    }

    console.error(`❌ [ObtenerToken] Error verificando token: ${testResponse.status}`)
    return null
  } catch (error) {
    console.error('❌ [ObtenerToken] Error inesperado:', error)
    return null
  }
}

/**
 * Verifica si un restaurante tiene MercadoPago conectado y con token válido
 */
export async function verificarConexionMP(restauranteId: number): Promise<{
  conectado: boolean
  tokenValido: boolean
  mpUserId: string | null
}> {
  const db = drizzle(pool)
  
  try {
    const restaurante = await db.select({
      mpAccessToken: RestauranteTable.mpAccessToken,
      mpRefreshToken: RestauranteTable.mpRefreshToken,
      mpConnected: RestauranteTable.mpConnected,
      mpUserId: RestauranteTable.mpUserId,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

    if (!restaurante || restaurante.length === 0) {
      return { conectado: false, tokenValido: false, mpUserId: null }
    }

    const { mpAccessToken, mpConnected, mpUserId } = restaurante[0]

    if (!mpConnected || !mpAccessToken) {
      return { conectado: false, tokenValido: false, mpUserId: null }
    }

    // Verificar token con petición a MP
    const testResponse = await fetch('https://api.mercadopago.com/users/me', {
      headers: {
        'Authorization': `Bearer ${mpAccessToken}`
      }
    })

    return {
      conectado: true,
      tokenValido: testResponse.ok,
      mpUserId
    }
  } catch (error) {
    console.error('❌ [VerificarConexion] Error:', error)
    return { conectado: false, tokenValido: false, mpUserId: null }
  }
}

