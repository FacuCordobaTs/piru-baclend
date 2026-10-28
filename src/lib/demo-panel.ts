/**
 * Panel de la demo de prospección. Ver docs/AUTH_AND_ONBOARDING.md ("Panel de la demo").
 *
 * El fundador arma la tienda de un prospecto y le manda `/:username?demo`. El botón "Ver tu panel de
 * administrador" de esa demo abre el panel ya adentro de esa tienda, sin pedir login: el dueño la
 * explora con datos de ejemplo antes de decidir si se queda con ella (y para eso la reclama por
 * `/mi-tienda/:token`, con su WhatsApp).
 *
 * Como el link de la demo es público, la sesión que entrega no puede ser la del dueño:
 *   - sólo existe mientras la tienda sea un prospecto sin reclamar (`origen='outbound'`, sin
 *     `claimedAt` ni teléfono verificado). Cuando el dueño la reclama, todas las sesiones demo que
 *     quedaron abiertas dejan de servir (`authMiddleware` lo vuelve a verificar en cada request);
 *   - no cambia nada que redirija pedidos o plata (WhatsApp, alias, métodos de pago), ni credenciales,
 *     accesos, facturación ni conexiones con terceros: lista cerrada de mutaciones, como los permisos
 *     del marketer (`marketer-permisos.ts`);
 *   - nunca devuelve secretos: las respuestas JSON pasan por `ocultarSecretos`.
 */

import { eq } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import { restaurante } from '../db/schema'

type Db = MySql2Database<Record<string, never>>

/** La sesión de la demo del panel dura una semana desde la entrada desde la tienda. */
export const DEMO_SESION_TTL_SEGUNDOS = 7 * 24 * 3600

export interface LocalParaDemo {
  origen?: string | null
  claimedAt?: Date | string | null
  telefonoVerificado?: boolean | null
  completedOnboarding?: boolean | null
}

/** Una tienda que armó el fundador y que su dueño todavía no reclamó. */
export function esProspectoSinReclamar(local: LocalParaDemo | null | undefined): boolean {
  if (!local) return false
  return local.origen === 'outbound' && !local.claimedAt && !local.telefonoVerificado
}

export type EstadoPanelDemo =
  /** Se puede entrar. */
  | 'abierta'
  /** El fundador todavía la está armando: no se la muestra a nadie. */
  | 'en_construccion'
  /** Ya tiene dueño (o nunca fue un prospecto): se entra con su cuenta. */
  | 'cerrada'

export function estadoPanelDemo(local: LocalParaDemo | null | undefined): EstadoPanelDemo {
  if (!esProspectoSinReclamar(local)) return 'cerrada'
  return local?.completedOnboarding ? 'abierta' : 'en_construccion'
}

/** ¿La tienda sigue siendo un prospecto? Lo piden el WebSocket del panel y el middleware. */
export async function demoSigueAbierta(db: Db, restauranteId: number): Promise<boolean> {
  const [local] = await db
    .select({
      origen: restaurante.origen,
      claimedAt: restaurante.claimedAt,
      telefonoVerificado: restaurante.telefonoVerificado,
    })
    .from(restaurante)
    .where(eq(restaurante.id, restauranteId))
    .limit(1)
  return esProspectoSinReclamar(local)
}

/** Método y path verificables, o `null` si el request es ambiguo (misma regla que el marketer). */
function rutaVerificable(metodo: string, ruta: string) {
  const method = metodo.toUpperCase()
  const path = ruta.split('?')[0].replace(/\/+$/, '')
  if (!path.startsWith('/api/') || /%|\\|\/\/|\/(?:\.|\.\.)(?:\/|$)/.test(path)) return null
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null
  return { method, path }
}

/** Lecturas que el panel de la demo nunca necesita: operación interna y cuentas de otros. */
// `sitios`: Páginas (docs/PAGINAS_PROPIAS.md) no es parte de la demo, ni para leer.
const LECTURAS_CERRADAS = /^\/api\/(?:interno|marketer|onboarding|staff|facturacion|auth|sitios)(?:\/|$)/

/**
 * Lo único que la demo puede escribir: la operación del servicio, el menú, las mesas y zonas, el
 * marketing y borrar sus datos de ejemplo. Todo lo demás se rechaza por omisión (credenciales,
 * WhatsApp, medios de pago, staff, marketer, módulos pagos, suscripción, recargas, conexiones).
 */
const MUTACIONES_PERMITIDAS: { permitido: RegExp; excepto?: RegExp }[] = [
  {
    // El avisador por WhatsApp sale del número de Piru y Rapiboy es un tercero: no desde la demo.
    permitido: /^\/api\/pedido-unificado(?:\/|$)/,
    excepto: /\/(?:rapiboy|notificar-cliente|confirmar-con-demora)(?:\/|$)/,
  },
  { permitido: /^\/api\/(?:producto|categoria|ingrediente|agregado)(?:\/|$)/ },
  { permitido: /^\/api\/(?:mesas-locales|zona-delivery|repartidores|notificacion)(?:\/|$)/ },
  { permitido: /^\/api\/(?:marketing|codigo-descuento|puntos)(?:\/|$)/, excepto: /\/enviar-whatsapp$/ },
  { permitido: /^\/api\/datos-ejemplo$/ },
  // El pase que abre la app de marketing en modo dueño (lleva la marca demo al otro lado).
  { permitido: /^\/api\/marketing-duenio\/entrada$/ },
  // Activar un módulo incluido es gratis; uno pago responde 409 antes de tocar nada.
  { permitido: /^\/api\/modulos\/[a-z0-9_]+\/activar$/ },
]

const BORRADOS_DE_CLIENTES = [/^\/api\/clientes\/\d+$/, /^\/api\/clientes\/\d+\/pedidos\/\d+$/]

/** Denegar por omisión: la sesión de la demo nunca habilita la operación de la cuenta. */
export function demoPuede(metodo: string, ruta: string): boolean {
  const verificable = rutaVerificable(metodo, ruta)
  if (!verificable) return false
  const { method, path } = verificable
  if (method === 'GET') return !LECTURAS_CERRADAS.test(path)
  if (method === 'DELETE' && BORRADOS_DE_CLIENTES.some((re) => re.test(path))) return true
  return MUTACIONES_PERMITIDAS.some((r) => r.permitido.test(path) && !(r.excepto && r.excepto.test(path)))
}

/**
 * Dentro de la app de marketing la sesión del dueño con la marca demo alcanza lo mismo que ya le
 * alcanza al dueño allá (`duenioAppMarketingPuede`), menos lo que cobra o manda mensajes desde el
 * número de Piru. Esto sólo dice qué se le quita; se compone con esa lista, no la reemplaza.
 */
export function demoBloqueaEnAppMarketing(metodo: string, ruta: string): boolean {
  const verificable = rutaVerificable(metodo, ruta)
  if (!verificable) return true
  const { path } = verificable
  return (
    /^\/api\/modulos\/[^/]+\/(?:checkout|pago-link-whatsapp)$/.test(path) ||
    /\/enviar-whatsapp$/.test(path)
  )
}

const CLAVES_SECRETAS = new Set([
  'password',
  'claimToken',
  'claimTokenExpira',
  'mpAccessToken',
  'mpRefreshToken',
  'mercadoPagoPrivateKey',
  'whatsappAccessToken',
  'whatsappTokenExpiry',
  'cucuruApiKey',
  'cucuruCollectorId',
  'taloClientId',
  'taloClientSecret',
  'taloUserId',
  'rapiboyToken',
  'afipClaveFiscal',
  'afipCert',
  'afipKeyPrivada',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'pinHash',
  'codigoAcceso',
])

/**
 * Una copia de la respuesta sin credenciales ni tokens: `GET /restaurante/profile` y
 * `GET /sucursales/list` devuelven la fila completa, y a quien entra por el link público de la demo
 * no le corresponde verla. Las claves quedan en `null` para no cambiar la forma de la respuesta.
 */
export function ocultarSecretos<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map((v) => ocultarSecretos(v)) as unknown as T
  if (valor !== null && typeof valor === 'object' && !(valor instanceof Date)) {
    const limpio: Record<string, unknown> = {}
    for (const [clave, v] of Object.entries(valor as Record<string, unknown>)) {
      limpio[clave] = CLAVES_SECRETAS.has(clave) ? null : ocultarSecretos(v)
    }
    return limpio as T
  }
  return valor
}
