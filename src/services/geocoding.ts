// Backend/src/services/geocoding.ts
import { drizzle } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import { pool } from '../db'
import { zonaDelivery as ZonaDeliveryTable } from '../db/schema'
import { findZoneForPoint } from '../utils/geo'

export interface GeocodingResult {
  success: true
  lat: number
  lng: number
  direccionFormateada: string
  zona: {
    id: number
    nombre: string
    precio: string
  }
}

export interface GeocodingFueraDeZona {
  success: false
  fueraDeZona: true
  lat: number
  lng: number
  direccionFormateada: string
}

export interface GeocodingError {
  success: false
  fueraDeZona: false
  error: string
}

export type GeocodingResponse = GeocodingResult | GeocodingFueraDeZona | GeocodingError

export async function geocodificarYValidarZona(
  calle: string,
  numero: string,
  restauranteId: number,
  ciudad?: string
): Promise<GeocodingResponse> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) {
    return { success: false, fueraDeZona: false, error: 'GOOGLE_MAPS_API_KEY no configurada' }
  }

  const ciudadBase = ciudad ?? 'Santa Fe, Argentina'
  const direccionQuery = `${calle} ${numero}, ${ciudadBase}`

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(direccionQuery)}&key=${apiKey}&components=country:AR`

  let lat: number
  let lng: number
  let direccionFormateada: string

  try {
    const res = await fetch(url)
    const data = await res.json() as any

    if (data.status !== 'OK' || !data.results?.length) {
      console.warn(`[Geocoding] Sin resultados para "${direccionQuery}": ${data.status}`)
      return { success: false, fueraDeZona: false, error: 'No encontramos esa dirección. ¿Podés escribirla de otra forma?' }
    }

    const resultado = data.results[0]
    lat = resultado.geometry.location.lat
    lng = resultado.geometry.location.lng
    direccionFormateada = resultado.formatted_address
  } catch (err) {
    console.error('[Geocoding] Error llamando Google Maps:', err)
    return { success: false, fueraDeZona: false, error: 'Error al verificar la dirección' }
  }

  const db = drizzle(pool)
  const zonas = await db
    .select()
    .from(ZonaDeliveryTable)
    .where(eq(ZonaDeliveryTable.restauranteId, restauranteId))

  const zonaEncontrada = findZoneForPoint({ lat, lng }, zonas)

  if (!zonaEncontrada) {
    return {
      success: false,
      fueraDeZona: true,
      lat,
      lng,
      direccionFormateada,
    }
  }

  return {
    success: true,
    lat,
    lng,
    direccionFormateada,
    zona: {
      id: zonaEncontrada.id,
      nombre: zonaEncontrada.nombre,
      precio: zonaEncontrada.precio,
    },
  }
}
