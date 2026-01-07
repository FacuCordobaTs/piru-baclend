import { Hono } from 'hono'
import { pool } from '../db'
import { categoria as CategoriaTable, producto as ProductoTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and } from 'drizzle-orm'

const createCategoriaSchema = z.object({
  nombre: z.string().min(1).max(255),
});

const updateCategoriaSchema = z.object({
  id: z.number(),
  nombre: z.string().min(1).max(255).optional(),
});

const categoriaRoute = new Hono()

.use('*', authMiddleware)

// Obtener todas las categorías del restaurante
.get('/', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  
  const categorias = await db
    .select()
    .from(CategoriaTable)
    .where(eq(CategoriaTable.restauranteId, restauranteId))
    .orderBy(CategoriaTable.nombre)
  
  return c.json({ 
    message: 'Categorías obtenidas correctamente', 
    success: true, 
    categorias 
  }, 200)
})

.post('/create', zValidator('json', createCategoriaSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { nombre } = c.req.valid('json')

  // Verificar si ya existe una categoría con el mismo nombre para este restaurante
  const categoriaExistente = await db
    .select()
    .from(CategoriaTable)
    .where(
      and(
        eq(CategoriaTable.restauranteId, restauranteId),
        eq(CategoriaTable.nombre, nombre)
      )
    )
    .limit(1)

  if (categoriaExistente.length > 0) {
    return c.json({ 
      message: 'Ya existe una categoría con ese nombre', 
      success: false 
    }, 400)
  }

  const categoria = await db.insert(CategoriaTable).values({
    nombre,
    restauranteId,
  })
  
  return c.json({ 
    message: 'Categoría creada correctamente', 
    success: true, 
    data: categoria 
  }, 200)
})
  
.put('/update', zValidator('json', updateCategoriaSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { id, nombre } = c.req.valid('json')

  if (!nombre) {
    return c.json({ 
      message: 'No se proporcionaron datos para actualizar', 
      success: false 
    }, 400)
  }

  // Verificar si ya existe otra categoría con el mismo nombre para este restaurante
  const categoriaExistente = await db
    .select()
    .from(CategoriaTable)
    .where(
      and(
        eq(CategoriaTable.restauranteId, restauranteId),
        eq(CategoriaTable.nombre, nombre)
      )
    )
    .limit(1)

  if (categoriaExistente.length > 0 && categoriaExistente[0].id !== id) {
    return c.json({ 
      message: 'Ya existe una categoría con ese nombre', 
      success: false 
    }, 400)
  }

  const categoria = await db
    .update(CategoriaTable)
    .set({ nombre })
    .where(and(eq(CategoriaTable.id, id), eq(CategoriaTable.restauranteId, restauranteId)))

  return c.json({ 
    message: 'Categoría actualizada correctamente', 
    success: true, 
    data: categoria 
  }, 200)
})

.delete('/delete/:id', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const id = Number(c.req.param('id'))

  const categoria = await db
    .select()
    .from(CategoriaTable)
    .where(and(eq(CategoriaTable.id, id), eq(CategoriaTable.restauranteId, restauranteId)))
    .limit(1)
    
  if (!categoria || categoria.length === 0) {
    return c.json({ 
      message: 'Categoría no encontrada', 
      success: false 
    }, 404)
  }

  // Contar productos usando esta categoría
  const productosConCategoria = await db
    .select()
    .from(ProductoTable)
    .where(eq(ProductoTable.categoriaId, id))

  const cantidadProductos = productosConCategoria.length

  // Actualizar todos los productos de esta categoría a "sin categoría"
  if (cantidadProductos > 0) {
    await db
      .update(ProductoTable)
      .set({ categoriaId: null })
      .where(eq(ProductoTable.categoriaId, id))
  }

  // Eliminar la categoría
  await db
    .delete(CategoriaTable)
    .where(and(eq(CategoriaTable.id, id), eq(CategoriaTable.restauranteId, restauranteId)))
    
  return c.json({ 
    message: cantidadProductos > 0 
      ? `Categoría eliminada. ${cantidadProductos} producto(s) movido(s) a "Sin categoría"` 
      : 'Categoría eliminada correctamente', 
    success: true, 
    data: categoria,
    productosActualizados: cantidadProductos
  }, 200)
})

export { categoriaRoute }

