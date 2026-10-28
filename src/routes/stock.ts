import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { pool } from '../db'
import { authMiddleware } from '../middleware/auth'
import { requireModulo } from '../middleware/modulo'
import { MODULE_KEYS } from '../lib/modulos'
import {
  actualizarInsumo,
  alertasStock,
  cargarGasto,
  crearInsumo,
  eliminarInsumo,
  guardarConsumosProducto,
  resumenStock,
  UNIDADES_STOCK,
  type UnidadStock,
} from '../lib/stock'

const unidadSchema = z.enum(UNIDADES_STOCK as [UnidadStock, ...UnidadStock[]])

const crearInsumoSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre es obligatorio').max(255),
  unidad: unidadSchema.default('unidad'),
  stockInicial: z.number().min(0).nullish(),
  stockMinimo: z.number().min(0).nullish(),
  costoUnitario: z.number().min(0).nullish(),
})

const actualizarInsumoSchema = z.object({
  nombre: z.string().trim().min(1).max(255).optional(),
  unidad: unidadSchema.optional(),
  stockActual: z.number().optional(),
  stockMinimo: z.number().min(0).nullable().optional(),
  costoUnitario: z.number().min(0).nullable().optional(),
  activo: z.boolean().optional(),
})

const gastoSchema = z.object({
  descripcion: z.string().trim().min(1, 'Indicá una descripción').max(255),
  proveedor: z.string().trim().max(255).nullish(),
  fecha: z.string().nullish(),
  items: z.array(z.object({
    insumoId: z.number().int().positive(),
    cantidad: z.number().positive(),
    costoUnitario: z.number().min(0).default(0),
  })).min(1, 'Agregá al menos un insumo'),
})

const consumosSchema = z.object({
  consumos: z.array(z.object({
    insumoId: z.number().int().positive(),
    varianteId: z.number().int().positive().nullable().optional(),
    cantidad: z.number().positive(),
  })).max(500),
})

export const stockRoute = new Hono()
  .use('*', authMiddleware)
  .use('*', requireModulo(MODULE_KEYS.GESTION_STOCK))

  // Resumen completo: insumos, alertas, recetas de productos, compras y
  // últimos movimientos. Conciliar acá mantiene fresca la pantalla.
  .get('/', async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number((c as any).user.id)
    try {
      const data = await resumenStock(db, restauranteId)
      return c.json({ success: true, data })
    } catch (error) {
      console.error('Error obteniendo stock:', error)
      return c.json({ success: false, message: 'No se pudo cargar el stock' }, 500)
    }
  })

  // Lo consulta el Dashboard; el propio endpoint concilia los pedidos nuevos.
  .get('/alertas', async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number((c as any).user.id)
    try {
      const data = await alertasStock(db, restauranteId)
      return c.json({ success: true, data })
    } catch (error) {
      console.error('Error obteniendo alertas de stock:', error)
      return c.json({ success: false, message: 'No se pudieron cargar las alertas' }, 500)
    }
  })

  .post('/insumos', zValidator('json', crearInsumoSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number((c as any).user.id)
    const body = c.req.valid('json')
    try {
      const data = await crearInsumo(db, restauranteId, {
        nombre: body.nombre,
        unidad: body.unidad,
        stockInicial: body.stockInicial ?? null,
        stockMinimo: body.stockMinimo ?? null,
        costoUnitario: body.costoUnitario ?? null,
      })
      return c.json({ success: true, data }, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo crear el insumo'
      return c.json({ success: false, message }, 400)
    }
  })

  .put('/insumos/:id', zValidator('json', actualizarInsumoSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number((c as any).user.id)
    const id = Number(c.req.param('id'))
    const body = c.req.valid('json')
    if (!Number.isInteger(id) || id <= 0) return c.json({ success: false, message: 'Insumo inválido' }, 400)
    try {
      const data = await actualizarInsumo(db, restauranteId, id, body)
      if (!data) return c.json({ success: false, message: 'Insumo no encontrado' }, 404)
      return c.json({ success: true, data })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo actualizar el insumo'
      return c.json({ success: false, message }, 400)
    }
  })

  .delete('/insumos/:id', async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number((c as any).user.id)
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ success: false, message: 'Insumo inválido' }, 400)
    try {
      const resultado = await eliminarInsumo(db, restauranteId, id)
      if (!resultado.ok && resultado.motivo === 'no_encontrado') {
        return c.json({ success: false, message: 'Insumo no encontrado' }, 404)
      }
      if (!resultado.ok) {
        return c.json({
          success: false,
          message: 'Este insumo ya tiene compras o consumos. Desactivalo para dejar de controlarlo sin perder el historial.',
        }, 409)
      }
      return c.json({ success: true })
    } catch (error) {
      console.error('Error eliminando insumo:', error)
      return c.json({ success: false, message: 'No se pudo eliminar el insumo' }, 500)
    }
  })

  .post('/gastos', zValidator('json', gastoSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number((c as any).user.id)
    const body = c.req.valid('json')
    try {
      const data = await cargarGasto(db, restauranteId, {
        descripcion: body.descripcion,
        proveedor: body.proveedor ?? null,
        fecha: body.fecha ?? null,
        items: body.items,
      })
      return c.json({ success: true, data }, 201)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo cargar el gasto'
      return c.json({ success: false, message }, 400)
    }
  })

  .put('/productos/:id/consumos', zValidator('json', consumosSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = Number((c as any).user.id)
    const productoId = Number(c.req.param('id'))
    if (!Number.isInteger(productoId) || productoId <= 0) {
      return c.json({ success: false, message: 'Producto inválido' }, 400)
    }
    const body = c.req.valid('json')
    try {
      const resultado = await guardarConsumosProducto(db, restauranteId, productoId, body.consumos.map((consumo) => ({
        insumoId: consumo.insumoId,
        varianteId: consumo.varianteId ?? null,
        cantidad: consumo.cantidad,
      })))
      if (!resultado.ok) {
        const mensajes: Record<string, string> = {
          producto: 'Producto no encontrado',
          insumo: 'Algún insumo no pertenece a este local',
          variante: 'Alguna variante no pertenece a este producto',
        }
        return c.json({ success: false, message: mensajes[resultado.motivo] ?? 'No se pudo guardar el consumo' }, 400)
      }
      return c.json({ success: true, data: resultado })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo guardar el consumo'
      return c.json({ success: false, message }, 400)
    }
  })

export default stockRoute
