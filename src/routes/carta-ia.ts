import { Hono } from 'hono'
import { pool } from '../db'
import {
  categoria as CategoriaTable,
  ingrediente as IngredienteTable,
  agregado as AgregadoTable,
  producto as ProductoTable,
  varianteProducto as VarianteProductoTable,
  productoIngrediente as ProductoIngredienteTable,
  productoAgregado as ProductoAgregadoTable,
  etiqueta as EtiquetaTable,
} from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { extraerCartaDeImagenes } from '../services/carta-ia'
import { generarEtiquetaAutomatica } from './producto'

export const cartaIaRoute = new Hono()
cartaIaRoute.use('*', authMiddleware)

// ─── POST /extraer — leer la carta desde imágenes con IA ────────────────────
const extraerSchema = z.object({
  // Data URLs base64 de las imágenes del menú (una o varias).
  imagenes: z.array(z.string().min(20)).min(1).max(12),
})

cartaIaRoute.post('/extraer', zValidator('json', extraerSchema), async (c) => {
  const { imagenes } = c.req.valid('json')
  try {
    const carta = await extraerCartaDeImagenes(imagenes)
    const totalProductos = carta.categorias.reduce((acc, cat) => acc + cat.productos.length, 0)
    if (totalProductos === 0) {
      return c.json(
        { success: false, message: 'No pudimos detectar productos en las imágenes. Probá con fotos más nítidas.' },
        200,
      )
    }
    return c.json({ success: true, carta, totalProductos }, 200)
  } catch (error) {
    console.error('Error extrayendo carta:', error)
    return c.json({ success: false, message: (error as Error).message || 'Error procesando la carta' }, 500)
  }
})

// ─── POST /crear — crear todos los productos de la carta detectada ──────────
const varianteSchema = z.object({ nombre: z.string().min(1), precio: z.number().min(0) })
const productoSchema = z.object({
  nombre: z.string().min(1).max(255),
  descripcion: z.string().nullable().optional(),
  precio: z.number().nullable().optional(),
  ingredientes: z.array(z.string().min(1)).optional(),
  variantes: z.array(varianteSchema).optional(),
  extras: z.array(varianteSchema).optional(),
})
const crearSchema = z.object({
  carta: z.object({
    categorias: z.array(
      z.object({
        nombre: z.string().min(1).max(255),
        productos: z.array(productoSchema),
      }),
    ),
  }),
})

const norm = (s: string) => s.trim().toLowerCase()

cartaIaRoute.post('/crear', zValidator('json', crearSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const { carta } = c.req.valid('json')

  try {
    // ── 1. Categorías: reutilizar existentes, crear las que falten ──
    const categoriasExistentes = await db
      .select({ id: CategoriaTable.id, nombre: CategoriaTable.nombre })
      .from(CategoriaTable)
      .where(eq(CategoriaTable.restauranteId, restauranteId))
    const categoriaIdPorNombre = new Map<string, number>()
    for (const cat of categoriasExistentes) categoriaIdPorNombre.set(norm(cat.nombre), cat.id)

    for (const cat of carta.categorias) {
      if (!categoriaIdPorNombre.has(norm(cat.nombre))) {
        const res = await db.insert(CategoriaTable).values({ restauranteId, nombre: cat.nombre.trim() })
        categoriaIdPorNombre.set(norm(cat.nombre), Number(res[0].insertId))
      }
    }

    // ── 2. Ingredientes: reutilizar existentes, crear los que falten ──
    const ingredientesExistentes = await db
      .select({ id: IngredienteTable.id, nombre: IngredienteTable.nombre })
      .from(IngredienteTable)
      .where(eq(IngredienteTable.restauranteId, restauranteId))
    const ingredienteIdPorNombre = new Map<string, number>()
    for (const ing of ingredientesExistentes) ingredienteIdPorNombre.set(norm(ing.nombre), ing.id)

    const nombresIngredientes = new Set<string>()
    for (const cat of carta.categorias)
      for (const p of cat.productos) for (const ing of p.ingredientes ?? []) nombresIngredientes.add(ing.trim())

    for (const nombre of nombresIngredientes) {
      if (!nombre) continue
      if (!ingredienteIdPorNombre.has(norm(nombre))) {
        const res = await db.insert(IngredienteTable).values({ restauranteId, nombre })
        ingredienteIdPorNombre.set(norm(nombre), Number(res[0].insertId))
      }
    }

    // ── 3. Extras (agregados): reutilizar existentes por nombre, crear los que falten ──
    const agregadosExistentes = await db
      .select({ id: AgregadoTable.id, nombre: AgregadoTable.nombre })
      .from(AgregadoTable)
      .where(eq(AgregadoTable.restauranteId, restauranteId))
    const agregadoIdPorNombre = new Map<string, number>()
    for (const ag of agregadosExistentes) agregadoIdPorNombre.set(norm(ag.nombre), ag.id)

    // Primer precio visto por nombre de extra (para crear el agregado con un precio razonable)
    const precioExtraPorNombre = new Map<string, number>()
    for (const cat of carta.categorias)
      for (const p of cat.productos)
        for (const ex of p.extras ?? [])
          if (ex.nombre.trim() && !precioExtraPorNombre.has(norm(ex.nombre)))
            precioExtraPorNombre.set(norm(ex.nombre), ex.precio || 0)

    for (const cat of carta.categorias) {
      for (const p of cat.productos) {
        for (const ex of p.extras ?? []) {
          const key = norm(ex.nombre)
          if (!ex.nombre.trim() || agregadoIdPorNombre.has(key)) continue
          const res = await db.insert(AgregadoTable).values({
            restauranteId,
            nombre: ex.nombre.trim(),
            precio: String(precioExtraPorNombre.get(key) ?? ex.precio ?? 0),
          })
          agregadoIdPorNombre.set(key, Number(res[0].insertId))
        }
      }
    }

    // ── 4. Etiquetas: set de las ya usadas para garantizar unicidad ──
    const etiquetasActuales = await db
      .select({ nombre: EtiquetaTable.nombre })
      .from(EtiquetaTable)
      .where(eq(EtiquetaTable.restauranteId, restauranteId))
    const etiquetasSet = new Set<string>(etiquetasActuales.map((e) => e.nombre))

    // ── 5. Productos + variantes + relaciones ──
    let creados = 0
    for (const cat of carta.categorias) {
      const categoriaId = categoriaIdPorNombre.get(norm(cat.nombre)) ?? null
      for (const p of cat.productos) {
        const variantes = (p.variantes ?? []).filter((v) => v.nombre.trim())
        const tieneVariantes = variantes.length > 0

        // Precio base: el declarado, o el mínimo de las variantes, o 0.
        let precioBase = p.precio != null ? Number(p.precio) : null
        if ((precioBase == null || Number.isNaN(precioBase)) && tieneVariantes) {
          precioBase = Math.min(...variantes.map((v) => Number(v.precio) || 0))
        }
        if (precioBase == null || Number.isNaN(precioBase)) precioBase = 0

        const descripcion =
          p.descripcion && p.descripcion.trim() ? p.descripcion.trim().slice(0, 255) : null

        const insert = await db.insert(ProductoTable).values({
          restauranteId,
          categoriaId,
          nombre: p.nombre.trim().slice(0, 255),
          descripcion,
          precio: precioBase.toString(),
          tieneVariantes,
        })
        const productoId = Number(insert[0].insertId)
        creados++

        // Variantes
        if (tieneVariantes) {
          await db.insert(VarianteProductoTable).values(
            variantes.map((v) => ({
              productoId,
              nombre: v.nombre.trim(),
              precio: (Number(v.precio) || 0).toString(),
            })),
          )
        }

        // Ingredientes
        const ingredienteIds = [
          ...new Set(
            (p.ingredientes ?? [])
              .map((ing) => ingredienteIdPorNombre.get(norm(ing)))
              .filter((id): id is number => typeof id === 'number'),
          ),
        ]
        if (ingredienteIds.length > 0) {
          await db.insert(ProductoIngredienteTable).values(
            ingredienteIds.map((ingredienteId) => ({ productoId, ingredienteId })),
          )
        }

        // Extras (agregados)
        const agregadoIds = [
          ...new Set(
            (p.extras ?? [])
              .map((ex) => agregadoIdPorNombre.get(norm(ex.nombre)))
              .filter((id): id is number => typeof id === 'number'),
          ),
        ]
        if (agregadoIds.length > 0) {
          await db.insert(ProductoAgregadoTable).values(
            agregadoIds.map((agregadoId) => ({ productoId, agregadoId })),
          )
        }

        // Etiqueta automática (misma lógica que /producto/create)
        const etiquetaAuto = generarEtiquetaAutomatica(p.nombre, cat.nombre, etiquetasSet)
        etiquetasSet.add(etiquetaAuto)
        await db.insert(EtiquetaTable).values({ restauranteId, productoId, nombre: etiquetaAuto })
      }
    }

    return c.json({ success: true, message: 'Carta creada correctamente', productosCreados: creados }, 200)
  } catch (error) {
    console.error('Error creando carta:', error)
    return c.json({ success: false, message: (error as Error).message || 'Error creando la carta' }, 500)
  }
})
