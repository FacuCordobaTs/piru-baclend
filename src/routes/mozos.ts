import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import {
  agregado as AgregadoTable,
  categoria as CategoriaTable,
  ingrediente as IngredienteTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  mesaLocal as MesaLocalTable,
  pedidoUnificado as PedidoUnificadoTable,
  producto as ProductoTable,
  productoAgregado as ProductoAgregadoTable,
  productoIngrediente as ProductoIngredienteTable,
  varianteProducto as VarianteProductoTable,
} from '../db/schema'
import { staffAuthMiddleware, type StaffContext } from '../middleware/staff'
import { MODULE_KEYS, tieneModuloActivo } from '../lib/modulos'
import { emitirEventoPedido } from '../lib/pedidos-activos'
import {
  ejecutarMutacionPos,
  reservarMesaLocal,
  resolverItemPos,
  respuestaPedidoEditable,
} from './pedido-unificado'

const ESTADOS_CERRADOS = ['archived', 'cancelled', 'delivered'] as const
const itemSchema = z.object({
  productoId: z.number().int().positive(),
  varianteId: z.number().int().positive().nullable().optional(),
  cantidad: z.number().int().positive(),
  ingredientesExcluidos: z.array(z.number().int().positive()).default([]),
  agregados: z.array(z.object({ id: z.number().int().positive() })).default([]),
})
const crearPedidoSchema = z.object({
  mesaLocalId: z.number().int().positive(),
  nombreCliente: z.string().trim().max(255).optional(),
  notas: z.string().trim().max(500).optional(),
  items: z.array(itemSchema).min(1).max(100),
})
const editarItemSchema = itemSchema.extend({ version: z.number().int().positive() })
const eliminarItemSchema = z.object({ version: z.number().int().positive() })
const editarPedidoSchema = z.object({
  version: z.number().int().positive(),
  nombreCliente: z.string().trim().max(255).nullable().optional(),
  notas: z.string().trim().max(500).nullable().optional(),
}).refine((body) => body.nombreCliente !== undefined || body.notas !== undefined, 'No hay cambios para guardar')

function staff(c: any) {
  return (c as StaffContext).staff
}

/**
 * La app de mozos opera sobre la sucursal del principal; si no tiene una
 * asignada, sobre todo el restaurante.
 */
async function requireMozoScope(c: any, next: any) {
  const principal = staff(c)
  const db = drizzle(pool)
  const [pos, mesas] = await Promise.all([
    tieneModuloActivo(db, principal.restauranteId, MODULE_KEYS.POS),
    tieneModuloActivo(db, principal.restauranteId, MODULE_KEYS.MESAS),
  ])
  if (!pos || !mesas) return c.json({ success: false, code: 'MODULO_REQUERIDO', message: 'La operación de mozos requiere los módulos POS y Mesas activos' }, 403)
  await next()
}

/** Un pedido del restaurante; si el mozo tiene sucursal, restringido a ella. */
async function pedidoEnAlcance(db: any, principal: ReturnType<typeof staff>, pedidoId: number) {
  const condiciones = [
    eq(PedidoUnificadoTable.id, pedidoId),
    eq(PedidoUnificadoTable.restauranteId, principal.restauranteId),
  ]
  if (principal.sucursalId != null) condiciones.push(eq(PedidoUnificadoTable.sucursalId, principal.sucursalId))
  const [pedido] = await db.select().from(PedidoUnificadoTable).where(and(...condiciones)).limit(1)
  return pedido ?? null
}

async function respuestaErrorMutacion(c: any, db: any, principal: ReturnType<typeof staff>, pedidoId: number, resultado: any) {
  const pedido = await respuestaPedidoEditable(db, principal.restauranteId, pedidoId)
  const code = resultado.error || 'ITEM_INVALIDO'
  const status = code === 'VERSION_CONFLICT' || code === 'PEDIDO_NO_EDITABLE' ? 409 : resultado.error === 'NOT_FOUND' ? 404 : 422
  return c.json({ success: false, code, message: resultado.message || 'No se pudo editar el pedido', data: { pedido } }, status)
}

const mozosRoute = new Hono()
  .use('*', staffAuthMiddleware)
  .use('*', requireMozoScope)

/** Catálogo reducido, con ETag: la PWA puede conservarlo y revalidarlo offline. */
mozosRoute.get('/menu', async (c) => {
  const db = drizzle(pool)
  const principal = staff(c)
  const productos = await db.select({
    id: ProductoTable.id, categoriaId: ProductoTable.categoriaId, nombre: ProductoTable.nombre,
    descripcion: ProductoTable.descripcion, precio: ProductoTable.precio, imagenUrl: ProductoTable.imagenUrl,
    descuento: ProductoTable.descuento, tieneVariantes: ProductoTable.tieneVariantes, orden: ProductoTable.orden,
  }).from(ProductoTable).where(and(eq(ProductoTable.restauranteId, principal.restauranteId), eq(ProductoTable.activo, true)))
    .orderBy(asc(ProductoTable.orden), asc(ProductoTable.id))
  const categorias = await db.select({ id: CategoriaTable.id, nombre: CategoriaTable.nombre })
    .from(CategoriaTable).where(eq(CategoriaTable.restauranteId, principal.restauranteId)).orderBy(asc(CategoriaTable.nombre))
  const data = await Promise.all(productos.map(async (producto) => {
    const [variantes, ingredientes, agregados] = await Promise.all([
      db.select({ id: VarianteProductoTable.id, nombre: VarianteProductoTable.nombre, precio: VarianteProductoTable.precio })
        .from(VarianteProductoTable).where(and(eq(VarianteProductoTable.productoId, producto.id), eq(VarianteProductoTable.activo, true))),
      db.select({ id: IngredienteTable.id, nombre: IngredienteTable.nombre })
        .from(ProductoIngredienteTable).innerJoin(IngredienteTable, eq(ProductoIngredienteTable.ingredienteId, IngredienteTable.id))
        .where(and(eq(ProductoIngredienteTable.productoId, producto.id), eq(IngredienteTable.activo, true))),
      db.select({ id: AgregadoTable.id, nombre: AgregadoTable.nombre, precio: AgregadoTable.precio })
        .from(ProductoAgregadoTable).innerJoin(AgregadoTable, eq(ProductoAgregadoTable.agregadoId, AgregadoTable.id))
        .where(and(eq(ProductoAgregadoTable.productoId, producto.id), eq(AgregadoTable.activo, true))),
    ])
    return { ...producto, variantes, ingredientes, agregados }
  }))
  const payload = { categorias, productos: data }
  const etag = `"${createHash('sha256').update(JSON.stringify(payload)).digest('base64url')}"`
  if (c.req.header('If-None-Match') === etag) return c.body(null, 304, { ETag: etag, 'Cache-Control': 'private, max-age=300, must-revalidate' })
  return c.json({ success: true, data: payload }, 200, { ETag: etag, 'Cache-Control': 'private, max-age=300, must-revalidate' })
})

/** Resumen mínimo para el grid táctil, limitado a la sucursal del principal (o a todo el restaurante si no tiene una). */
mozosRoute.get('/mesas', async (c) => {
  const db = drizzle(pool)
  const principal = staff(c)
  const condMesas = [eq(MesaLocalTable.restauranteId, principal.restauranteId), eq(MesaLocalTable.activo, true)]
  if (principal.sucursalId != null) condMesas.push(eq(MesaLocalTable.sucursalId, principal.sucursalId))
  const mesas = await db.select().from(MesaLocalTable).where(and(...condMesas)).orderBy(asc(MesaLocalTable.orden), asc(MesaLocalTable.id))
  const ids = mesas.map((mesa) => mesa.id)
  const condAbiertos = [eq(PedidoUnificadoTable.restauranteId, principal.restauranteId), inArray(PedidoUnificadoTable.mesaLocalId, ids), notInArray(PedidoUnificadoTable.estado, [...ESTADOS_CERRADOS])]
  if (principal.sucursalId != null) condAbiertos.push(eq(PedidoUnificadoTable.sucursalId, principal.sucursalId))
  const abiertos = ids.length ? await db.select({ id: PedidoUnificadoTable.id, mesaLocalId: PedidoUnificadoTable.mesaLocalId, estado: PedidoUnificadoTable.estado, total: PedidoUnificadoTable.total, version: PedidoUnificadoTable.version, updatedAt: PedidoUnificadoTable.updatedAt })
    .from(PedidoUnificadoTable).where(and(...condAbiertos)) : []
  const porMesa = new Map(abiertos.map((pedido) => [pedido.mesaLocalId, pedido]))
  return c.json({ success: true, data: mesas.map((mesa) => ({ ...mesa, pedido: porMesa.get(mesa.id) ?? null })) })
})

mozosRoute.get('/pedidos/:id{[0-9]+}', async (c) => {
  const db = drizzle(pool)
  const principal = staff(c)
  const pedidoId = Number(c.req.param('id'))
  const enAlcance = await pedidoEnAlcance(db, principal, pedidoId)
  if (!enAlcance) return c.json({ success: false, message: 'Pedido no encontrado' }, 404)
  return c.json({ success: true, data: await respuestaPedidoEditable(db, principal.restauranteId, pedidoId) })
})

mozosRoute.post('/pedidos', zValidator('json', crearPedidoSchema), async (c) => {
  const db = drizzle(pool)
  const principal = staff(c)
  const body = c.req.valid('json')
  const creado = await db.transaction(async (tx: any) => {
    const reserva = await reservarMesaLocal(tx, principal.restauranteId, body.mesaLocalId, principal.sucursalId)
    if ('error' in reserva) return reserva
    // Con sucursal asignada, la mesa debe ser de esa sucursal. Sin sucursal, el mozo
    // opera sobre cualquier mesa del restaurante y el pedido hereda la de la mesa.
    if (principal.sucursalId != null && reserva.mesa.sucursalId !== principal.sucursalId) return { error: 'MESA_SUCURSAL_INVALIDA' as const, message: 'La mesa no pertenece a tu sucursal' }
    const sucursalPedido = reserva.mesa.sucursalId ?? principal.sucursalId ?? null
    const items: any[] = []
    for (const entrada of body.items) {
      const item = await resolverItemPos(tx, principal.restauranteId, { ...entrada, version: 1 })
      if ('error' in item) return item
      items.push(item)
    }
    const total = items.reduce((sum, item) => sum + Number(item.precioUnitario) * item.cantidad, 0)
    const inserted = await tx.insert(PedidoUnificadoTable).values({
      restauranteId: principal.restauranteId, sucursalId: sucursalPedido, mesaLocalId: body.mesaLocalId,
      consumoEnLocal: true, tipo: 'mesa', estado: 'pending', total: total.toFixed(2),
      nombreCliente: body.nombreCliente || null, notas: body.notas || null, anotadoManualmente: true,
      pagado: false, creadoPorUsuarioId: principal.usuarioId,
    })
    const pedidoId = Number(inserted[0].insertId)
    await tx.insert(ItemPedidoUnificadoTable).values(items.map((item) => ({ pedidoId, ...item })))
    return { pedidoId, sucursalId: sucursalPedido }
  })
  if (!('pedidoId' in creado)) return c.json({ success: false, code: creado.error, message: creado.message }, creado.error === 'MESA_OCUPADA' ? 409 : 422)
  const data = await respuestaPedidoEditable(db, principal.restauranteId, creado.pedidoId)
  await emitirEventoPedido(db, { restauranteId: principal.restauranteId, pedidoId: creado.pedidoId, tipo: 'mesa', sucursalId: creado.sucursalId, event: 'upsert', reason: 'created', shouldPrint: true })
  return c.json({ success: true, data }, 201)
})

mozosRoute.post('/pedidos/:id{[0-9]+}/items', zValidator('json', editarItemSchema), async (c) => {
  const db = drizzle(pool); const principal = staff(c); const pedidoId = Number(c.req.param('id')); const body = c.req.valid('json')
  const enAlcance = await pedidoEnAlcance(db, principal, pedidoId)
  if (!enAlcance) return c.json({ success: false, message: 'Pedido no encontrado' }, 404)
  const resultado = await ejecutarMutacionPos(db, principal.restauranteId, pedidoId, body.version, async (tx) => {
    const item = await resolverItemPos(tx, principal.restauranteId, body); if ('error' in item) return item
    const inserted = await tx.insert(ItemPedidoUnificadoTable).values({ pedidoId, ...item })
    return { operacion: 'agregar_item' as const, itemPedidoId: Number(inserted[0].insertId), despues: item, reimprimeCocina: true }
  }, { id: principal.usuarioId, tipo: 'staff_mozo' })
  if (resultado.error) return respuestaErrorMutacion(c, db, principal, pedidoId, resultado)
  const data = await respuestaPedidoEditable(db, principal.restauranteId, pedidoId)
  await emitirEventoPedido(db, { restauranteId: principal.restauranteId, pedidoId, tipo: 'mesa', sucursalId: enAlcance.sucursalId, event: 'upsert', reason: 'updated', shouldPrint: resultado.shouldPrint })
  return c.json({ success: true, data })
})

mozosRoute.put('/pedidos/:id{[0-9]+}/items/:itemId{[0-9]+}', zValidator('json', editarItemSchema), async (c) => {
  const db = drizzle(pool); const principal = staff(c); const pedidoId = Number(c.req.param('id')); const itemId = Number(c.req.param('itemId')); const body = c.req.valid('json')
  const enAlcance = await pedidoEnAlcance(db, principal, pedidoId)
  if (!enAlcance) return c.json({ success: false, message: 'Pedido no encontrado' }, 404)
  const resultado = await ejecutarMutacionPos(db, principal.restauranteId, pedidoId, body.version, async (tx, _pedido, items) => {
    const antes = items.find((item: any) => item.id === itemId); if (!antes) return { error: 'ITEM_NO_ENCONTRADO', message: 'El ítem no pertenece al pedido' }
    const item = await resolverItemPos(tx, principal.restauranteId, body); if ('error' in item) return item
    await tx.update(ItemPedidoUnificadoTable).set(item).where(and(eq(ItemPedidoUnificadoTable.id, itemId), eq(ItemPedidoUnificadoTable.pedidoId, pedidoId)))
    return { operacion: 'editar_item' as const, itemPedidoId: itemId, antes, despues: item, reimprimeCocina: true }
  }, { id: principal.usuarioId, tipo: 'staff_mozo' })
  if (resultado.error) return respuestaErrorMutacion(c, db, principal, pedidoId, resultado)
  const data = await respuestaPedidoEditable(db, principal.restauranteId, pedidoId)
  await emitirEventoPedido(db, { restauranteId: principal.restauranteId, pedidoId, tipo: 'mesa', sucursalId: enAlcance.sucursalId, event: 'upsert', reason: 'updated', shouldPrint: resultado.shouldPrint })
  return c.json({ success: true, data })
})

mozosRoute.delete('/pedidos/:id{[0-9]+}/items/:itemId{[0-9]+}', zValidator('json', eliminarItemSchema), async (c) => {
  const db = drizzle(pool); const principal = staff(c); const pedidoId = Number(c.req.param('id')); const itemId = Number(c.req.param('itemId')); const { version } = c.req.valid('json')
  const enAlcance = await pedidoEnAlcance(db, principal, pedidoId)
  if (!enAlcance) return c.json({ success: false, message: 'Pedido no encontrado' }, 404)
  const resultado = await ejecutarMutacionPos(db, principal.restauranteId, pedidoId, version, async (tx, _pedido, items) => {
    const antes = items.find((item: any) => item.id === itemId); if (!antes) return { error: 'ITEM_NO_ENCONTRADO', message: 'El ítem no pertenece al pedido' }
    if (items.length <= 1) return { error: 'PEDIDO_SIN_ITEMS', message: 'El pedido debe conservar al menos un ítem' }
    await tx.delete(ItemPedidoUnificadoTable).where(and(eq(ItemPedidoUnificadoTable.id, itemId), eq(ItemPedidoUnificadoTable.pedidoId, pedidoId)))
    return { operacion: 'eliminar_item' as const, itemPedidoId: itemId, antes, reimprimeCocina: true }
  }, { id: principal.usuarioId, tipo: 'staff_mozo' })
  if (resultado.error) return respuestaErrorMutacion(c, db, principal, pedidoId, resultado)
  const data = await respuestaPedidoEditable(db, principal.restauranteId, pedidoId)
  await emitirEventoPedido(db, { restauranteId: principal.restauranteId, pedidoId, tipo: 'mesa', sucursalId: enAlcance.sucursalId, event: 'upsert', reason: 'updated', shouldPrint: resultado.shouldPrint })
  return c.json({ success: true, data })
})

mozosRoute.put('/pedidos/:id{[0-9]+}', zValidator('json', editarPedidoSchema), async (c) => {
  const db = drizzle(pool); const principal = staff(c); const pedidoId = Number(c.req.param('id')); const body = c.req.valid('json')
  const enAlcance = await pedidoEnAlcance(db, principal, pedidoId)
  if (!enAlcance) return c.json({ success: false, message: 'Pedido no encontrado' }, 404)
  const resultado = await ejecutarMutacionPos(db, principal.restauranteId, pedidoId, body.version, async (tx, pedido) => {
    const antes = { nombreCliente: pedido.nombreCliente, notas: pedido.notas }
    const despues: any = {}; if (body.nombreCliente !== undefined) despues.nombreCliente = body.nombreCliente || null; if (body.notas !== undefined) despues.notas = body.notas || null
    await tx.update(PedidoUnificadoTable).set(despues).where(eq(PedidoUnificadoTable.id, pedidoId))
    return { operacion: 'editar_datos_pos' as const, antes, despues, reimprimeCocina: body.notas !== undefined && body.notas !== pedido.notas }
  }, { id: principal.usuarioId, tipo: 'staff_mozo' })
  if (resultado.error) return respuestaErrorMutacion(c, db, principal, pedidoId, resultado)
  const data = await respuestaPedidoEditable(db, principal.restauranteId, pedidoId)
  await emitirEventoPedido(db, { restauranteId: principal.restauranteId, pedidoId, tipo: 'mesa', sucursalId: enAlcance.sucursalId, event: 'upsert', reason: 'updated', shouldPrint: resultado.shouldPrint })
  return c.json({ success: true, data })
})

export { mozosRoute }
