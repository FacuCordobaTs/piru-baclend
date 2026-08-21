import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import {
  categoriaModulo as CategoriaModuloTable,
  modulo as ModuloTable,
  pagoSuscripcion as PagoSuscripcionTable,
  restauranteModulo as RestauranteModuloTable,
  restaurante as RestauranteTable,
  suscripcion as SuscripcionTable,
} from '../db/schema'
import { authMiddleware } from '../middleware/auth'
import { resolverModulosRestaurante } from '../lib/modulos'
import { crearFacturaSuscripcionPendiente } from '../lib/facturacion-suscripcion'
import { crearPreferenciaSuscripcionMP, pagosSuscripcionDisponibles } from '../lib/mp-suscripcion'
import { sendPaymentLinkWhatsApp } from '../services/whatsapp'
import { asegurarTurnoAbierto, finalizarTurnoAlDesactivar } from '../lib/turnos-caja'

const PAGO_LINK_TTL_MIN = 60

const codigoSchema = z.object({
  codigo: z.string().regex(/^[a-z0-9_]+$/, 'Código de módulo inválido').max(100),
})
const modulosRoute = new Hono().use('*', authMiddleware)

async function buscarModuloActivo(db: ReturnType<typeof drizzle>, codigo: string) {
  const [modulo] = await db
    .select()
    .from(ModuloTable)
    .where(and(eq(ModuloTable.codigo, codigo), eq(ModuloTable.activo, true)))
    .limit(1)
  return modulo ?? null
}

/** Catálogo data-driven. No expone Cucuru, que sigue fuera de este catálogo. */
modulosRoute.get('/catalogo', async (c) => {
  const db = drizzle(pool)
  try {
    const categorias = await db
      .select()
      .from(CategoriaModuloTable)
      .where(eq(CategoriaModuloTable.activo, true))
      .orderBy(asc(CategoriaModuloTable.orden), asc(CategoriaModuloTable.id))
    const modulos = await db
      .select()
      .from(ModuloTable)
      .where(eq(ModuloTable.activo, true))
      .orderBy(asc(ModuloTable.orden), asc(ModuloTable.id))

    return c.json({
      success: true,
      data: categorias.map((categoria) => ({
        ...categoria,
        modulos: modulos.filter((modulo) => modulo.categoriaId === categoria.id),
      })),
    })
  } catch (error) {
    console.error('Error obteniendo catálogo de módulos:', error)
    return c.json({ success: false, message: 'Error al obtener módulos' }, 500)
  }
})

/** Catálogo enriquecido con el entitlement del restaurante autenticado. */
modulosRoute.get('/mis-modulos', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  try {
    const [categorias, resueltos] = await Promise.all([
      db
        .select()
        .from(CategoriaModuloTable)
        .where(eq(CategoriaModuloTable.activo, true))
        .orderBy(asc(CategoriaModuloTable.orden), asc(CategoriaModuloTable.id)),
      resolverModulosRestaurante(db, restauranteId),
    ])

    const visibles = resueltos.filter((modulo) => modulo.activoCatalogo)
    return c.json({
      success: true,
      data: categorias.map((categoria) => ({
        ...categoria,
        modulos: visibles.filter((modulo) => modulo.categoriaId === categoria.id),
      })),
    })
  } catch (error) {
    console.error('Error obteniendo módulos del restaurante:', error)
    return c.json({ success: false, message: 'Error al obtener módulos' }, 500)
  }
})

modulosRoute.put('/:codigo/activar', zValidator('param', codigoSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const { codigo } = c.req.valid('param')
  try {
    const modulo = await buscarModuloActivo(db, codigo)
    if (!modulo) return c.json({ success: false, message: 'Módulo no encontrado' }, 404)
    if (!modulo.activable) return c.json({ success: false, message: 'Este módulo todavía no se puede activar' }, 409)

    if (modulo.tipo === 'pago') {
      // T07/T08 crearán checkout y sólo el webhook podrá activar la fila. No
      // dejamos una activación local que eluda el cobro.
      return c.json({
        success: false,
        paymentRequired: true,
        module: modulo.codigo,
        message: 'Este módulo requiere pago antes de activarse',
      }, 409)
    }

    const [actual] = await db
      .select({ estado: RestauranteModuloTable.estado })
      .from(RestauranteModuloTable)
      .where(and(eq(RestauranteModuloTable.restauranteId, restauranteId), eq(RestauranteModuloTable.moduloId, modulo.id)))
      .limit(1)
    if (actual?.estado === 'activo') {
      const modulos = await resolverModulosRestaurante(db, restauranteId)
      return c.json({
        success: true,
        idempotent: true,
        data: modulos.find((item) => item.codigo === codigo),
      })
    }

    const ahora = new Date()
    await db.insert(RestauranteModuloTable).values({
      restauranteId,
      moduloId: modulo.id,
      estado: 'activo',
      activadoAt: ahora,
      desactivadoAt: null,
      vigenteHasta: null,
      precioMensualCongelado: null,
      origen: 'usuario',
      cancelarAlFinPeriodo: false,
    }).onDuplicateKeyUpdate({
      set: {
        estado: 'activo',
        activadoAt: ahora,
        desactivadoAt: null,
        vigenteHasta: null,
        precioMensualCongelado: null,
        origen: 'usuario',
        cancelarAlFinPeriodo: false,
      },
    })

    if (codigo === 'cierre_turno_manual') await asegurarTurnoAbierto(db, restauranteId)

    const modulos = await resolverModulosRestaurante(db, restauranteId)
    const data = modulos.find((item) => item.codigo === codigo)
    return c.json({ success: true, idempotent: false, data })
  } catch (error) {
    console.error('Error activando módulo:', error)
    return c.json({ success: false, message: 'Error al activar módulo' }, 500)
  }
})

modulosRoute.put('/:codigo/desactivar', zValidator('param', codigoSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const { codigo } = c.req.valid('param')
  try {
    const modulo = await buscarModuloActivo(db, codigo)
    if (!modulo) return c.json({ success: false, message: 'Módulo no encontrado' }, 404)
    if (modulo.tipo === 'pago') {
      const [actual, sub] = await Promise.all([
        db.select().from(RestauranteModuloTable)
          .where(and(eq(RestauranteModuloTable.restauranteId, restauranteId), eq(RestauranteModuloTable.moduloId, modulo.id))).limit(1)
          .then((rows) => rows[0] ?? null),
        db.select({ fechaProximoCobro: SuscripcionTable.fechaProximoCobro })
          .from(SuscripcionTable).where(eq(SuscripcionTable.restauranteId, restauranteId)).limit(1)
          .then((rows) => rows[0] ?? null),
      ])
      if (!actual || actual.estado === 'inactivo' || actual.estado === 'suspendido') {
        return c.json({ success: true, idempotent: true, data: (await resolverModulosRestaurante(db, restauranteId)).find((item) => item.codigo === codigo) })
      }
      if (actual.estado === 'pendiente_pago') {
        return c.json({ success: false, message: 'El pago de activación todavía está pendiente' }, 409)
      }
      if (actual.estado === 'cancelacion_programada') {
        return c.json({ success: true, idempotent: true, data: (await resolverModulosRestaurante(db, restauranteId)).find((item) => item.codigo === codigo) })
      }

      const ahora = new Date()
      const hasta = sub?.fechaProximoCobro ? new Date(sub.fechaProximoCobro) : null
      if (hasta && hasta > ahora) {
        await db.update(RestauranteModuloTable).set({
          estado: 'cancelacion_programada',
          vigenteHasta: hasta,
          cancelarAlFinPeriodo: true,
          desactivadoAt: null,
          updatedAt: ahora,
        }).where(eq(RestauranteModuloTable.id, actual.id))
      } else {
        // Sin un período de suscripción vigente no hay cobertura facturable
        // que conservar, por lo que la baja es inmediata.
        await db.update(RestauranteModuloTable).set({
          estado: 'inactivo',
          vigenteHasta: null,
          cancelarAlFinPeriodo: false,
          desactivadoAt: ahora,
          updatedAt: ahora,
        }).where(eq(RestauranteModuloTable.id, actual.id))
      }
      const data = (await resolverModulosRestaurante(db, restauranteId)).find((item) => item.codigo === codigo)
      return c.json({ success: true, idempotent: false, data })
    }

    const [actual] = await db
      .select({ estado: RestauranteModuloTable.estado })
      .from(RestauranteModuloTable)
      .where(and(eq(RestauranteModuloTable.restauranteId, restauranteId), eq(RestauranteModuloTable.moduloId, modulo.id)))
      .limit(1)
    if (actual?.estado !== 'inactivo') {
      await db.update(RestauranteModuloTable).set({
        estado: 'inactivo',
        desactivadoAt: new Date(),
        vigenteHasta: null,
        precioMensualCongelado: null,
        origen: 'usuario',
        cancelarAlFinPeriodo: false,
      }).where(and(eq(RestauranteModuloTable.restauranteId, restauranteId), eq(RestauranteModuloTable.moduloId, modulo.id)))
    }
    if (codigo === 'cierre_turno_manual') await finalizarTurnoAlDesactivar(db, restauranteId)

    const modulos = await resolverModulosRestaurante(db, restauranteId)
    const data = modulos.find((item) => item.codigo === codigo)
    return c.json({ success: true, idempotent: actual === undefined || actual.estado === 'inactivo', data })
  } catch (error) {
    console.error('Error desactivando módulo:', error)
    return c.json({ success: false, message: 'Error al desactivar módulo' }, 500)
  }
})

/** Revierte una baja programada; si el período terminó, genera un nuevo checkout. */
modulosRoute.post('/:codigo/reactivar', zValidator('param', codigoSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const { codigo } = c.req.valid('param')
  try {
    const modulo = await buscarModuloActivo(db, codigo)
    if (!modulo) return c.json({ success: false, message: 'Módulo no encontrado' }, 404)
    if (modulo.tipo !== 'pago') return c.json({ success: false, message: 'Este módulo está incluido en tu suscripción' }, 409)
    if (!pagosSuscripcionDisponibles()) return c.json({ success: false, message: 'Pagos no disponibles temporalmente' }, 503)
    const [actual] = await db.select().from(RestauranteModuloTable)
      .where(and(eq(RestauranteModuloTable.restauranteId, restauranteId), eq(RestauranteModuloTable.moduloId, modulo.id))).limit(1)
    const ahora = new Date()
    if (actual?.estado === 'activo') {
      return c.json({ success: true, idempotent: true, data: (await resolverModulosRestaurante(db, restauranteId)).find((item) => item.codigo === codigo) })
    }
    if (actual?.estado === 'pendiente_pago') return c.json({ success: false, message: 'El pago de activación todavía está pendiente' }, 409)
    if (actual?.estado === 'cancelacion_programada' && (!actual.vigenteHasta || new Date(actual.vigenteHasta) > ahora)) {
      await db.update(RestauranteModuloTable).set({
        estado: 'activo', cancelarAlFinPeriodo: false, desactivadoAt: null, updatedAt: ahora,
      }).where(eq(RestauranteModuloTable.id, actual.id))
      return c.json({ success: true, idempotent: false, data: (await resolverModulosRestaurante(db, restauranteId)).find((item) => item.codigo === codigo) })
    }

    // Ya no hay cobertura: la reactivación es una nueva alta prorrateada y
    // queda pendiente hasta el webhook aprobado, igual que /checkout.
    const factura = await crearFacturaSuscripcionPendiente(db, restauranteId, { ciclo: 'mensual', soloModuloCodigo: codigo })
    await db.insert(RestauranteModuloTable).values({ restauranteId, moduloId: modulo.id, estado: 'pendiente_pago', origen: 'usuario', precioMensualCongelado: String(modulo.precioMensual), cancelarAlFinPeriodo: false })
      .onDuplicateKeyUpdate({ set: { estado: 'pendiente_pago', origen: 'usuario', precioMensualCongelado: String(modulo.precioMensual), cancelarAlFinPeriodo: false, updatedAt: ahora } })
    const pref = await crearPreferenciaSuscripcionMP({
      pagoId: factura.pagoId, titulo: `${modulo.nombre} · reactivación`, precio: factura.montoTotal,
      backUrl: `${(process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')}/dashboard/modulos?checkout=success`,
    })
    if (!pref.ok) return c.json({ success: false, message: 'Error al iniciar el pago' }, 502)
    await db.update(PagoSuscripcionTable).set({ mpPreferenceId: pref.preferenceId }).where(eq(PagoSuscripcionTable.id, factura.pagoId))
    return c.json({ success: true, data: { pagoId: factura.pagoId, url_pago: pref.initPoint, preference_id: pref.preferenceId, monto: factura.montoTotal.toFixed(2), items: factura.items } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error al reactivar el módulo'
    return c.json({ success: false, message }, 400)
  }
})

/**
 * Alta paga: factura únicamente el módulo hasta la renovación vigente de la
 * base (D3). La fila queda pendiente y T08 la activará sólo desde el webhook.
 */
modulosRoute.post('/:codigo/checkout', zValidator('param', codigoSchema), zValidator('json', z.object({ ciclo: z.enum(['mensual', 'anual']).optional() })), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const { codigo } = c.req.valid('param')
  const { ciclo: cicloInput } = c.req.valid('json')
  const ciclo = cicloInput === 'anual' ? 'anual' : 'mensual'
  if (!pagosSuscripcionDisponibles()) return c.json({ success: false, message: 'Pagos no disponibles temporalmente' }, 503)
  try {
    const modulo = await buscarModuloActivo(db, codigo)
    if (!modulo) return c.json({ success: false, message: 'Módulo no encontrado' }, 404)
    if (modulo.tipo !== 'pago') return c.json({ success: false, message: 'Este módulo está incluido en tu suscripción' }, 409)
    const [actual] = await db.select({ estado: RestauranteModuloTable.estado })
      .from(RestauranteModuloTable)
      .where(and(eq(RestauranteModuloTable.restauranteId, restauranteId), eq(RestauranteModuloTable.moduloId, modulo.id)))
      .limit(1)
    if (actual?.estado === 'activo') return c.json({ success: false, message: 'Este módulo ya está activo' }, 409)
    if (actual?.estado === 'cancelacion_programada') {
      return c.json({ success: false, message: 'El módulo sigue activo hasta el cierre; usá reactivar para conservarlo' }, 409)
    }
    const factura = await crearFacturaSuscripcionPendiente(db, restauranteId, { ciclo, soloModuloCodigo: codigo })
    await db.insert(RestauranteModuloTable).values({ restauranteId, moduloId: modulo.id, estado: 'pendiente_pago', origen: 'usuario', precioMensualCongelado: String(modulo.precioMensual) })
      .onDuplicateKeyUpdate({ set: { estado: 'pendiente_pago', origen: 'usuario', precioMensualCongelado: String(modulo.precioMensual), cancelarAlFinPeriodo: false } })
    const pref = await crearPreferenciaSuscripcionMP({
      pagoId: factura.pagoId, titulo: `${modulo.nombre} · activación`, precio: factura.montoTotal,
      backUrl: `${(process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')}/dashboard/modulos?checkout=success`,
    })
    if (!pref.ok) return c.json({ success: false, message: 'Error al iniciar el pago' }, 502)
    await db.update(PagoSuscripcionTable).set({ mpPreferenceId: pref.preferenceId }).where(eq(PagoSuscripcionTable.id, factura.pagoId))
    return c.json({ success: true, data: { pagoId: factura.pagoId, url_pago: pref.initPoint, preference_id: pref.preferenceId, monto: factura.montoTotal.toFixed(2), items: factura.items } })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error al iniciar el pago del módulo'
    return c.json({ success: false, message }, 400)
  }
})

/**
 * Variante móvil del checkout: crea una factura prorrateada con token y envía
 * al dueño el link público de pago. Igual que el checkout directo, el módulo
 * queda pendiente y sólo se activa desde el webhook aprobado.
 */
modulosRoute.post('/:codigo/pago-link-whatsapp', zValidator('param', codigoSchema), zValidator('json', z.object({ ciclo: z.enum(['mensual', 'anual']).optional() })), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id as number
  const { codigo } = c.req.valid('param')
  const { ciclo: cicloInput } = c.req.valid('json')
  const ciclo = cicloInput === 'anual' ? 'anual' : 'mensual'
  if (!pagosSuscripcionDisponibles()) return c.json({ success: false, message: 'Pagos no disponibles temporalmente' }, 503)

  try {
    const modulo = await buscarModuloActivo(db, codigo)
    if (!modulo) return c.json({ success: false, message: 'Módulo no encontrado' }, 404)
    if (modulo.tipo !== 'pago') return c.json({ success: false, message: 'Este módulo está incluido en tu suscripción' }, 409)

    const [actual, restaurante] = await Promise.all([
      db.select({ estado: RestauranteModuloTable.estado }).from(RestauranteModuloTable)
        .where(and(eq(RestauranteModuloTable.restauranteId, restauranteId), eq(RestauranteModuloTable.moduloId, modulo.id))).limit(1)
        .then((rows) => rows[0] ?? null),
      db.select({ telefono: RestauranteTable.telefono }).from(RestauranteTable)
        .where(eq(RestauranteTable.id, restauranteId)).limit(1).then((rows) => rows[0] ?? null),
    ])
    if (actual?.estado === 'activo') return c.json({ success: false, message: 'Este módulo ya está activo' }, 409)
    if (actual?.estado === 'cancelacion_programada') {
      return c.json({ success: false, message: 'El módulo sigue activo hasta el cierre; usá reactivar para conservarlo' }, 409)
    }

    const telefono = (restaurante?.telefono || '').replace(/\D/g, '')
    if (!telefono || telefono.length < 8) {
      return c.json({ success: false, message: 'No tenés un número de WhatsApp verificado en tu cuenta para recibir el link.' }, 400)
    }

    const token = randomUUID()
    const tokenExpiraEn = new Date(Date.now() + PAGO_LINK_TTL_MIN * 60 * 1000)
    const factura = await crearFacturaSuscripcionPendiente(db, restauranteId, { ciclo, soloModuloCodigo: codigo, token, tokenExpiraEn })
    await db.insert(RestauranteModuloTable).values({ restauranteId, moduloId: modulo.id, estado: 'pendiente_pago', origen: 'usuario', precioMensualCongelado: String(modulo.precioMensual), cancelarAlFinPeriodo: false })
      .onDuplicateKeyUpdate({ set: { estado: 'pendiente_pago', origen: 'usuario', precioMensualCongelado: String(modulo.precioMensual), cancelarAlFinPeriodo: false } })

    const monto = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(factura.montoTotal)
    const concepto = `${modulo.nombre} · activación${ciclo === 'anual' ? ' anual' : ''}`
    const envio = await sendPaymentLinkWhatsApp(c, { phone: telefono, concepto, monto, token })
    if (!envio.success) return c.json({ success: false, message: 'No se pudo enviar el link por WhatsApp. Probá de nuevo.' }, 502)

    const telefonoMask = telefono.length > 4 ? `••••${telefono.slice(-4)}` : telefono
    return c.json({ success: true, data: { enviado: true, telefono: telefonoMask, pagoId: factura.pagoId, monto: factura.montoTotal.toFixed(2) } }, 200)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error al enviar el link de pago del módulo'
    return c.json({ success: false, message }, 400)
  }
})

export { modulosRoute }
