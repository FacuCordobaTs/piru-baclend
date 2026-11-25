// src/lib/recompra-puntos.ts
//
// Puntos de envío de una tanda. Cada sucursal con WhatsApp propio es un número distinto: la tanda
// se arma para uno solo y sólo mira los clientes que pidieron ahí. Este módulo es puro: decide qué
// números existen, desde cuál puede salir el envío automático y qué hacer con una selección.
//
// El número de una sucursal no es el de la conexión de Meta del local (esa conexión es una sola,
// a nivel restaurante): el envío automático sólo puede salir de un punto cuyo número sea el
// conectado. El resto se manda a mano desde el WhatsApp de esa sucursal, que es el caso normal.

import { telefonoWaMe } from './zonas-especiales'

export type AlcanceEnvio = 'todo' | 'local' | 'sucursal'
export type CanalEnvioTanda = 'manual' | 'api'
export type MotivoPunto = 'sin_numero' | 'inactiva'

export interface SucursalEnvio {
  id: number
  nombre: string
  activo: boolean
  /** Sede interna de eventos: nunca es un punto de envío de marketing. */
  soloPos: boolean
  whatsappEnabled: boolean
  whatsappNumber: string | null
}

export interface DatosPuntosEnvio {
  nombreLocal: string
  whatsappNumber: string | null
  whatsappPhoneId: string | null
  sucursales: SucursalEnvio[]
  /** Pedidos no cancelados sin sucursal: el número principal del local sigue siendo un punto. */
  pedidosSinSucursal: number
}

export interface PuntoEnvio {
  alcance: AlcanceEnvio
  sucursalId: number | null
  nombre: string
  /** Tal como lo cargó el local, para mostrar. null = no hay número utilizable. */
  numero: string | null
  canal: CanalEnvioTanda
  /** null = se puede elegir. */
  motivo: MotivoPunto | null
}

export interface SeleccionPunto {
  alcance?: AlcanceEnvio | null
  sucursalId?: number | null
}

export interface ErrorPunto {
  status: 400 | 404 | 409 | 422
  code: string
  message: string
}

const digitos = (numero: string | null | undefined) => (numero ?? '').replace(/\D/g, '')

/**
 * Mismo número aunque uno venga con +54 9 y el otro sin prefijo. Se comparan los últimos 10
 * dígitos, que es lo que identifica una línea argentina.
 */
export function mismoNumero(a?: string | null, b?: string | null): boolean {
  const da = digitos(a)
  const db = digitos(b)
  if (!da || !db) return false
  if (da.length < 10 || db.length < 10) return da === db
  return da.slice(-10) === db.slice(-10)
}

/** El envío automático usa el número conectado a Meta; cualquier otro sale a mano. */
export function canalDelNumero(
  numero: string | null | undefined,
  local: { whatsappNumber: string | null; whatsappPhoneId: string | null },
  avisosAutomaticos: boolean,
): CanalEnvioTanda {
  if (!avisosAutomaticos || !local.whatsappPhoneId) return 'manual'
  return numero && mismoNumero(numero, local.whatsappNumber) ? 'api' : 'manual'
}

export const clavePunto = (punto: { alcance: string; sucursalId: number | null }) =>
  `${punto.alcance}:${punto.sucursalId ?? 'local'}`

/**
 * Los números desde los que el local puede mandar una tanda.
 *
 * - Con sucursales que tienen su WhatsApp, cada una es un punto y su audiencia son sus pedidos.
 *   El número principal del local suma como punto sólo si quedaron pedidos sin sucursal.
 * - Sin ningún número de sucursal, el único envío posible es el del local y mira toda la base
 *   (`todo`): no hay números distintos que separar.
 * - Las sucursales inactivas o sin número se devuelven igual, marcadas, para que el panel explique
 *   qué falta en vez de esconderlas.
 */
export function puntosEnvio(datos: DatosPuntosEnvio, avisosAutomaticos: boolean): PuntoEnvio[] {
  const canal = (numero: string | null) => canalDelNumero(numero, datos, avisosAutomaticos)
  const sucursales = datos.sucursales.filter((s) => !s.soloPos)
  const conNumero = sucursales.filter(
    (s) => s.activo && s.whatsappEnabled && telefonoWaMe(s.whatsappNumber) != null,
  )

  if (!conNumero.length) {
    const numero = datos.whatsappNumber?.trim() || null
    if (telefonoWaMe(numero) == null) return []
    return [{
      alcance: 'todo',
      sucursalId: null,
      nombre: datos.nombreLocal,
      numero,
      canal: canal(numero),
      motivo: null,
    }]
  }

  const puntos: PuntoEnvio[] = sucursales.map((sucursal) => {
    const numero = sucursal.whatsappEnabled ? sucursal.whatsappNumber?.trim() || null : null
    const valido = telefonoWaMe(numero) != null
    return {
      alcance: 'sucursal' as const,
      sucursalId: sucursal.id,
      nombre: sucursal.nombre,
      numero: valido ? numero : null,
      canal: valido ? canal(numero) : 'manual' as const,
      motivo: !sucursal.activo ? 'inactiva' as const : !valido ? 'sin_numero' as const : null,
    }
  })

  if (datos.pedidosSinSucursal > 0) {
    const numero = datos.whatsappNumber?.trim() || null
    if (telefonoWaMe(numero) != null) {
      puntos.push({
        alcance: 'local',
        sucursalId: null,
        nombre: datos.nombreLocal,
        numero,
        canal: canal(numero),
        motivo: null,
      })
    }
  }

  return puntos
}

export type ResultadoPunto = { punto: PuntoEnvio } | { error: ErrorPunto }

/**
 * Resuelve la selección del dueño. Sin selección sólo se puede seguir cuando hay un único punto:
 * con varios números hay que elegir, porque no hay uno "por defecto" correcto.
 */
export function resolverPunto(puntos: PuntoEnvio[], seleccion: SeleccionPunto = {}): ResultadoPunto {
  const disponibles = puntos.filter((p) => p.motivo == null)
  if (!disponibles.length) {
    const haySucursales = puntos.some((p) => p.alcance === 'sucursal')
    return {
      error: {
        status: 422,
        code: 'sin_numero',
        message: haySucursales
          ? 'Ninguna de tus sucursales tiene un número de WhatsApp activo. Configuralo en Sucursales para mandar mensajes desde ahí.'
          : 'Configurá el WhatsApp del local para poder mandar mensajes.',
      },
    }
  }

  const alcance = seleccion.alcance
    ?? (typeof seleccion.sucursalId === 'number' ? 'sucursal' : null)

  if (alcance == null) {
    if (disponibles.length === 1) return { punto: disponibles[0] }
    return {
      error: {
        status: 400,
        code: 'elegir_sucursal',
        message: 'Elegí desde qué número de sucursal vas a mandar los mensajes.',
      },
    }
  }

  if (alcance === 'sucursal' && (seleccion.sucursalId == null || seleccion.sucursalId < 1)) {
    return {
      error: {
        status: 400,
        code: 'sucursal_invalida',
        message: 'Elegí la sucursal de la que salen los mensajes.',
      },
    }
  }

  const sucursalId = alcance === 'sucursal' ? seleccion.sucursalId ?? null : null
  const elegido = puntos.find(
    (p) => p.alcance === alcance && (p.sucursalId ?? null) === sucursalId,
  )
  if (!elegido) {
    return {
      error: {
        status: 404,
        code: 'sucursal_no_encontrada',
        message: 'La sucursal elegida no pertenece a este local.',
      },
    }
  }
  if (elegido.motivo === 'inactiva') {
    return {
      error: {
        status: 409,
        code: 'sucursal_inactiva',
        message: `La sucursal ${elegido.nombre} está inactiva. Activala o elegí otra.`,
      },
    }
  }
  if (elegido.motivo === 'sin_numero') {
    return {
      error: {
        status: 422,
        code: 'sucursal_sin_numero',
        message: `La sucursal ${elegido.nombre} no tiene un número de WhatsApp activo. Configuralo en Sucursales para mandar desde ahí.`,
      },
    }
  }
  return { punto: elegido }
}

/** El punto tal como quedó guardado en una tanda (legacy sin `alcance` = toda la base). */
export function puntoDeLaTanda(
  tanda: { alcance?: AlcanceEnvio | null; sucursalId: number | null; numeroEnvio?: string | null },
  local: { nombre: string; whatsappNumber: string | null },
  sucursal?: { nombre: string; whatsappEnabled: boolean; whatsappNumber: string | null },
) {
  const alcance: AlcanceEnvio = tanda.alcance
    ?? (tanda.sucursalId != null ? 'sucursal' : 'todo')
  if (alcance === 'sucursal' && tanda.sucursalId != null) {
    const numeroActual = sucursal?.whatsappEnabled ? sucursal.whatsappNumber?.trim() || null : null
    return {
      sucursalId: tanda.sucursalId,
      alcance,
      nombre: sucursal?.nombre ?? local.nombre,
      numero: tanda.numeroEnvio ?? numeroActual,
    }
  }
  return {
    sucursalId: null,
    alcance,
    nombre: local.nombre,
    numero: tanda.numeroEnvio ?? local.whatsappNumber,
  }
}
