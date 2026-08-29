import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { and, asc, eq } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import * as jwt from 'jsonwebtoken'
import {
  modulo as ModuloTable,
  plan as PlanTable,
  restaurante as RestauranteTable,
  restauranteModulo as RestauranteModuloTable,
  suscripcion as SuscripcionTable,
} from '../db/schema'
import { internoAuthMiddleware } from '../middleware/interno'
import { resumenWallet } from '../lib/mensajes-wallet'
import {
  resolverEstadoVigente,
  iniciarTrial,
  DIAS_TRIAL_DEFAULT,
  type CicloPago,
} from '../lib/suscripciones'
import { obtenerConfiguracionSuscripcion, resolverSuscripcionUnica } from '../lib/suscripcion'
import { resolverImporteMensual, resolverModulosRestaurante, resolverRepresentacionCanonicaCrecimiento } from '../lib/modulos'
import {
  generarClaimLink,
  buildClaimUrl,
  claimTokenVigente,
  derivarPipeline,
  derivarExpiracionClaim,
  CLAIM_TOKEN_TTL_DIAS,
} from '../lib/claim'

/** Días restantes (redondeado hacia arriba, mínimo 0) hasta una fecha. */
const diasHasta = (fecha: Date | string | null | undefined): number | null => {
  if (!fecha) return null
  const ms = new Date(fecha).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}

const sumarMeses = (fecha: Date, meses: number): Date => {
  const resultado = new Date(fecha)
  const dia = resultado.getDate()
  resultado.setMonth(resultado.getMonth() + meses)
  if (resultado.getDate() < dia) resultado.setDate(0)
  return resultado
}

// Panel interno del fundador. Auth por credencial fija en env (sin tabla de usuarios):
// POST /interno/login compara contra INTERNO_PASSWORD y emite un JWT propio firmado con
// INTERNO_JWT_SECRET (scope 'interno', ~12 h). El resto de las rutas exige ese token.
const INTERNO_TOKEN_TTL = '12h'
const ACCESO_TEMPORAL_TTL_SEGUNDOS = 15 * 60
const ADMIN_URL = (process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')

const internoRoute = new Hono()

/** Login: password fija → JWT de scope 'interno'. Fuera del middleware (es la puerta). */
const loginSchema = z.object({ password: z.string().min(1) })

internoRoute.post('/login', zValidator('json', loginSchema), async (c) => {
  const { password } = c.req.valid('json')
  const esperada = process.env.INTERNO_PASSWORD
  const secret = process.env.INTERNO_JWT_SECRET

  if (!esperada || !secret) {
    console.error('❌ [Interno] Falta INTERNO_PASSWORD o INTERNO_JWT_SECRET en el env')
    return c.json({ success: false, message: 'Panel interno no configurado' }, 503)
  }

  if (password !== esperada) {
    return c.json({ success: false, message: 'Contraseña incorrecta' }, 401)
  }

  const token = jwt.sign({ scope: 'interno' }, secret, { expiresIn: INTERNO_TOKEN_TTL })
  return c.json({ success: true, data: { token } }, 200)
})

// A partir de acá, todo exige el token interno.
internoRoute.use('*', internoAuthMiddleware)

/**
 * Emite una sesión corta para entrar al admin de un local desde el panel interno.
 * No toca la contraseña ni la sesión del dueño. El JWT viaja en el fragmento de URL
 * para que no termine en access logs y el admin lo elimina apenas lo consume.
 */
internoRoute.post('/locales/:id/acceso-temporal', async (c) => {
  const restauranteId = Number(c.req.param('id'))
  if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
    return c.json({ success: false, message: 'ID de local inválido' }, 400)
  }

  const db = drizzle(pool)
  const [local] = await db
    .select({ id: RestauranteTable.id, nombre: RestauranteTable.nombre })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  if (!local) {
    return c.json({ success: false, message: 'Local no encontrado' }, 404)
  }

  const token = jwt.sign(
    { id: local.id, scope: 'restaurante', accesoTemporalInterno: true },
    process.env.JWT_SECRET!,
    { expiresIn: ACCESO_TEMPORAL_TTL_SEGUNDOS },
  )
  const expira = new Date(Date.now() + ACCESO_TEMPORAL_TTL_SEGUNDOS * 1000).toISOString()

  console.info(`[Interno] Acceso temporal emitido para restaurante ${local.id} (${local.nombre || 'sin nombre'}), expira ${expira}`)

  return c.json({
    success: true,
    data: {
      url: `${ADMIN_URL}/acceso-interno#token=${encodeURIComponent(token)}`,
      expira,
    },
  }, 200)
})

/**
 * Lista de restaurantes con su suscripción única, módulos activos y consumo de
 * mensajes. Conserva los aliases `plan*` para consumidores internos anteriores y corre resolverEstadoVigente
 * antes de leer (para reflejar vencimientos sin cron). Es lo que permite cerrar clientes
 * por outreach antes de tener el billing 100% automatizado.
 */
internoRoute.get('/locales', async (c) => {
  const db = drizzle(pool)
  try {
    const restaurantes = await db
      .select({
        id: RestauranteTable.id,
        nombre: RestauranteTable.nombre,
        username: RestauranteTable.username,
        email: RestauranteTable.email,
        telefono: RestauranteTable.telefono,
        telefonoVerificado: RestauranteTable.telefonoVerificado,
        whatsappEnabled: RestauranteTable.whatsappEnabled,
        whatsappNumber: RestauranteTable.whatsappNumber,
        whatsappPhoneId: RestauranteTable.whatsappPhoneId,
        whatsappWabaId: RestauranteTable.whatsappWabaId,
        whatsappAccessToken: RestauranteTable.whatsappAccessToken,
        origen: RestauranteTable.origen,
        claimToken: RestauranteTable.claimToken,
        claimTokenExpira: RestauranteTable.claimTokenExpira,
        claimedAt: RestauranteTable.claimedAt,
      })
      .from(RestauranteTable)
      .orderBy(asc(RestauranteTable.id))

    const data = await Promise.all(
      restaurantes.map(async (r) => {
        // Transición lazy de estado antes de leer (vencido → gracia → suspendida). Devuelve la
        // fila de suscripción (o null): la usamos para trialFin sin una query extra.
        const subRow = await resolverEstadoVigente(db, r.id)
        const [sus, wallet, modulos] = await Promise.all([
          resolverSuscripcionUnica(db, r.id),
          resumenWallet(db, r.id),
          resolverModulosRestaurante(db, r.id),
        ])

        // Pipeline de ventas (prospecto → reclamada → trial → activa → pausada): derivado, no guardado.
        const pipeline = derivarPipeline({ origen: r.origen, claimedAt: r.claimedAt, estado: sus.estado })
        const claimVigente = claimTokenVigente(r)
        // Expiración del prospecto (último toque): "expira mañana y nunca la abrió".
        const expiracion = derivarExpiracionClaim(r)
        const trialFin = subRow?.estado === 'trial' ? (subRow.trialFin ?? null) : null

        return {
          id: r.id,
          nombre: r.nombre,
          username: r.username,
          email: r.email,
          telefono: r.telefono,
          // Identidad de login por WhatsApp: sólo cuenta si está verificado. Liberar el número =
          // poner esto en false (deja de ocupar el teléfono para altas nuevas). Campo aditivo.
          telefonoVerificado: r.telefonoVerificado,
          planId: sus.planId,
          planCodigo: sus.planCodigo,
          planNombre: sus.planNombre,
          estado: sus.estado,
          sinSuscripcion: sus.sinSuscripcion,
          suscripcion: {
            configuracion: sus.configuracion,
            ciclo: sus.ciclo,
            fechaProximoCobro: sus.fechaProximoCobro,
            precioBaseMensual: sus.precioBaseMensual,
            montoModulosMensual: sus.montoModulosMensual,
            montoTotalMensual: sus.montoTotalMensual,
          },
          modulos: modulos
            .filter((modulo) => modulo.activoAhora)
            .map((modulo) => ({
              codigo: modulo.codigo,
              tipo: modulo.tipo,
              estado: modulo.estado,
              origen: modulo.origen,
              precioMensual: modulo.precioMensualCongelado ?? modulo.precioMensual,
            })),
          // Claim flow (outbound). Campos aditivos: los admins/paneles viejos los ignoran.
          origen: r.origen,
          pipeline,
          claim: {
            token: r.claimToken,
            url: r.claimToken ? buildClaimUrl(r.claimToken) : null,
            expira: r.claimTokenExpira,
            vigente: claimVigente,
            claimedAt: r.claimedAt,
            // Expiración derivada del prospecto (aditivo): alerta el último toque del follow-up.
            diasParaExpirar: expiracion.diasParaExpirar,
            alertaExpiracion: expiracion.alerta,
          },
          trial: {
            trialFin,
            diasRestantes: diasHasta(trialFin),
          },
          mensajes: {
            ilimitado: wallet.ilimitado,
            disponible: wallet.utility.disponible,
            cupoPlan: wallet.utility.cupoPlan,
            pctConsumido: wallet.utility.pctConsumido,
          },
          // WhatsApp: número propio del local (OAuth oficial o cargado a mano desde este panel
          // mientras el OAuth de Meta está en verificación). Nunca devolvemos el token (secreto);
          // solo si hay uno cargado (`tieneToken`). Sin token propio → se usa el System User de Piru.
          whatsapp: {
            enabled: r.whatsappEnabled,
            numero: r.whatsappNumber,
            phoneId: r.whatsappPhoneId,
            wabaId: r.whatsappWabaId,
            tieneToken: !!r.whatsappAccessToken,
          },
        }
      }),
    )

    return c.json({ success: true, data }, 200)
  } catch (error) {
    console.error('Error listando locales (interno):', error)
    return c.json({ success: false, message: 'Error al obtener los locales' }, 500)
  }
})

/** Configuración única que el fundador puede asignar o renovar manualmente. */
internoRoute.get('/suscripcion', async (c) => {
  const db = drizzle(pool)
  try {
    const configuracion = await obtenerConfiguracionSuscripcion(db)
    if (!configuracion || !configuracion.activo) {
      return c.json({ success: false, message: 'La suscripción Piru no está disponible' }, 404)
    }
    return c.json({ success: true, data: configuracion }, 200)
  } catch (error) {
    console.error('Error obteniendo suscripción (interno):', error)
    return c.json({ success: false, message: 'Error al obtener la suscripción' }, 500)
  }
})

/**
 * Alta o renovación manual de la única suscripción. No crea comprobantes de pago:
 * es una concesión explícita del fundador para operaciones de outreach. T07 agregará
 * el checkout y los ítems auditables para el flujo comercial normal.
 */
const asignarSuscripcionSchema = z.object({
  ciclo: z.enum(['mensual', 'anual']).optional(),
})

internoRoute.put(
  '/locales/:id/suscripcion',
  zValidator('json', asignarSuscripcionSchema),
  async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number(c.req.param('id'))
    if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
      return c.json({ success: false, message: 'Local inválido' }, 400)
    }

    const { ciclo: cicloInput } = c.req.valid('json')
    const ciclo: CicloPago = cicloInput === 'anual' ? 'anual' : 'mensual'

    try {
      const [rest] = await db
        .select({ id: RestauranteTable.id })
        .from(RestauranteTable)
        .where(eq(RestauranteTable.id, restauranteId))
        .limit(1)
      if (!rest) {
        return c.json({ success: false, message: 'Local no encontrado' }, 404)
      }

      const [configuracion, planCompatibilidad, actual] = await Promise.all([
        obtenerConfiguracionSuscripcion(db),
        db.select({ id: PlanTable.id })
          .from(PlanTable)
          .where(eq(PlanTable.codigo, 'basico'))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db.select().from(SuscripcionTable)
          .where(eq(SuscripcionTable.restauranteId, restauranteId))
          .limit(1)
          .then((rows) => rows[0] ?? null),
      ])
      if (!configuracion?.activo || !planCompatibilidad) {
        return c.json({ success: false, message: 'Falta configurar la suscripción Piru' }, 409)
      }

      const ahora = new Date()
      const meses = ciclo === 'anual' ? 12 : 1
      const proximoActual = actual?.fechaProximoCobro ? new Date(actual.fechaProximoCobro) : null
      const base = actual?.estado === 'activa' && actual.ciclo === ciclo && proximoActual && proximoActual > ahora
        ? proximoActual
        : ahora
      const periodoHasta = sumarMeses(base, meses)
      const precioBase = configuracion.precioMensual

      if (actual) {
        await db.update(SuscripcionTable).set({
          planId: planCompatibilidad.id,
          configuracionSuscripcionId: configuracion.id,
          estado: 'activa',
          ciclo,
          fechaInicio: actual.fechaInicio ?? ahora,
          trialFin: null,
          fechaProximoCobro: periodoHasta,
          graciaHasta: null,
          fechaCancelacion: null,
          precioMensual: precioBase,
          precioBaseMensual: precioBase,
          montoModulosMensual: '0.00',
          montoTotalMensual: precioBase,
          updatedAt: ahora,
        }).where(eq(SuscripcionTable.restauranteId, restauranteId))
      } else {
        await db.insert(SuscripcionTable).values({
          restauranteId,
          planId: planCompatibilidad.id,
          configuracionSuscripcionId: configuracion.id,
          estado: 'activa',
          ciclo,
          fechaInicio: ahora,
          fechaProximoCobro: periodoHasta,
          precioMensual: precioBase,
          precioBaseMensual: precioBase,
          montoModulosMensual: '0.00',
          montoTotalMensual: precioBase,
        })
      }

      // Los snapshots son sólo de lectura rápida. La fuente de importes sigue
      // siendo catálogo + entitlements, resuelta centralmente.
      const importe = await resolverImporteMensual(db, restauranteId)
      await db.update(SuscripcionTable).set({
        montoModulosMensual: importe.montoModulosMensual.toFixed(2),
        montoTotalMensual: importe.montoTotalMensual.toFixed(2),
        updatedAt: new Date(),
      }).where(eq(SuscripcionTable.restauranteId, restauranteId))

      return c.json({
        success: true,
        data: { configuracion, ciclo, fechaProximoCobro: periodoHasta, ...importe },
      }, 200)
    } catch (error) {
      console.error('Error asignando suscripción (interno):', error)
      return c.json({ success: false, message: 'Error al asignar la suscripción' }, 500)
    }
  },
)

/** Catálogo operativo para la asignación manual desde el panel interno. */
internoRoute.get('/modulos', async (c) => {
  const db = drizzle(pool)
  try {
    const modulos = resolverRepresentacionCanonicaCrecimiento(await db.select().from(ModuloTable)
      .where(eq(ModuloTable.activo, true))
      .orderBy(asc(ModuloTable.orden), asc(ModuloTable.id)))
    return c.json({ success: true, data: modulos }, 200)
  } catch (error) {
    console.error('Error obteniendo módulos (interno):', error)
    return c.json({ success: false, message: 'Error al obtener los módulos' }, 500)
  }
})

const asignarModuloSchema = z.object({ activo: z.boolean() })

/**
 * Asignación manual explícita. A diferencia de la API del restaurante, el
 * fundador puede conceder un módulo pago sin checkout; queda marcado
 * `origen='interno'` y con precio congelado para que T07 lo incluya en la
 * factura siguiente. Nunca se asignan módulos por ausencia de suscripción.
 */
internoRoute.put(
  '/locales/:id/modulos/:codigo',
  zValidator('json', asignarModuloSchema),
  async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number(c.req.param('id'))
    const codigo = c.req.param('codigo')
    if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
      return c.json({ success: false, message: 'Local inválido' }, 400)
    }
    if (!/^[a-z0-9_]{1,100}$/.test(codigo)) {
      return c.json({ success: false, message: 'Código de módulo inválido' }, 400)
    }

    try {
      const { activo } = c.req.valid('json')
      const [restaurante, modulo, suscripcion] = await Promise.all([
        db.select({ id: RestauranteTable.id }).from(RestauranteTable)
          .where(eq(RestauranteTable.id, restauranteId)).limit(1).then((rows) => rows[0] ?? null),
        db.select().from(ModuloTable)
          .where(and(eq(ModuloTable.codigo, codigo), eq(ModuloTable.activo, true))).limit(1)
          .then((rows) => rows[0] ?? null),
        resolverSuscripcionUnica(db, restauranteId),
      ])
      if (!restaurante) return c.json({ success: false, message: 'Local no encontrado' }, 404)
      if (!modulo) return c.json({ success: false, message: 'Módulo no encontrado' }, 404)
      if (activo && !modulo.activable) {
        return c.json({ success: false, message: 'Este módulo ya no admite nuevas activaciones' }, 409)
      }

      const suscripcionPermitePago = suscripcion.estado === 'activa' || suscripcion.estado === 'pago_pendiente'
      if (activo && modulo.tipo === 'pago' && !suscripcionPermitePago) {
        return c.json({
          success: false,
          message: 'Primero asigná una suscripción activa; el trial no incluye módulos pagos',
        }, 409)
      }

      const ahora = new Date()
      await db.insert(RestauranteModuloTable).values({
        restauranteId,
        moduloId: modulo.id,
        estado: activo ? 'activo' : 'inactivo',
        activadoAt: activo ? ahora : null,
        desactivadoAt: activo ? null : ahora,
        vigenteHasta: activo && modulo.tipo === 'pago' ? suscripcion.fechaProximoCobro : null,
        precioMensualCongelado: modulo.tipo === 'pago' ? modulo.precioMensual : null,
        origen: 'interno',
        cancelarAlFinPeriodo: false,
      }).onDuplicateKeyUpdate({
        set: {
          estado: activo ? 'activo' : 'inactivo',
          activadoAt: activo ? ahora : null,
          desactivadoAt: activo ? null : ahora,
          vigenteHasta: activo && modulo.tipo === 'pago' ? suscripcion.fechaProximoCobro : null,
          precioMensualCongelado: modulo.tipo === 'pago' ? modulo.precioMensual : null,
          origen: 'interno',
          cancelarAlFinPeriodo: false,
          updatedAt: ahora,
        },
      })

      const [modulos, importe] = await Promise.all([
        resolverModulosRestaurante(db, restauranteId),
        resolverImporteMensual(db, restauranteId),
      ])
      if (!suscripcion.sinSuscripcion) {
        await db.update(SuscripcionTable).set({
          montoModulosMensual: importe.montoModulosMensual.toFixed(2),
          montoTotalMensual: importe.montoTotalMensual.toFixed(2),
          updatedAt: new Date(),
        }).where(eq(SuscripcionTable.restauranteId, restauranteId))
      }
      return c.json({
        success: true,
        data: modulos.find((item) => item.codigo === codigo),
      }, 200)
    } catch (error) {
      console.error('Error asignando módulo (interno):', error)
      return c.json({ success: false, message: 'Error al asignar el módulo' }, 500)
    }
  },
)

/**
 * Alta/edición a mano del número de WhatsApp de un local (Meta Cloud API), SIN pasar por el
 * OAuth oficial de Meta. Es el puente mientras el OAuth está en verificación: Piru compra un
 * chip, lo da de alta como número en su propia Meta Business, y acá carga el `phoneId` para que
 * los avisos de ese local salgan DESDE su número (con su marca) en vez del número de Piru.
 *
 * Campos:
 *  - phoneId  (requerido para conectar): el "Phone number ID" de Meta (NO el número de teléfono).
 *  - numero   (opcional): el número legible para mostrar (ej: +54 9 351 ...).
 *  - wabaId   (opcional): WhatsApp Business Account ID.
 *  - accessToken (opcional): SOLO si el número vive bajo otra app/token que el System User de
 *    plataforma. Si el número está bajo la Meta Business de Piru, dejarlo vacío → se reusa
 *    `WHATSAPP_API_TOKEN` (el mismo token cubre todos los números del negocio).
 *
 * Semántica del token (para no pisar un token existente sin querer): si `accessToken` viene
 * `undefined` (no se manda la key) se deja como está; si viene string vacío o null se BORRA
 * (pasa a usar el token de plataforma); si viene con valor se guarda.
 *
 * Para DESCONECTAR: mandar `phoneId: null` → limpia todos los campos y deja `whatsappEnabled=false`
 * (los avisos vuelven a salir por el número de Piru).
 */
const whatsappSchema = z.object({
  phoneId: z.string().trim().min(1).nullable(),
  numero: z.string().trim().nullable().optional(),
  wabaId: z.string().trim().nullable().optional(),
  accessToken: z.string().trim().nullable().optional(),
})

internoRoute.put(
  '/locales/:id/whatsapp',
  zValidator('json', whatsappSchema),
  async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number(c.req.param('id'))
    if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
      return c.json({ success: false, message: 'Local inválido' }, 400)
    }

    const { phoneId, numero, wabaId, accessToken } = c.req.valid('json')

    try {
      const [rest] = await db
        .select({ id: RestauranteTable.id })
        .from(RestauranteTable)
        .where(eq(RestauranteTable.id, restauranteId))
        .limit(1)
      if (!rest) {
        return c.json({ success: false, message: 'Local no encontrado' }, 404)
      }

      // Desconexión: phoneId null → limpiar todo.
      if (phoneId === null) {
        await db.update(RestauranteTable)
          .set({
            whatsappPhoneId: null,
            whatsappNumber: null,
            whatsappWabaId: null,
            whatsappAccessToken: null,
            whatsappTokenExpiry: null,
            whatsappEnabled: false,
          })
          .where(eq(RestauranteTable.id, restauranteId))
        return c.json({ success: true, data: { conectado: false } }, 200)
      }

      // Conexión/edición.
      const set: Record<string, unknown> = {
        whatsappPhoneId: phoneId,
        whatsappEnabled: true,
      }
      if (numero !== undefined) set.whatsappNumber = numero || null
      if (wabaId !== undefined) set.whatsappWabaId = wabaId || null
      // Token: solo tocar si la key vino en el body. Vacío/null → borrar (usa token de plataforma).
      if (accessToken !== undefined) set.whatsappAccessToken = accessToken || null

      await db.update(RestauranteTable)
        .set(set)
        .where(eq(RestauranteTable.id, restauranteId))

      return c.json({ success: true, data: { conectado: true } }, 200)
    } catch (error) {
      console.error('Error configurando WhatsApp (interno):', error)
      return c.json({ success: false, message: 'Error al configurar WhatsApp' }, 500)
    }
  },
)

/**
 * Liberar / reactivar el NÚMERO DE WHATSAPP (identidad de login) de una cuenta.
 *
 * El problema que resuelve: la identidad de login por WhatsApp es `telefono + telefonoVerificado=true`,
 * y es única a nivel app. Con un solo número de prueba no se pueden tener dos cuentas verificadas con
 * él. "Liberar" (verificado=false) saca el número del pool de unicidad → se puede crear OTRA cuenta
 * (por teléfono o por claim) con el mismo número. La cuenta liberada sigue existiendo (entra por email
 * si tiene contraseña), sólo pierde el login por WhatsApp.
 *
 * Reactivar (verificado=true) exige que NINGUNA otra cuenta tenga ese número verificado (si no, habría
 * dos identidades iguales y el login sería ambiguo) → 409 en ese caso.
 */
const telefonoVerificadoSchema = z.object({ verificado: z.boolean() })

// El teléfono de identidad se guarda igual que en auth/claim: sólo dígitos en formato
// internacional. El panel interno es una vía administrativa, por lo que si la cuenta ya estaba
// verificada conserva ese estado; antes de cambiarlo se protege la unicidad del login.
const telefonoSchema = z.object({
  telefono: z.string().trim().min(8).max(30),
})

internoRoute.put(
  '/locales/:id/telefono',
  zValidator('json', telefonoSchema),
  async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number(c.req.param('id'))
    if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
      return c.json({ success: false, message: 'Local inválido' }, 400)
    }

    const telefono = c.req.valid('json').telefono.replace(/\D/g, '')
    if (telefono.length < 8 || telefono.length > 20) {
      return c.json({ success: false, message: 'Ingresá un número internacional válido (8 a 20 dígitos)' }, 400)
    }

    try {
      const [rest] = await db
        .select({ id: RestauranteTable.id, telefonoVerificado: RestauranteTable.telefonoVerificado })
        .from(RestauranteTable)
        .where(eq(RestauranteTable.id, restauranteId))
        .limit(1)
      if (!rest) {
        return c.json({ success: false, message: 'Local no encontrado' }, 404)
      }

      // Una cuenta verificada puede iniciar sesión con su teléfono. No permitir que la edición
      // administrativa vuelva ambigua esa identidad. Las cuentas liberadas sí pueden repetirlo.
      if (rest.telefonoVerificado) {
        const [otra] = await db
          .select({ id: RestauranteTable.id })
          .from(RestauranteTable)
          .where(and(
            eq(RestauranteTable.telefono, telefono),
            eq(RestauranteTable.telefonoVerificado, true),
          ))
          .limit(1)
        if (otra && otra.id !== restauranteId) {
          return c.json({ success: false, message: 'Otra cuenta ya tiene ese número verificado. Liberala primero.' }, 409)
        }
      }

      await db
        .update(RestauranteTable)
        .set({ telefono })
        .where(eq(RestauranteTable.id, restauranteId))

      return c.json({
        success: true,
        data: { telefono, telefonoVerificado: rest.telefonoVerificado },
      }, 200)
    } catch (error) {
      console.error('Error cambiando teléfono del local (interno):', error)
      return c.json({ success: false, message: 'Error al actualizar el número' }, 500)
    }
  },
)

internoRoute.put(
  '/locales/:id/telefono-verificado',
  zValidator('json', telefonoVerificadoSchema),
  async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number(c.req.param('id'))
    if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
      return c.json({ success: false, message: 'Local inválido' }, 400)
    }

    const { verificado } = c.req.valid('json')

    try {
      const [rest] = await db
        .select({ id: RestauranteTable.id, telefono: RestauranteTable.telefono })
        .from(RestauranteTable)
        .where(eq(RestauranteTable.id, restauranteId))
        .limit(1)
      if (!rest) {
        return c.json({ success: false, message: 'Local no encontrado' }, 404)
      }

      // Reactivar: no permitir dos cuentas verificadas con el mismo número.
      if (verificado) {
        const tel = (rest.telefono || '').replace(/\D/g, '')
        if (tel.length < 8) {
          return c.json({ success: false, message: 'Esta cuenta no tiene un número de WhatsApp cargado' }, 400)
        }
        const [otra] = await db
          .select({ id: RestauranteTable.id })
          .from(RestauranteTable)
          .where(and(
            eq(RestauranteTable.telefono, rest.telefono as string),
            eq(RestauranteTable.telefonoVerificado, true),
          ))
          .limit(1)
        if (otra && otra.id !== restauranteId) {
          return c.json({ success: false, message: 'Otra cuenta ya tiene ese número verificado. Liberala primero.' }, 409)
        }
      }

      await db
        .update(RestauranteTable)
        .set({ telefonoVerificado: verificado })
        .where(eq(RestauranteTable.id, restauranteId))

      return c.json({ success: true, data: { telefonoVerificado: verificado } }, 200)
    } catch (error) {
      console.error('Error cambiando verificación de teléfono (interno):', error)
      return c.json({ success: false, message: 'Error al actualizar el número' }, 500)
    }
  },
)

/**
 * Genera (o regenera) el LINK DE RECLAMO de una tienda outbound. Marca la cuenta como
 * `origen='outbound'` y devuelve la URL para compartirle al prospecto por WhatsApp
 * ("Te dejo el acceso al panel de tu tienda: [link]"). Regenerar invalida el link anterior.
 */
internoRoute.post('/locales/:id/claim-link', async (c) => {
  const db = drizzle(pool)
  const restauranteId = Number(c.req.param('id'))
  if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
    return c.json({ success: false, message: 'Local inválido' }, 400)
  }

  try {
    const [rest] = await db
      .select({ id: RestauranteTable.id })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)
    if (!rest) {
      return c.json({ success: false, message: 'Local no encontrado' }, 404)
    }

    const { token, url, expira } = await generarClaimLink(db, restauranteId)
    return c.json({ success: true, data: { token, url, expira } }, 200)
  } catch (error) {
    console.error('Error generando link de reclamo (interno):', error)
    return c.json({ success: false, message: 'Error al generar el link de reclamo' }, 500)
  }
})

/**
 * ⚠️ SOLO PRUEBAS DEL FUNDADOR. Reinicia el estado de reclamo de una tienda para poder volver a
 * correr el flujo de claim después de haberlo probado uno mismo (si no, el preview responde "Esta
 * tienda ya es tuya"). Limpia `claimedAt`, libera el número de login (`telefonoVerificado=false`) y
 * reextiende el link de reclamo (reusa el mismo token si existe; genera uno si no). NO toca el menú,
 * los pagos ni la suscripción: solo reabre la puerta del reclamo.
 */
internoRoute.post('/locales/:id/reset-claim', async (c) => {
  const db = drizzle(pool)
  const restauranteId = Number(c.req.param('id'))
  if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
    return c.json({ success: false, message: 'Local inválido' }, 400)
  }

  try {
    const [rest] = await db
      .select({ id: RestauranteTable.id, claimToken: RestauranteTable.claimToken })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)
    if (!rest) {
      return c.json({ success: false, message: 'Local no encontrado' }, 404)
    }

    // Reabrir el reclamo: sin fecha de reclamo, número liberado y link vigente de nuevo.
    await db
      .update(RestauranteTable)
      .set({
        claimedAt: null,
        telefonoVerificado: false,
        origen: 'outbound',
        claimTokenExpira: new Date(Date.now() + CLAIM_TOKEN_TTL_DIAS * 24 * 60 * 60 * 1000),
      })
      .where(eq(RestauranteTable.id, restauranteId))

    // Si la cuenta no tenía token de reclamo, generamos uno ahora.
    let token = rest.claimToken
    if (!token) {
      const gen = await generarClaimLink(db, restauranteId)
      token = gen.token
    }

    return c.json({ success: true, data: { token, url: buildClaimUrl(token) } }, 200)
  } catch (error) {
    console.error('Error reiniciando el reclamo (interno):', error)
    return c.json({ success: false, message: 'Error al reiniciar el reclamo' }, 500)
  }
})

/**
 * Arranca el TRIAL de 5 días de un local. ⚠️ El reloj de la prueba arranca ACÁ (cuando el
 * fundador lo decide), no en el claim ni en el registro. Deja la cuenta con acceso a la
 * suscripción base sin pagar; al vencer, el motor de estados lazy la lleva a pago_pendiente →
 * suspendida. Los módulos pagos nunca se incluyen. `dias` es opcional (default: 5).
 */
const trialSchema = z.object({
  dias: z.number().int().positive().max(90).optional(),
})

internoRoute.post('/locales/:id/trial', zValidator('json', trialSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = Number(c.req.param('id'))
  if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
    return c.json({ success: false, message: 'Local inválido' }, 400)
  }

  const { dias } = c.req.valid('json')

  try {
    const [rest] = await db
      .select({ id: RestauranteTable.id })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)
    if (!rest) {
      return c.json({ success: false, message: 'Local no encontrado' }, 404)
    }

    const res = await iniciarTrial(db, restauranteId, dias ?? DIAS_TRIAL_DEFAULT)
    if (!res) {
      return c.json({ success: false, message: 'Suscripción Piru no configurada' }, 409)
    }

    // El trial habilita el panel (estado 'trial' → conAccesoAPago), pero al vencer debe caer en el
    // paywall: por eso marcamos la cuenta como que requiere suscripción.
    await db
      .update(RestauranteTable)
      .set({ requiereSuscripcion: true, origen: 'outbound' })
      .where(eq(RestauranteTable.id, restauranteId))

    return c.json({
      success: true,
      data: {
        estado: 'trial',
        configuracionSuscripcionId: res.configuracionSuscripcionId,
        // Alias de compatibilidad para consumidores internos anteriores.
        planId: res.planId,
        trialFin: res.trialFin,
      },
    }, 200)
  } catch (error) {
    console.error('Error iniciando trial (interno):', error)
    return c.json({ success: false, message: 'Error al iniciar la prueba' }, 500)
  }
})

/**
 * ⚠️ ELIMINACIÓN TOTAL Y PERMANENTE de un local. Borra la cuenta del restaurante y, EN CASCADA,
 * TODO lo que cuelga de ella: menú (productos, variantes, ingredientes, agregados, categorías,
 * etiquetas, puntos), pedidos de todos los sistemas (unificado + legacy pedido/delivery/takeaway
 * con sus items, pagos y subtotales), clientes y su CRM (recupero, campañas y cola del Motor de
 * Recompra), sucursales, repartidores, zonas y horarios, mesas/salas, notificaciones, mensajes y
 * conversaciones de WhatsApp, y todo el billing (suscripción, wallet de mensajes, transacciones,
 * recargas, pagos de suscripción). NO es reversible.
 *
 * Implementación: una sola conexión del pool, dentro de una transacción, con FOREIGN_KEY_CHECKS
 * desactivado para no depender del orden exacto de las FK (el schema tiene FKs sin ON DELETE
 * CASCADE y tablas legacy). Se enumeran TODAS las tablas con `restaurante_id`, más las tablas hijas
 * que cuelgan por pedido/producto (que no tienen `restaurante_id` propio y se resuelven por subquery
 * contra su padre — por eso se borran ANTES que el padre). FOREIGN_KEY_CHECKS se restaura SIEMPRE
 * en la misma sesión antes de soltar la conexión al pool.
 *
 * Los planes (`plan`, `plan_feature`, `pack_recarga`) son globales de la plataforma: NO se tocan.
 */
internoRoute.delete('/locales/:id', async (c) => {
  const restauranteId = Number(c.req.param('id'))
  if (!Number.isInteger(restauranteId) || restauranteId <= 0) {
    return c.json({ success: false, message: 'Local inválido' }, 400)
  }

  const conn = await pool.getConnection()
  try {
    // Existe? (con un mensaje claro antes de destruir nada)
    const [rows]: any = await conn.query('SELECT id FROM restaurante WHERE id = ? LIMIT 1', [restauranteId])
    if (!Array.isArray(rows) || rows.length === 0) {
      return c.json({ success: false, message: 'Local no encontrado' }, 404)
    }

    // Hijas por pedido/producto: se resuelven por subquery contra el padre → van PRIMERO (mientras
    // el padre todavía existe). params = cuántas veces aparece `?` en la sentencia.
    const grandchildren: Array<[string, number[]]> = [
      ['DELETE FROM item_pedido_unificado WHERE pedido_id IN (SELECT id FROM pedido_unificado WHERE restaurante_id = ?)', [restauranteId]],
      ['DELETE FROM item_pedido WHERE pedido_id IN (SELECT id FROM pedido WHERE restaurante_id = ?)', [restauranteId]],
      ['DELETE FROM pago_subtotal WHERE pedido_id IN (SELECT id FROM pedido WHERE restaurante_id = ?)', [restauranteId]],
      ['DELETE FROM item_pedido_delivery WHERE pedido_delivery_id IN (SELECT id FROM pedido_delivery WHERE restaurante_id = ?)', [restauranteId]],
      ['DELETE FROM item_pedido_takeaway WHERE pedido_takeaway_id IN (SELECT id FROM pedido_takeaway WHERE restaurante_id = ?)', [restauranteId]],
      ['DELETE FROM pago_suscripcion_item WHERE pago_suscripcion_id IN (SELECT id FROM pago_suscripcion WHERE restaurante_id = ?)', [restauranteId]],
      [
        'DELETE FROM pago WHERE pedido_id IN (SELECT id FROM pedido WHERE restaurante_id = ?) ' +
          'OR pedido_delivery_id IN (SELECT id FROM pedido_delivery WHERE restaurante_id = ?) ' +
          'OR pedido_takeaway_id IN (SELECT id FROM pedido_takeaway WHERE restaurante_id = ?) ' +
          'OR pedido_unificado_id IN (SELECT id FROM pedido_unificado WHERE restaurante_id = ?)',
        [restauranteId, restauranteId, restauranteId, restauranteId],
      ],
      ['DELETE FROM variante_producto WHERE producto_id IN (SELECT id FROM producto WHERE restaurante_id = ?)', [restauranteId]],
      ['DELETE FROM producto_ingrediente WHERE producto_id IN (SELECT id FROM producto WHERE restaurante_id = ?)', [restauranteId]],
      ['DELETE FROM producto_agregado WHERE producto_id IN (SELECT id FROM producto WHERE restaurante_id = ?)', [restauranteId]],
    ]

    // Tablas con `restaurante_id` propio. Con FOREIGN_KEY_CHECKS=0 el orden entre ellas es indistinto.
    const directas = [
      'etiqueta',
      'producto_puntos',
      'cola_recompra',
      'campana_recompra_cliente',
      'campana_recompra',
      'recupero_cliente',
      'mensaje_whatsapp',
      'whatsapp_conversacion',
      'notificacion',
      'pedido_unificado',
      'pedido_delivery',
      'pedido_takeaway',
      'pedido',
      'zona_delivery',
      'franja_horario_pedido',
      'horario_restaurante',
      'codigo_descuento',
      'registro_telefono',
      'cliente',
      'producto',
      'categoria',
      'ingrediente',
      'agregado',
      'sala',
      'mesa',
      'repartidor',
      'sucursal',
      'account_pool',
      'recarga_mensajes',
      'transaccion_mensajes',
      'saldo_mensajes',
      'restaurante_modulo',
      'pago_suscripcion',
      'suscripcion',
    ]

    await conn.beginTransaction()
    await conn.query('SET FOREIGN_KEY_CHECKS = 0')
    try {
      for (const [sql, params] of grandchildren) {
        await conn.query(sql, params)
      }
      for (const tabla of directas) {
        await conn.query(`DELETE FROM ${tabla} WHERE restaurante_id = ?`, [restauranteId])
      }
      await conn.query('DELETE FROM restaurante WHERE id = ?', [restauranteId])
      await conn.query('SET FOREIGN_KEY_CHECKS = 1')
      await conn.commit()
    } catch (e) {
      await conn.rollback()
      // Rehabilitar los checks en ESTA sesión antes de devolver la conexión al pool.
      await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {})
      throw e
    }

    return c.json({ success: true, data: { id: restauranteId, eliminado: true } }, 200)
  } catch (error) {
    console.error('Error eliminando local (interno):', error)
    return c.json({ success: false, message: 'Error al eliminar el local' }, 500)
  } finally {
    conn.release()
  }
})

export { internoRoute }
