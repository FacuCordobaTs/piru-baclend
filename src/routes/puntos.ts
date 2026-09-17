import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import { authMiddleware } from '../middleware/auth'
import { requireModulo } from '../middleware/modulo'
import { MODULE_KEYS } from '../lib/modulos'
import {
  ajusteManualPuntos,
  guardarConfiguracionPuntos,
  listarClientesConPuntos,
  listarMovimientosPuntos,
  listarTransaccionesCliente,
  obtenerClienteConPuntos,
  obtenerConfiguracionPuntos,
  resumenPuntos,
} from '../lib/puntos'

export const puntosRoute = new Hono()

puntosRoute.use('*', authMiddleware)

const decimalString = z.union([z.string(), z.number()]).transform((val) => {
  if (typeof val === 'number') {
    return val.toFixed(2)
  }
  const clean = String(val).trim()
  if (!clean) return '0.00'
  const num = parseFloat(clean)
  return isNaN(num) ? '0.00' : num.toFixed(2)
})

const guardarConfigSchema = z.object({
  activo: z.boolean().optional(),
  modoAcumulacion: z.enum(['monto', 'producto', 'ambos']).optional(),
  pesosPorPunto: z.number().int().min(1).optional(),
  puntosPrimerPedido: z.number().int().min(0).optional(),
  puntosMinimosCanje: z.number().int().min(0).optional(),
  permitirCanjeEnvioGratis: z.boolean().optional(),
  permiteCanjeEnvioGratis: z.boolean().optional(),
  puntosEnvioGratis: z.number().int().min(1).optional(),
  permitirCanjeDescuento: z.boolean().optional(),
  permiteCanjeDescuento: z.boolean().optional(),
  descuentoTipo: z.enum(['fijo', 'porcentaje', 'monto_fijo']).transform((v) => (v === 'monto_fijo' ? 'fijo' : v)).optional(),
  descuentoValor: decimalString.optional(),
  descuentoPuntosCosto: z.number().int().min(0).optional(),
  descuentoMontoMinimo: decimalString.optional(),
  descuentoTope: decimalString.optional(),
  vencimientoDias: z.number().int().min(1).nullable().optional(),
})

const ajusteManualSchema = z.object({
  puntos: z.number().int().refine((n) => n !== 0, {
    message: 'Los puntos de ajuste deben ser distintos de 0',
  }),
  motivo: z.string().trim().min(3, {
    message: 'Ingresá un motivo para el ajuste (mínimo 3 caracteres)',
  }),
})

// Tipos del ledger que el admin puede filtrar. `canje` es un pseudo-tipo que
// agrupa los tres canjes reales; no existe como valor en la base.
const tiposMovimientoQuery = [
  'suma_compra',
  'canje_producto',
  'canje_envio',
  'canje_descuento',
  'bonus_bienvenida',
  'ajuste_manual',
  'devolucion_cancelacion',
  'expiracion',
  'canje',
] as const

// Los query params llegan como string: se coercionan y se aceptan nulos
// (`optional()` rechazaría `null`, que es lo que envía un filtro vacío).
const clientesPuntosQuerySchema = z.object({
  busqueda: z.string().trim().max(120).nullish(),
  alcance: z.enum(['saldo', 'historial']).nullish(),
  orden: z.enum(['puntos', 'reciente', 'nombre']).nullish(),
  pagina: z.coerce.number().int().positive().nullish(),
  limite: z.coerce.number().int().positive().max(100).nullish(),
})

const movimientosPuntosQuerySchema = z.object({
  clienteId: z.coerce.number().int().positive().nullish(),
  tipo: z.enum(tiposMovimientoQuery).nullish(),
  busqueda: z.string().trim().max(120).nullish(),
  pagina: z.coerce.number().int().positive().nullish(),
  limite: z.coerce.number().int().positive().max(100).nullish(),
})

// Obtener configuración del programa de puntos
puntosRoute.get('/config', async (c) => {
  const db = drizzle(pool)
  const restauranteId = Number((c as any).user.id)
  try {
    const config = await obtenerConfiguracionPuntos(db, restauranteId)
    return c.json({ success: true, data: config })
  } catch (error: any) {
    console.error('Error al obtener configuración de puntos:', error)
    return c.json({ success: false, message: error.message || 'Error al obtener configuración' }, 500)
  }
})

// Guardar configuración del programa de puntos (requiere módulo activo)
puntosRoute.put('/config', requireModulo(MODULE_KEYS.PUNTOS_CLIENTES), zValidator('json', guardarConfigSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = Number((c as any).user.id)
  const payload = c.req.valid('json')

  const {
    permiteCanjeEnvioGratis,
    permiteCanjeDescuento,
    ...rest
  } = payload

  const datosParaGuardar: any = {
    ...rest,
    ...(permiteCanjeEnvioGratis !== undefined && { permitirCanjeEnvioGratis: permiteCanjeEnvioGratis }),
    ...(permiteCanjeDescuento !== undefined && { permitirCanjeDescuento: permiteCanjeDescuento }),
  }

  try {
    const configActualizada = await guardarConfiguracionPuntos(db, restauranteId, datosParaGuardar)
    return c.json({
      success: true,
      message: 'Configuración de puntos guardada correctamente',
      data: configActualizada,
    })
  } catch (error: any) {
    console.error('Error al guardar configuración de puntos:', error)
    return c.json({ success: false, message: error.message || 'Error al guardar configuración' }, 500)
  }
})

// Totales del Club de Puntos: saldo en circulación, otorgado, canjeado y uso reciente.
puntosRoute.get('/resumen', requireModulo(MODULE_KEYS.PUNTOS_CLIENTES), async (c) => {
  const db = drizzle(pool)
  const restauranteId = Number((c as any).user.id)
  try {
    const resumen = await resumenPuntos(db, restauranteId)
    return c.json({ success: true, data: resumen })
  } catch (error: any) {
    console.error('Error al obtener resumen de puntos:', error)
    return c.json({ success: false, message: error.message || 'Error al obtener resumen de puntos' }, 500)
  }
})

// Clientes con puntos: saldo, cuánto ganaron, cuánto canjearon y cuándo fue su último movimiento.
puntosRoute.get('/clientes', requireModulo(MODULE_KEYS.PUNTOS_CLIENTES), zValidator('query', clientesPuntosQuerySchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = Number((c as any).user.id)
  const filtros = c.req.valid('query')

  try {
    const listado = await listarClientesConPuntos(db, restauranteId, {
      busqueda: filtros.busqueda ?? null,
      alcance: filtros.alcance ?? 'saldo',
      orden: filtros.orden ?? 'puntos',
      pagina: filtros.pagina ?? 1,
      limite: filtros.limite ?? 25,
    })
    return c.json({ success: true, data: listado })
  } catch (error: any) {
    console.error('Error al listar clientes con puntos:', error)
    return c.json({ success: false, message: error.message || 'Error al listar clientes con puntos' }, 500)
  }
})

// Ledger global: todos los movimientos de puntos del restaurante, con filtros.
puntosRoute.get('/movimientos', requireModulo(MODULE_KEYS.PUNTOS_CLIENTES), zValidator('query', movimientosPuntosQuerySchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = Number((c as any).user.id)
  const filtros = c.req.valid('query')

  try {
    const listado = await listarMovimientosPuntos(db, restauranteId, {
      clienteId: filtros.clienteId ?? null,
      tipo: filtros.tipo ?? null,
      busqueda: filtros.busqueda ?? null,
      pagina: filtros.pagina ?? 1,
      limite: filtros.limite ?? 25,
    })
    return c.json({ success: true, data: listado })
  } catch (error: any) {
    console.error('Error al listar movimientos de puntos:', error)
    return c.json({ success: false, message: error.message || 'Error al listar movimientos de puntos' }, 500)
  }
})

// Obtener historial de puntos de un cliente
puntosRoute.get('/cliente/:clienteId/historial', requireModulo(MODULE_KEYS.PUNTOS_CLIENTES), async (c) => {
  const db = drizzle(pool)
  const restauranteId = Number((c as any).user.id)
  const clienteId = Number(c.req.param('clienteId'))

  if (!clienteId || isNaN(clienteId)) {
    return c.json({ success: false, message: 'ID de cliente inválido' }, 400)
  }

  try {
    const cliente = await obtenerClienteConPuntos(db, restauranteId, clienteId)
    if (!cliente) return c.json({ success: false, message: 'Cliente no encontrado' }, 404)
    const transacciones = await listarTransaccionesCliente(db, restauranteId, clienteId)
    return c.json({ success: true, data: { cliente, transacciones } })
  } catch (error: any) {
    console.error('Error al obtener historial de puntos:', error)
    return c.json({ success: false, message: error.message || 'Error al obtener historial' }, 500)
  }
})

// Ajuste manual de puntos a un cliente
puntosRoute.post('/cliente/:clienteId/ajuste', requireModulo(MODULE_KEYS.PUNTOS_CLIENTES), zValidator('json', ajusteManualSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = Number((c as any).user.id)
  const clienteId = Number(c.req.param('clienteId'))
  const { puntos, motivo } = c.req.valid('json')

  if (!clienteId || isNaN(clienteId)) {
    return c.json({ success: false, message: 'ID de cliente inválido' }, 400)
  }

  try {
    const resultado = await ajusteManualPuntos(db, restauranteId, clienteId, puntos, motivo)
    return c.json({
      success: true,
      message: `Ajuste de ${puntos > 0 ? '+' : ''}${puntos} puntos registrado con éxito`,
      data: resultado,
    })
  } catch (error: any) {
    console.error('Error al realizar ajuste manual de puntos:', error)
    return c.json({ success: false, message: error.message || 'Error al realizar ajuste' }, 400)
  }
})
