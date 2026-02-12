import { Hono } from 'hono'
import { pool } from '../db'
import { producto as ProductoTable, categoria as CategoriaTable, productoIngrediente as ProductoIngredienteTable, ingrediente as IngredienteTable, itemPedido as ItemPedidoTable, etiqueta as EtiquetaTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq, and, inArray, like, notInArray, isNull, sql } from 'drizzle-orm'
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import UUID = require("uuid-js");

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/jpg"];

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, '');

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
  console.error("FATAL ERROR: Faltan variables de entorno de Cloudflare R2. La aplicación no puede manejar imágenes.");
  process.exit(1);
}

const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

async function saveImage(base64String: string): Promise<string> {
  const match = base64String.match(/^data:(image\/\w+);base64,/);
  if (!match) {
    throw new Error('Formato de base64 inválido para saveImage');
  }
  const mimeType = match[1];
  const fileExtension = mimeType.split('/')[1] || 'png'; // Extrae extensión

  const base64Data = base64String.replace(/^data:image\/\w+;base64,/, "");
  const buffer = Buffer.from(base64Data, "base64");

  const uuid = UUID.create().toString();
  const fileName = `${uuid}.${fileExtension}`; // Nombre del objeto en R2

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: fileName,
    Body: buffer,
    ContentType: mimeType,
  });

  try {
    await s3Client.send(command);
    const publicUrl = `${R2_PUBLIC_URL}/${fileName}`; // Construye la URL pública completa
    console.log(`Imagen guardada en R2: ${publicUrl}`);
    return publicUrl;
  } catch (error) {
    console.error(`Error al subir ${fileName} a R2:`, error);
    throw new Error("Error al guardar la imagen en el almacenamiento en la nube.");
  }
}

async function deleteImage(imageUrl: string): Promise<void> {
  if (!imageUrl || !imageUrl.startsWith(R2_PUBLIC_URL!)) {
    console.warn("deleteImage: URL inválida o no pertenece a R2 gestionado:", imageUrl);
    return;
  }
  try {
    const urlObject = new URL(imageUrl);
    const key = urlObject.pathname.substring(1); // Extrae la 'Key' (path sin / inicial)

    if (!key) {
      console.warn("deleteImage: No se pudo extraer la clave de la URL R2:", imageUrl);
      return;
    }

    const command = new DeleteObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    });

    console.log(`Eliminando objeto ${key} de R2 bucket ${R2_BUCKET_NAME}...`);
    await s3Client.send(command);
    console.log(`Objeto ${key} eliminado de R2.`);

  } catch (error: any) {
    console.error(`Error al eliminar objeto de R2 (${imageUrl}):`, error);
  }
}

/**
 * Genera una etiqueta automática única basada en las iniciales del producto.
 * 
 * Lógica:
 * - Producto multi-palabra ("Pizza Muzzarela") → iniciales: "PM"
 * - Producto una sola palabra + tiene categoría ("Muzzarela" cat "Pizza") → inicial categoría + inicial producto: "PM"
 * - Producto una sola palabra sin categoría ("Muzzarela") → primeras 2 letras: "MU"
 * 
 * Si hay colisión, expande con más letras de la última palabra: PM → PMU → PMUZ
 * Si sigue habiendo colisión, agrega números: PM2, PM3, PM4...
 */
function generarEtiquetaAutomatica(
  productoNombre: string,
  categoriaNombre: string | null,
  etiquetasExistentes: Set<string>
): string {
  const palabras = productoNombre.trim().split(/\s+/).filter(p => p.length > 0)

  if (palabras.length === 0) return 'prod'

  let base: string
  let ultimaPalabra: string
  let letrasUsadas: number // cuántas letras de ultimaPalabra ya están en base

  if (palabras.length >= 2) {
    // Multi-palabra: inicial de cada palabra
    base = palabras.map(p => p[0]).join('').toUpperCase()
    ultimaPalabra = palabras[palabras.length - 1].toUpperCase()
    letrasUsadas = 1
  } else if (categoriaNombre && categoriaNombre.trim().length > 0) {
    // Una palabra + categoría: inicial categoría + inicial producto
    base = (categoriaNombre.trim()[0] + palabras[0][0]).toUpperCase()
    ultimaPalabra = palabras[0].toUpperCase()
    letrasUsadas = 1
  } else {
    // Una palabra sin categoría: primeras 2 letras
    base = palabras[0].substring(0, Math.min(2, palabras[0].length)).toUpperCase()
    ultimaPalabra = palabras[0].toUpperCase()
    letrasUsadas = Math.min(2, palabras[0].length)
  }

  // Intentar con la base directa
  if (!etiquetasExistentes.has(base.toLowerCase())) {
    return base.toLowerCase()
  }

  // Expandir con más letras de la última palabra (hasta 4 extras)
  let candidato = base
  for (let i = letrasUsadas; i < ultimaPalabra.length && i < letrasUsadas + 4; i++) {
    candidato = candidato + ultimaPalabra[i]
    if (!etiquetasExistentes.has(candidato.toLowerCase())) {
      return candidato.toLowerCase()
    }
  }

  // Fallback: agregar números incrementales a la base
  let counter = 2
  while (counter <= 999) {
    const numCandidato = `${base}${counter}`.toLowerCase()
    if (!etiquetasExistentes.has(numCandidato)) {
      return numCandidato
    }
    counter++
  }

  // Ultra fallback (prácticamente imposible de alcanzar)
  return `${base}${Date.now()}`.toLowerCase()
}

const createProductSchema = z.object({
  nombre: z.string().min(3).max(255),
  descripcion: z.string().min(3).max(255),
  precio: z.number().min(0),
  image: z.string().min(10).optional(),
  categoriaId: z.number().optional(),
  ingredienteIds: z.array(z.number().int().positive()).optional(),
  etiquetas: z.array(z.string().min(1).max(100)).optional(),
});

const updateProductSchema = z.object({
  id: z.number(),
  nombre: z.string().min(3).max(255).optional(),
  descripcion: z.string().min(3).max(255).optional(),
  precio: z.number().min(0).optional(),
  image: z.string().min(10).optional(),
  categoriaId: z.number().optional(),
  ingredienteIds: z.array(z.number().int().positive()).optional(),
  activo: z.boolean().optional(),
  etiquetas: z.array(z.string().min(1).max(100)).optional(),
});

const productoRoute = new Hono()

  .use('*', authMiddleware)

  // Obtener todos los productos del restaurante
  .get('/', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id

    const productos = await db
      .select({
        id: ProductoTable.id,
        restauranteId: ProductoTable.restauranteId,
        categoriaId: ProductoTable.categoriaId,
        nombre: ProductoTable.nombre,
        descripcion: ProductoTable.descripcion,
        precio: ProductoTable.precio,
        activo: ProductoTable.activo,
        imagenUrl: ProductoTable.imagenUrl,
        createdAt: ProductoTable.createdAt,
        categoria: {
          id: CategoriaTable.id,
          nombre: CategoriaTable.nombre,
        }
      })
      .from(ProductoTable)
      .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
      .where(eq(ProductoTable.restauranteId, restauranteId))

    // Obtener ingredientes y etiquetas para cada producto
    const productosConDetalles = await Promise.all(
      productos.map(async (p) => {
        const [ingredientes, etiquetas] = await Promise.all([
          db
            .select({
              id: IngredienteTable.id,
              nombre: IngredienteTable.nombre,
            })
            .from(ProductoIngredienteTable)
            .innerJoin(IngredienteTable, eq(ProductoIngredienteTable.ingredienteId, IngredienteTable.id))
            .where(eq(ProductoIngredienteTable.productoId, p.id)),
          db
            .select({
              id: EtiquetaTable.id,
              nombre: EtiquetaTable.nombre,
            })
            .from(EtiquetaTable)
            .where(eq(EtiquetaTable.productoId, p.id)),
        ])

        return {
          ...p,
          categoria: p.categoria?.nombre || null,
          ingredientes: ingredientes,
          etiquetas: etiquetas,
        }
      })
    )

    return c.json({
      message: 'Productos obtenidos correctamente',
      success: true,
      productos: productosConDetalles
    }, 200)
  })

  .post('/create', zValidator('json', createProductSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const { nombre, descripcion, precio, image, categoriaId, ingredienteIds, etiquetas } = c.req.valid('json')

    // Validar que la categoría pertenece al restaurante si se proporciona
    if (categoriaId) {
      const categoria = await db
        .select()
        .from(CategoriaTable)
        .where(and(
          eq(CategoriaTable.id, categoriaId),
          eq(CategoriaTable.restauranteId, restauranteId)
        ))
        .limit(1)

      if (categoria.length === 0) {
        return c.json({
          message: 'Categoría no encontrada o no pertenece al restaurante',
          success: false
        }, 400)
      }
    }

    let newImageUrl: string | undefined;

    if (image) {
      const [meta, data] = image.split(",");
      const mimeType = meta.match(/:(.*?);/)?.[1];

      if (!mimeType || !ALLOWED_MIME_TYPES.includes(mimeType)) {
        newImageUrl = undefined;
      }

      const buffer = Buffer.from(data, "base64");
      if (buffer.byteLength > MAX_FILE_SIZE) {
        newImageUrl = undefined;
      }

      newImageUrl = await saveImage(image);
    }

    const product = await db.insert(ProductoTable).values({
      nombre,
      descripcion,
      precio: precio.toString(),
      imagenUrl: newImageUrl,
      restauranteId,
      categoriaId: categoriaId || null,
    })

    const productoId = Number(product[0].insertId)

    // Asociar ingredientes si se proporcionaron
    if (ingredienteIds && ingredienteIds.length > 0) {
      // Verificar que todos los ingredientes pertenecen al restaurante
      const ingredientes = await db
        .select()
        .from(IngredienteTable)
        .where(and(
          eq(IngredienteTable.restauranteId, restauranteId)
        ))

      const ingredientesValidos = ingredientes
        .filter(ing => ingredienteIds.includes(ing.id))
        .map(ing => ing.id)

      if (ingredientesValidos.length > 0) {
        await db.insert(ProductoIngredienteTable).values(
          ingredientesValidos.map(ingredienteId => ({
            productoId,
            ingredienteId,
          }))
        )
      }
    }

    // Obtener todas las etiquetas existentes del restaurante para validar unicidad
    const todasEtiquetas = await db
      .select({ nombre: EtiquetaTable.nombre })
      .from(EtiquetaTable)
      .where(eq(EtiquetaTable.restauranteId, restauranteId))
    const etiquetasExistentesSet = new Set(todasEtiquetas.map(e => e.nombre))

    // Generar etiqueta automática por iniciales
    let categoriaNombre: string | null = null
    if (categoriaId) {
      const cat = await db
        .select({ nombre: CategoriaTable.nombre })
        .from(CategoriaTable)
        .where(eq(CategoriaTable.id, categoriaId))
        .limit(1)
      categoriaNombre = cat.length > 0 ? cat[0].nombre : null
    }

    const etiquetaAuto = generarEtiquetaAutomatica(nombre, categoriaNombre, etiquetasExistentesSet)
    etiquetasExistentesSet.add(etiquetaAuto)

    const etiquetasAInsertar: { restauranteId: number, productoId: number, nombre: string }[] = [
      { restauranteId, productoId, nombre: etiquetaAuto }
    ]

    // Asociar etiquetas manuales adicionales si se proporcionaron
    if (etiquetas && etiquetas.length > 0) {
      const etiquetasNormalizadas = [...new Set(etiquetas.map(e => e.trim().toLowerCase()))]

      // Filtrar las que ya existen (incluyendo la auto-generada)
      const duplicadas = etiquetasNormalizadas.filter(e => etiquetasExistentesSet.has(e))
      const nuevas = etiquetasNormalizadas.filter(e => !etiquetasExistentesSet.has(e))

      if (duplicadas.length > 0) {
        return c.json({
          message: `Las siguientes etiquetas ya están en uso: ${duplicadas.join(', ')}`,
          success: false,
          etiquetasDuplicadas: duplicadas,
        }, 400)
      }

      nuevas.forEach(nombre => {
        etiquetasAInsertar.push({ restauranteId, productoId, nombre })
      })
    }

    await db.insert(EtiquetaTable).values(etiquetasAInsertar)

    return c.json({ message: 'Producto creado correctamente', success: true, data: product, etiquetaAutoGenerada: etiquetaAuto }, 200)
  })

  .put('/update', zValidator('json', updateProductSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const { id, nombre, descripcion, precio, image, categoriaId, ingredienteIds, activo, etiquetas } = c.req.valid('json')

    // Validar que la categoría pertenece al restaurante si se proporciona
    if (categoriaId !== undefined) {
      if (categoriaId === null) {
        // Permitir establecer categoriaId a null
      } else {
        const categoria = await db
          .select()
          .from(CategoriaTable)
          .where(and(
            eq(CategoriaTable.id, categoriaId),
            eq(CategoriaTable.restauranteId, restauranteId)
          ))
          .limit(1)

        if (categoria.length === 0) {
          return c.json({
            message: 'Categoría no encontrada o no pertenece al restaurante',
            success: false
          }, 400)
        }
      }
    }

    let newImageUrl: string | undefined;

    if (image) {
      const [meta, data] = image.split(",");
      const mimeType = meta.match(/:(.*?);/)?.[1];

      if (!mimeType || !ALLOWED_MIME_TYPES.includes(mimeType)) {
        newImageUrl = undefined;
      }

      const buffer = Buffer.from(data, "base64");
      if (buffer.byteLength > MAX_FILE_SIZE) {
        newImageUrl = undefined;
      }

      newImageUrl = await saveImage(image);
    }

    const updateData: { [key: string]: any } = {};
    if (nombre) updateData.nombre = nombre;
    if (descripcion) updateData.descripcion = descripcion;
    if (precio) updateData.precio = precio;
    if (newImageUrl) updateData.imagenUrl = newImageUrl;
    if (categoriaId !== undefined) updateData.categoriaId = categoriaId;
    if (activo !== undefined) updateData.activo = activo;
    if (Object.keys(updateData).length === 0) {
      return c.json({ message: 'No se proporcionaron datos para actualizar', success: false }, 400)
    }
    await db.update(ProductoTable)
      .set(updateData)
      .where(and(eq(ProductoTable.id, id), eq(ProductoTable.restauranteId, restauranteId)))

    // Actualizar ingredientes si se proporcionaron
    if (ingredienteIds !== undefined) {
      // Eliminar relaciones existentes
      await db
        .delete(ProductoIngredienteTable)
        .where(eq(ProductoIngredienteTable.productoId, id))

      // Crear nuevas relaciones si hay ingredientes
      if (ingredienteIds.length > 0) {
        // Verificar que todos los ingredientes pertenecen al restaurante
        const ingredientes = await db
          .select()
          .from(IngredienteTable)
          .where(and(
            eq(IngredienteTable.restauranteId, restauranteId)
          ))

        const ingredientesValidos = ingredientes
          .filter(ing => ingredienteIds.includes(ing.id))
          .map(ing => ing.id)

        if (ingredientesValidos.length > 0) {
          await db.insert(ProductoIngredienteTable).values(
            ingredientesValidos.map(ingredienteId => ({
              productoId: id,
              ingredienteId,
            }))
          )
        }
      }
    }

    // Actualizar etiquetas si se proporcionaron
    if (etiquetas !== undefined) {
      // Eliminar etiquetas existentes del producto
      await db
        .delete(EtiquetaTable)
        .where(eq(EtiquetaTable.productoId, id))

      // Crear nuevas etiquetas si hay
      if (etiquetas.length > 0) {
        const etiquetasNormalizadas = [...new Set(etiquetas.map(e => e.trim().toLowerCase()))]

        // Verificar que ninguna etiqueta ya existe para OTRO producto del restaurante
        const etiquetasExistentes = await db
          .select()
          .from(EtiquetaTable)
          .where(and(
            eq(EtiquetaTable.restauranteId, restauranteId),
            inArray(EtiquetaTable.nombre, etiquetasNormalizadas)
          ))

        if (etiquetasExistentes.length > 0) {
          const nombresOcupados = etiquetasExistentes.map(e => e.nombre)
          return c.json({
            message: `Las siguientes etiquetas ya están en uso por otro producto: ${nombresOcupados.join(', ')}`,
            success: false,
            etiquetasDuplicadas: nombresOcupados,
          }, 400)
        }

        await db.insert(EtiquetaTable).values(
          etiquetasNormalizadas.map(nombre => ({
            restauranteId,
            productoId: id,
            nombre,
          }))
        )
      }
    }

    return c.json({ message: 'Producto actualizado correctamente', success: true }, 200)
  })

  // Buscar productos por etiqueta
  .get('/buscar-etiqueta', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const query = c.req.query('q')

    if (!query || query.trim().length === 0) {
      return c.json({ message: 'Se requiere un término de búsqueda', success: false }, 400)
    }

    const termino = query.trim().toLowerCase()

    // Buscar etiquetas que coincidan
    const etiquetasEncontradas = await db
      .select({
        productoId: EtiquetaTable.productoId,
        etiquetaNombre: EtiquetaTable.nombre,
      })
      .from(EtiquetaTable)
      .where(and(
        eq(EtiquetaTable.restauranteId, restauranteId),
        like(EtiquetaTable.nombre, `%${termino}%`)
      ))

    if (etiquetasEncontradas.length === 0) {
      return c.json({ message: 'No se encontraron productos con esa etiqueta', success: true, productos: [] }, 200)
    }

    const productoIds = [...new Set(etiquetasEncontradas.map(e => e.productoId))]

    const productos = await db
      .select({
        id: ProductoTable.id,
        restauranteId: ProductoTable.restauranteId,
        categoriaId: ProductoTable.categoriaId,
        nombre: ProductoTable.nombre,
        descripcion: ProductoTable.descripcion,
        precio: ProductoTable.precio,
        activo: ProductoTable.activo,
        imagenUrl: ProductoTable.imagenUrl,
        createdAt: ProductoTable.createdAt,
        categoria: {
          id: CategoriaTable.id,
          nombre: CategoriaTable.nombre,
        }
      })
      .from(ProductoTable)
      .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
      .where(and(
        eq(ProductoTable.restauranteId, restauranteId),
        inArray(ProductoTable.id, productoIds)
      ))

    const productosConDetalles = await Promise.all(
      productos.map(async (p) => {
        const [ingredientes, etiquetas] = await Promise.all([
          db
            .select({
              id: IngredienteTable.id,
              nombre: IngredienteTable.nombre,
            })
            .from(ProductoIngredienteTable)
            .innerJoin(IngredienteTable, eq(ProductoIngredienteTable.ingredienteId, IngredienteTable.id))
            .where(eq(ProductoIngredienteTable.productoId, p.id)),
          db
            .select({
              id: EtiquetaTable.id,
              nombre: EtiquetaTable.nombre,
            })
            .from(EtiquetaTable)
            .where(eq(EtiquetaTable.productoId, p.id)),
        ])

        return {
          ...p,
          categoria: p.categoria?.nombre || null,
          ingredientes,
          etiquetas,
        }
      })
    )

    return c.json({
      message: 'Productos encontrados',
      success: true,
      productos: productosConDetalles,
    }, 200)
  })

  // Obtener todas las etiquetas del restaurante
  .get('/etiquetas', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id

    const etiquetas = await db
      .select({
        id: EtiquetaTable.id,
        nombre: EtiquetaTable.nombre,
        productoId: EtiquetaTable.productoId,
        productoNombre: ProductoTable.nombre,
      })
      .from(EtiquetaTable)
      .innerJoin(ProductoTable, eq(EtiquetaTable.productoId, ProductoTable.id))
      .where(eq(EtiquetaTable.restauranteId, restauranteId))
      .orderBy(EtiquetaTable.nombre)

    return c.json({
      message: 'Etiquetas obtenidas correctamente',
      success: true,
      etiquetas,
    }, 200)
  })

  // Asignar etiquetas automáticas a todos los productos que no tengan ninguna
  .post('/backfill-etiquetas', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id

    // Obtener IDs de productos que YA tienen al menos una etiqueta
    const productosConEtiqueta = await db
      .select({ productoId: EtiquetaTable.productoId })
      .from(EtiquetaTable)
      .where(eq(EtiquetaTable.restauranteId, restauranteId))
    const idsConEtiqueta = new Set(productosConEtiqueta.map(e => e.productoId))

    // Obtener todos los productos del restaurante con su categoría
    const todosProductos = await db
      .select({
        id: ProductoTable.id,
        nombre: ProductoTable.nombre,
        categoriaId: ProductoTable.categoriaId,
        categoriaNombre: CategoriaTable.nombre,
      })
      .from(ProductoTable)
      .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
      .where(eq(ProductoTable.restauranteId, restauranteId))

    // Filtrar los que NO tienen etiqueta
    const productosSinEtiqueta = todosProductos.filter(p => !idsConEtiqueta.has(p.id))

    if (productosSinEtiqueta.length === 0) {
      return c.json({
        message: 'Todos los productos ya tienen etiquetas asignadas',
        success: true,
        asignadas: 0,
      }, 200)
    }

    // Obtener todas las etiquetas existentes para validar unicidad
    const todasEtiquetas = await db
      .select({ nombre: EtiquetaTable.nombre })
      .from(EtiquetaTable)
      .where(eq(EtiquetaTable.restauranteId, restauranteId))
    const etiquetasExistentesSet = new Set(todasEtiquetas.map(e => e.nombre))

    // Generar e insertar etiqueta para cada producto sin etiqueta
    const etiquetasGeneradas: { productoId: number, productoNombre: string, etiqueta: string }[] = []
    const valoresAInsertar: { restauranteId: number, productoId: number, nombre: string }[] = []

    for (const producto of productosSinEtiqueta) {
      const etiquetaAuto = generarEtiquetaAutomatica(
        producto.nombre,
        producto.categoriaNombre ?? null,
        etiquetasExistentesSet
      )

      // Agregar al set para que la siguiente iteración la vea como ocupada
      etiquetasExistentesSet.add(etiquetaAuto)

      valoresAInsertar.push({
        restauranteId,
        productoId: producto.id,
        nombre: etiquetaAuto,
      })

      etiquetasGeneradas.push({
        productoId: producto.id,
        productoNombre: producto.nombre,
        etiqueta: etiquetaAuto,
      })
    }

    // Insertar todas las etiquetas en batch
    if (valoresAInsertar.length > 0) {
      await db.insert(EtiquetaTable).values(valoresAInsertar)
    }

    return c.json({
      message: `Se asignaron etiquetas a ${etiquetasGeneradas.length} producto(s)`,
      success: true,
      asignadas: etiquetasGeneradas.length,
      etiquetas: etiquetasGeneradas,
    }, 200)
  })

  .delete('/delete/:id', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const id = Number(c.req.param('id'))

    const product = await db.select().from(ProductoTable).where(and(eq(ProductoTable.id, id), eq(ProductoTable.restauranteId, restauranteId)))
    if (!product || product.length === 0) {
      return c.json({ message: 'Producto no encontrado', success: false }, 404)
    }

    // Verificar si hay items de pedido asociados
    const itemsAsociados = await db.select().from(ItemPedidoTable).where(eq(ItemPedidoTable.productoId, id)).limit(1)

    if (itemsAsociados && itemsAsociados.length > 0) {
      return c.json({
        message: 'No se puede eliminar el producto porque tiene pedidos asociados. Desactívalo en su lugar.',
        success: false
      }, 400)
    }

    if (product[0].imagenUrl) {
      await deleteImage(product[0].imagenUrl);
    }

    // Eliminar etiquetas del producto
    await db.delete(EtiquetaTable).where(eq(EtiquetaTable.productoId, id))

    // Eliminar relaciones de ingredientes del producto
    await db.delete(ProductoIngredienteTable).where(eq(ProductoIngredienteTable.productoId, id))

    await db.delete(ProductoTable).where(and(eq(ProductoTable.id, id), eq(ProductoTable.restauranteId, restauranteId)))
    return c.json({ message: 'Producto eliminado correctamente', success: true, data: product }, 200)
  })

export { productoRoute }