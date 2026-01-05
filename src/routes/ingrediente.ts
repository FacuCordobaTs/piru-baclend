import { Hono } from 'hono'
import { pool } from '../db'
import { ingrediente as IngredienteTable, productoIngrediente as ProductoIngredienteTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, inArray } from 'drizzle-orm'

const createIngredienteSchema = z.object({
  nombre: z.string().min(1).max(255),
})

const ingredienteRoute = new Hono()

.use('*', authMiddleware)

// Obtener todos los ingredientes del restaurante
.get('/', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  
  const ingredientes = await db
    .select()
    .from(IngredienteTable)
    .where(eq(IngredienteTable.restauranteId, restauranteId))
    .orderBy(IngredienteTable.nombre)
  
  return c.json({ 
    message: 'Ingredientes obtenidos correctamente', 
    success: true, 
    ingredientes
  }, 200)
})

// Crear nuevo ingrediente
.post('/create', zValidator('json', createIngredienteSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { nombre } = c.req.valid('json')

  const result = await db.insert(IngredienteTable).values({
    nombre: nombre.trim(),
    restauranteId,
  })
  
  return c.json({ 
    message: 'Ingrediente creado correctamente', 
    success: true, 
    data: { id: Number(result[0].insertId), nombre, restauranteId }
  }, 201)
})

// Eliminar ingrediente
.delete('/:id', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const id = Number(c.req.param('id'))

  // Verificar que el ingrediente pertenece al restaurante
  const ingrediente = await db
    .select()
    .from(IngredienteTable)
    .where(and(
      eq(IngredienteTable.id, id),
      eq(IngredienteTable.restauranteId, restauranteId)
    ))
    .limit(1)

  if (!ingrediente || ingrediente.length === 0) {
    return c.json({ message: 'Ingrediente no encontrado', success: false }, 404)
  }

  // Eliminar relaciones con productos primero
  await db
    .delete(ProductoIngredienteTable)
    .where(eq(ProductoIngredienteTable.ingredienteId, id))

  // Eliminar ingrediente
  await db
    .delete(IngredienteTable)
    .where(and(
      eq(IngredienteTable.id, id),
      eq(IngredienteTable.restauranteId, restauranteId)
    ))

  return c.json({ 
    message: 'Ingrediente eliminado correctamente', 
    success: true 
  }, 200)
})

// Obtener ingredientes de un producto
.get('/producto/:productoId', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const productoId = Number(c.req.param('productoId'))

  // Verificar que el producto pertenece al restaurante
  const { producto: ProductoTable } = await import('../db/schema')
  const producto = await db
    .select()
    .from(ProductoTable)
    .where(and(
      eq(ProductoTable.id, productoId),
      eq(ProductoTable.restauranteId, restauranteId)
    ))
    .limit(1)

  if (!producto || producto.length === 0) {
    return c.json({ message: 'Producto no encontrado', success: false }, 404)
  }

  // Obtener ingredientes del producto
  const ingredientes = await db
    .select({
      id: IngredienteTable.id,
      nombre: IngredienteTable.nombre,
    })
    .from(ProductoIngredienteTable)
    .innerJoin(IngredienteTable, eq(ProductoIngredienteTable.ingredienteId, IngredienteTable.id))
    .where(eq(ProductoIngredienteTable.productoId, productoId))

  return c.json({ 
    message: 'Ingredientes obtenidos correctamente', 
    success: true, 
    ingredientes
  }, 200)
})

// Asociar ingredientes a un producto
.post('/producto/:productoId', zValidator('json', z.object({
  ingredienteIds: z.array(z.number().int().positive())
})), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const productoId = Number(c.req.param('productoId'))
  const { ingredienteIds } = c.req.valid('json')

  // Verificar que el producto pertenece al restaurante
  const { producto: ProductoTable } = await import('../db/schema')
  const producto = await db
    .select()
    .from(ProductoTable)
    .where(and(
      eq(ProductoTable.id, productoId),
      eq(ProductoTable.restauranteId, restauranteId)
    ))
    .limit(1)

  if (!producto || producto.length === 0) {
    return c.json({ message: 'Producto no encontrado', success: false }, 404)
  }

  // Verificar que todos los ingredientes pertenecen al restaurante
  if (ingredienteIds.length > 0) {
    const ingredientes = await db
      .select()
      .from(IngredienteTable)
      .where(and(
        inArray(IngredienteTable.id, ingredienteIds),
        eq(IngredienteTable.restauranteId, restauranteId)
      ))

    if (ingredientes.length !== ingredienteIds.length) {
      return c.json({ 
        message: 'Algunos ingredientes no pertenecen al restaurante', 
        success: false 
      }, 400)
    }
  }

  // Eliminar relaciones existentes
  await db
    .delete(ProductoIngredienteTable)
    .where(eq(ProductoIngredienteTable.productoId, productoId))

  // Crear nuevas relaciones
  if (ingredienteIds.length > 0) {
    await db.insert(ProductoIngredienteTable).values(
      ingredienteIds.map(ingredienteId => ({
        productoId,
        ingredienteId,
      }))
    )
  }

  return c.json({ 
    message: 'Ingredientes asociados correctamente', 
    success: true 
  }, 200)
})

export { ingredienteRoute }

