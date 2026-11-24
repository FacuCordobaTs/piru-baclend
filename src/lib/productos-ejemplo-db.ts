/**
 * Escritura de los productos de ejemplo de las tiendas self-serve. El catálogo (qué productos) es
 * puro y vive en `productos-ejemplo.ts`.
 *
 * Invariantes:
 *   - sólo se siembran en una carta vacía: nunca se mezclan con productos que cargó el dueño;
 *   - todo lo sembrado lleva `es_ejemplo`, y quitar los ejemplos toca sólo eso: los productos que el
 *     dueño creó, aunque estén en una categoría de ejemplo, quedan (y la categoría con ellos);
 *   - un producto de ejemplo que ya se vendió (un pedido de prueba) no se borra, para no romper el
 *     historial: se desactiva, igual que el borrado de productos del panel.
 */
import { and, count, eq, inArray, isNull } from 'drizzle-orm'
import type { MySql2Database } from 'drizzle-orm/mysql2'
import {
  categoria,
  etiqueta,
  itemPedidoUnificado,
  producto,
  productoAgregado,
  productoIngrediente,
  productoPuntos,
  restaurante,
  varianteProducto,
} from '../db/schema'
import { leerImagenesExtra } from './producto-imagenes'
import { catalogoDe, type Rubro } from './productos-ejemplo'

type Db = MySql2Database<Record<string, never>>

const dos = (n: number) => n.toFixed(2)

export interface ConfiguracionInicial {
  rubro: Rubro
  delivery: boolean
  takeaway: boolean
}

/**
 * Guarda las respuestas de las preguntas iniciales y, si la carta está vacía, siembra los productos
 * de ejemplo del rubro. Idempotente: responder de nuevo no duplica nada.
 */
export async function configurarTiendaInicial(
  db: Db,
  restauranteId: number,
  config: ConfiguracionInicial,
): Promise<{ productosEjemplo: number }> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db
    // Bloquea la fila del local: dos envíos simultáneos no siembran dos veces.
    await tx.select({ id: restaurante.id }).from(restaurante).where(eq(restaurante.id, restauranteId)).limit(1).for('update')

    await tx
      .update(restaurante)
      .set({ rubro: config.rubro, deliveryEnabled: config.delivery, takeawayEnabled: config.takeaway })
      .where(eq(restaurante.id, restauranteId))

    const [{ n: existentes }] = await tx
      .select({ n: count() })
      .from(producto)
      .where(and(eq(producto.restauranteId, restauranteId), isNull(producto.eventoSucursalId)))
    if (Number(existentes) > 0) return { productosEjemplo: 0 }

    let sembrados = 0
    for (const [ordenCategoria, cat] of catalogoDe(config.rubro).entries()) {
      const [insertCat] = await tx.insert(categoria).values({
        restauranteId,
        nombre: cat.nombre,
        esBebida: cat.esBebida ?? false,
        orden: ordenCategoria,
        esEjemplo: true,
      })
      const categoriaId = Number(insertCat.insertId)

      for (const [ordenProducto, p] of cat.productos.entries()) {
        const conVariantes = Boolean(p.variantes?.length)
        const [insertProd] = await tx.insert(producto).values({
          restauranteId,
          categoriaId,
          nombre: p.nombre,
          descripcion: p.descripcion,
          precio: dos(p.precio),
          activo: true,
          tieneVariantes: conVariantes,
          ...(p.tituloVariantes ? { tituloVariantesPrimarias: p.tituloVariantes } : {}),
          orden: ordenProducto,
          esEjemplo: true,
        })
        const productoId = Number(insertProd.insertId)
        if (conVariantes) {
          await tx.insert(varianteProducto).values(
            p.variantes!.map((v) => ({ productoId, nombre: v.nombre, precio: dos(v.precio), grupo: 1, activo: true })),
          )
        }
        sembrados++
      }
    }
    return { productosEjemplo: sembrados }
  })
}

/** Productos de ejemplo que todavía se ven en la carta (los desactivados ya no cuentan). */
export async function contarProductosEjemplo(db: Db, restauranteId: number): Promise<number> {
  const [fila] = await db
    .select({ n: count() })
    .from(producto)
    .where(and(eq(producto.restauranteId, restauranteId), eq(producto.esEjemplo, true), eq(producto.activo, true)))
  return Number(fila?.n ?? 0)
}

export interface ResultadoQuitarEjemplos {
  borrados: number
  /** Ya se usaron en un pedido: quedan desactivados para conservar el historial. */
  desactivados: number
  /** Fotos que el dueño les subió: se borran de R2 recién después de confirmar en la base. */
  imagenes: string[]
}

/** Quita los productos de ejemplo y las categorías de ejemplo que quedaron vacías. */
export async function quitarProductosEjemplo(db: Db, restauranteId: number): Promise<ResultadoQuitarEjemplos> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db
    const ejemplos = await tx
      .select({ id: producto.id, imagenUrl: producto.imagenUrl, imagenesExtra: producto.imagenesExtra })
      .from(producto)
      .where(and(eq(producto.restauranteId, restauranteId), eq(producto.esEjemplo, true)))
    if (ejemplos.length === 0) return { borrados: 0, desactivados: 0, imagenes: [] }

    const ids = ejemplos.map((p) => p.id)
    // Los productos de ejemplo nacieron con los pedidos unificados: no hay ítems en las tablas viejas.
    const vendidos = new Set(
      (
        await tx
          .select({ productoId: itemPedidoUnificado.productoId })
          .from(itemPedidoUnificado)
          .where(inArray(itemPedidoUnificado.productoId, ids))
      ).map((i) => i.productoId),
    )
    const aBorrar = ejemplos.filter((p) => !vendidos.has(p.id))
    const aDesactivar = ejemplos.filter((p) => vendidos.has(p.id)).map((p) => p.id)

    if (aDesactivar.length > 0) {
      await tx
        .update(producto)
        .set({ activo: false })
        .where(and(eq(producto.restauranteId, restauranteId), inArray(producto.id, aDesactivar)))
    }
    if (aBorrar.length > 0) {
      const idsBorrar = aBorrar.map((p) => p.id)
      // Las variantes y las recetas de stock se borran solas por FK con cascade.
      await tx.delete(etiqueta).where(inArray(etiqueta.productoId, idsBorrar))
      await tx.delete(productoIngrediente).where(inArray(productoIngrediente.productoId, idsBorrar))
      await tx.delete(productoAgregado).where(inArray(productoAgregado.productoId, idsBorrar))
      await tx.delete(productoPuntos).where(inArray(productoPuntos.productoId, idsBorrar))
      await tx.delete(producto).where(and(eq(producto.restauranteId, restauranteId), inArray(producto.id, idsBorrar)))
    }

    // Una categoría de ejemplo se va sólo si quedó vacía: si el dueño le sumó productos, es suya.
    const categoriasEjemplo = await tx
      .select({ id: categoria.id })
      .from(categoria)
      .where(and(eq(categoria.restauranteId, restauranteId), eq(categoria.esEjemplo, true)))
    if (categoriasEjemplo.length > 0) {
      const idsCategorias = categoriasEjemplo.map((c) => c.id)
      const restantes = await tx
        .select({ categoriaId: producto.categoriaId, esEjemplo: producto.esEjemplo })
        .from(producto)
        .where(and(eq(producto.restauranteId, restauranteId), inArray(producto.categoriaId, idsCategorias)))
      const vacias = idsCategorias.filter((id) => !restantes.some((p) => p.categoriaId === id))
      if (vacias.length > 0) {
        await tx.delete(categoria).where(and(eq(categoria.restauranteId, restauranteId), inArray(categoria.id, vacias)))
      }
      // Las que tienen productos del dueño pasan a ser suyas.
      const adoptadas = idsCategorias.filter((id) => restantes.some((p) => p.categoriaId === id && !p.esEjemplo))
      if (adoptadas.length > 0) {
        await tx.update(categoria).set({ esEjemplo: false }).where(and(eq(categoria.restauranteId, restauranteId), inArray(categoria.id, adoptadas)))
      }
    }

    return {
      borrados: aBorrar.length,
      desactivados: aDesactivar.length,
      imagenes: aBorrar.flatMap((p) => [p.imagenUrl, ...leerImagenesExtra(p.imagenesExtra)]).filter((u): u is string => !!u),
    }
  })
}
