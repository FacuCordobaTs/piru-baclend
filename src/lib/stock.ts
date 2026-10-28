/**
 * Dominio de control de stock (`gestion_stock`).
 *
 * El stock no se descuenta en cada alta de pedido: se concilia contra
 * `item_pedido_unificado` desde `stock_movimiento`, que actúa como ledger
 * idempotente. Así todas las superficies que crean o editan pedidos (web, POS,
 * mozos, IA, salas) participan sin tocar cada endpoint, y una edición o un
 * borrado restauran exactamente lo que corresponde.
 *
 * La conciliación corre al abrir el resumen o las alertas del módulo. El primer
 * cursor toma `now`: nunca descuenta pedidos históricos anteriores a que el
 * local empezara a usar stock.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  categoria as CategoriaTable,
  insumo as InsumoTable,
  itemPedidoUnificado as ItemPedidoTable,
  modulo as ModuloTable,
  pedidoUnificado as PedidoTable,
  producto as ProductoTable,
  productoConsumo as ProductoConsumoTable,
  restauranteModulo as RestauranteModuloTable,
  stockGasto as StockGastoTable,
  stockGastoItem as StockGastoItemTable,
  stockMovimiento as StockMovimientoTable,
  stockSync as StockSyncTable,
  varianteProducto as VarianteProductoTable,
} from '../db/schema'

export type UnidadStock = 'unidad' | 'gramo' | 'kilogramo' | 'mililitro' | 'litro'
export const UNIDADES_STOCK: readonly UnidadStock[] = ['unidad', 'gramo', 'kilogramo', 'mililitro', 'litro']

export interface RecetaConsumo {
  insumoId: number
  varianteId: number | null
  cantidad: number
}

export interface ItemParaConsumo {
  varianteId: number | null
  varianteSecundariaId: number | null
  cantidad: number
}

/** Redondeo de cantidades a la precisión del schema (3 decimales). */
export function redondearCantidad(valor: number): number {
  if (!Number.isFinite(valor)) return 0
  return Math.round(valor * 1000) / 1000
}

/**
 * Umbral de alerta. Si el local lo cargó, manda su valor (0 es válido: avisar
 * sólo al llegar a cero). Si no, se usa el 20% del máximo histórico. Sin
 * historial ni umbral explícito no hay alerta: todavía no hay referencia.
 */
export function umbralStockMinimo(stockMinimo: number | null | undefined, stockMaximo: number): number | null {
  if (stockMinimo != null && Number.isFinite(Number(stockMinimo))) return redondearCantidad(Number(stockMinimo))
  const maximo = Number(stockMaximo)
  if (!Number.isFinite(maximo) || maximo <= 0) return null
  return redondearCantidad(maximo * 0.2)
}

export function estaBajoStock(input: {
  stockActual: number
  stockMinimo: number | null | undefined
  stockMaximo: number
  activo?: boolean
}): boolean {
  if (input.activo === false) return false
  const umbral = umbralStockMinimo(input.stockMinimo, input.stockMaximo)
  if (umbral == null) return false
  return Number(input.stockActual) <= umbral
}

/**
 * Cantidades de cada insumo que consume un ítem vendido.
 *
 * La receta base (varianteId NULL) siempre aplica. Las filas de una variante
 * primaria o secundaria se suman sólo cuando el ítem eligió esa variante.
 */
export function consumoDeItem(
  recetas: RecetaConsumo[],
  item: ItemParaConsumo,
): Map<number, number> {
  const resultado = new Map<number, number>()
  for (const receta of recetas) {
    const aplica = receta.varianteId == null
      || receta.varianteId === item.varianteId
      || receta.varianteId === item.varianteSecundariaId
    if (!aplica) continue
    const cantidad = Number(receta.cantidad) * Number(item.cantidad)
    if (!Number.isFinite(cantidad) || cantidad === 0) continue
    resultado.set(receta.insumoId, redondearCantidad((resultado.get(receta.insumoId) ?? 0) + cantidad))
  }
  return resultado
}

export interface ResultadoSincronizacionStock {
  procesados: number
  consumos: number
  restaurados: number
}

/**
 * Concilia los pedidos creados/actualizados desde el último cursor contra el
 * ledger de consumo. Es idempotente: cada movimiento se identifica por
 * `(item_pedido_id, insumo_id)`.
 */
export async function sincronizarStock(db: any, restauranteId: number): Promise<ResultadoSincronizacionStock> {
  const ahora = new Date()
  return db.transaction(async (tx: any) => {
    let [estado] = await tx
      .select()
      .from(StockSyncTable)
      .where(eq(StockSyncTable.restauranteId, restauranteId))
      .limit(1)
      .for('update')

    if (!estado) {
      await tx.insert(StockSyncTable).values({ restauranteId, ultimaSincronizacion: ahora }).ignore()
      return { procesados: 0, consumos: 0, restaurados: 0 }
    }

    // Una activación posterior al cursor implica que el módulo estuvo apagado:
    // se reinicia la base para no descontar pedidos del período sin control.
    const [activacion] = await tx
      .select({ activadoAt: RestauranteModuloTable.activadoAt })
      .from(RestauranteModuloTable)
      .innerJoin(ModuloTable, eq(RestauranteModuloTable.moduloId, ModuloTable.id))
      .where(and(
        eq(RestauranteModuloTable.restauranteId, restauranteId),
        eq(ModuloTable.codigo, 'gestion_stock'),
      ))
      .limit(1)
    if (activacion?.activadoAt && estado.ultimaSincronizacion < activacion.activadoAt) {
      await tx.update(StockSyncTable)
        .set({ ultimaSincronizacion: ahora })
        .where(eq(StockSyncTable.restauranteId, restauranteId))
      return { procesados: 0, consumos: 0, restaurados: 0 }
    }

    const desde: Date = estado.ultimaSincronizacion
    // `DATETIME` no guarda milisegundos y una edición puede confirmarse mientras
    // corre esta sincronización. El solapamiento de 10 s hace que el próximo
    // pase vuelva a ver esos pedidos; el ledger por (item, insumo) lo torna
    // idempotente y no duplica consumos.
    const desdeConsulta = new Date(desde.getTime() - 10_000)

    const pedidos = await tx
      .select({ id: PedidoTable.id, estado: PedidoTable.estado })
      .from(PedidoTable)
      .where(and(
        eq(PedidoTable.restauranteId, restauranteId),
        // Un alta nace con `updated_at` = `created_at`; toda edición lo mueve.
        gte(PedidoTable.updatedAt, desdeConsulta),
      ))
      .orderBy(asc(PedidoTable.updatedAt), asc(PedidoTable.id))

    let consumos = 0
    let restaurados = 0
    const deltas = new Map<number, number>()
    const sumarDelta = (insumoId: number, delta: number) => {
      if (Math.abs(delta) < 0.0005) return
      deltas.set(insumoId, redondearCantidad((deltas.get(insumoId) ?? 0) + delta))
    }

    if (pedidos.length > 0) {
      const pedidoIds = pedidos.map((pedido: any) => pedido.id)
      const pedidoPorId = new Map<number, any>(pedidos.map((pedido: any) => [pedido.id, pedido]))

      const items = await tx
        .select({
          id: ItemPedidoTable.id,
          pedidoId: ItemPedidoTable.pedidoId,
          productoId: ItemPedidoTable.productoId,
          varianteId: ItemPedidoTable.varianteId,
          varianteSecundariaId: ItemPedidoTable.varianteSecundariaId,
          cantidad: ItemPedidoTable.cantidad,
        })
        .from(ItemPedidoTable)
        .where(inArray(ItemPedidoTable.pedidoId, pedidoIds))

      const recetasRows = await tx
        .select({
          productoId: ProductoConsumoTable.productoId,
          insumoId: ProductoConsumoTable.insumoId,
          varianteId: ProductoConsumoTable.varianteId,
          cantidad: ProductoConsumoTable.cantidad,
        })
        .from(ProductoConsumoTable)
        .innerJoin(ProductoTable, eq(ProductoConsumoTable.productoId, ProductoTable.id))
        .innerJoin(InsumoTable, eq(ProductoConsumoTable.insumoId, InsumoTable.id))
        .where(and(eq(ProductoTable.restauranteId, restauranteId), eq(InsumoTable.activo, true)))

      const recetasPorProducto = new Map<number, RecetaConsumo[]>()
      for (const fila of recetasRows) {
        const lista = recetasPorProducto.get(Number(fila.productoId)) ?? []
        lista.push({
          insumoId: Number(fila.insumoId),
          varianteId: fila.varianteId == null ? null : Number(fila.varianteId),
          cantidad: Number(fila.cantidad),
        })
        recetasPorProducto.set(Number(fila.productoId), lista)
      }

      const movimientos = await tx
        .select()
        .from(StockMovimientoTable)
        .where(and(
          eq(StockMovimientoTable.restauranteId, restauranteId),
          eq(StockMovimientoTable.tipo, 'consumo'),
          inArray(StockMovimientoTable.pedidoId, pedidoIds),
        ))

      const movimientosPorPedido = new Map<number, any[]>()
      for (const movimiento of movimientos) {
        const lista = movimientosPorPedido.get(Number(movimiento.pedidoId)) ?? []
        lista.push(movimiento)
        movimientosPorPedido.set(Number(movimiento.pedidoId), lista)
      }

      const itemsPorPedido = new Map<number, any[]>()
      for (const item of items) {
        const lista = itemsPorPedido.get(Number(item.pedidoId)) ?? []
        lista.push(item)
        itemsPorPedido.set(Number(item.pedidoId), lista)
      }

      for (const pedidoId of pedidoIds) {
        const pedido = pedidoPorId.get(pedidoId)
        const deseado = new Map<string, { itemId: number; insumoId: number; cantidad: number }>()

        // Un pedido cancelado devuelve lo que había consumido; los entregados
        // y archivados mantienen el consumo.
        if (pedido?.estado !== 'cancelled') {
          for (const item of itemsPorPedido.get(pedidoId) ?? []) {
            const recetas = recetasPorProducto.get(Number(item.productoId))
            if (!recetas || recetas.length === 0) continue
            const porInsumo = consumoDeItem(recetas, {
              varianteId: item.varianteId == null ? null : Number(item.varianteId),
              varianteSecundariaId: item.varianteSecundariaId == null ? null : Number(item.varianteSecundariaId),
              cantidad: Number(item.cantidad),
            })
            for (const [insumoId, cantidad] of porInsumo) {
              const clave = `${item.id}:${insumoId}`
              const existente = deseado.get(clave)
              deseado.set(clave, {
                itemId: Number(item.id),
                insumoId,
                cantidad: redondearCantidad((existente?.cantidad ?? 0) + cantidad),
              })
            }
          }
        }

        const existentes = new Map<string, any>()
        for (const movimiento of movimientosPorPedido.get(pedidoId) ?? []) {
          existentes.set(`${movimiento.itemPedidoId}:${movimiento.insumoId}`, movimiento)
        }

        for (const [clave, objetivo] of deseado) {
          const existente = existentes.get(clave)
          const movimientoObjetivo = redondearCantidad(-objetivo.cantidad)
          if (!existente) {
            await tx.insert(StockMovimientoTable).values({
              restauranteId,
              insumoId: objetivo.insumoId,
              tipo: 'consumo',
              cantidad: movimientoObjetivo.toFixed(3),
              pedidoId,
              itemPedidoId: objetivo.itemId,
            })
            sumarDelta(objetivo.insumoId, movimientoObjetivo)
            consumos++
            continue
          }
          const actual = Number(existente.cantidad)
          const delta = redondearCantidad(movimientoObjetivo - actual)
          if (Math.abs(delta) < 0.0005) continue
          await tx.update(StockMovimientoTable)
            .set({ cantidad: movimientoObjetivo.toFixed(3) })
            .where(eq(StockMovimientoTable.id, existente.id))
          sumarDelta(objetivo.insumoId, delta)
        }

        for (const [clave, movimiento] of existentes) {
          if (deseado.has(clave)) continue
          sumarDelta(Number(movimiento.insumoId), redondearCantidad(-Number(movimiento.cantidad)))
          await tx.delete(StockMovimientoTable).where(eq(StockMovimientoTable.id, movimiento.id))
          restaurados++
        }
      }
    }

    // Pedidos borrados: el ledger no tiene FK para sobrevivir al DELETE. Se
    // restauran los consumos cuya fila de pedido ya no existe.
    const huerfanos = await tx
      .select({
        id: StockMovimientoTable.id,
        insumoId: StockMovimientoTable.insumoId,
        cantidad: StockMovimientoTable.cantidad,
      })
      .from(StockMovimientoTable)
      .leftJoin(PedidoTable, eq(StockMovimientoTable.pedidoId, PedidoTable.id))
      .where(and(
        eq(StockMovimientoTable.restauranteId, restauranteId),
        eq(StockMovimientoTable.tipo, 'consumo'),
        isNotNull(StockMovimientoTable.pedidoId),
        isNull(PedidoTable.id),
      ))
    for (const movimiento of huerfanos) {
      sumarDelta(Number(movimiento.insumoId), redondearCantidad(-Number(movimiento.cantidad)))
      await tx.delete(StockMovimientoTable).where(eq(StockMovimientoTable.id, movimiento.id))
      restaurados++
    }

    for (const [insumoId, delta] of deltas) {
      await tx.update(InsumoTable)
        .set({ stockActual: sql`${InsumoTable.stockActual} + ${delta}` })
        .where(and(eq(InsumoTable.id, insumoId), eq(InsumoTable.restauranteId, restauranteId)))
    }

    await tx.update(StockSyncTable)
      .set({ ultimaSincronizacion: ahora })
      .where(eq(StockSyncTable.restauranteId, restauranteId))

    return { procesados: pedidos.length, consumos, restaurados }
  })
}

export interface InsumoDto {
  id: number
  nombre: string
  unidad: UnidadStock
  stockActual: number
  stockMinimo: number | null
  stockMinimoEfectivo: number | null
  stockMaximo: number
  costoUltimo: number | null
  activo: boolean
  bajoStock: boolean
  sinStock: boolean
}

function mapInsumo(fila: any): InsumoDto {
  const stockActual = Number(fila.stockActual ?? 0)
  const stockMaximo = Number(fila.stockMaximo ?? 0)
  const minimo = fila.stockMinimo == null ? null : Number(fila.stockMinimo)
  const efectivo = umbralStockMinimo(minimo, stockMaximo)
  const activo = fila.activo !== false
  const bajoStock = estaBajoStock({ stockActual, stockMinimo: minimo, stockMaximo, activo })
  return {
    id: Number(fila.id),
    nombre: fila.nombre,
    unidad: fila.unidad as UnidadStock,
    stockActual: redondearCantidad(stockActual),
    stockMinimo: minimo == null ? null : redondearCantidad(minimo),
    stockMinimoEfectivo: efectivo,
    stockMaximo: redondearCantidad(stockMaximo),
    costoUltimo: fila.costoUltimo == null ? null : Number(fila.costoUltimo),
    activo,
    bajoStock,
    // "Sin stock" sólo tiene sentido cuando hay una referencia configurada.
    sinStock: activo && efectivo != null && stockActual <= 0,
  }
}

export async function resumenStock(db: any, restauranteId: number) {
  await sincronizarStock(db, restauranteId)

  const insumosRows = await db
    .select()
    .from(InsumoTable)
    .where(eq(InsumoTable.restauranteId, restauranteId))
    .orderBy(asc(InsumoTable.nombre), asc(InsumoTable.id))
  const insumos = insumosRows.map(mapInsumo)
  const alertas = insumos.filter((insumo: InsumoDto) => insumo.bajoStock)

  const productosRows = await db
    .select({
      id: ProductoTable.id,
      nombre: ProductoTable.nombre,
      activo: ProductoTable.activo,
      categoriaId: ProductoTable.categoriaId,
      categoria: CategoriaTable.nombre,
    })
    .from(ProductoTable)
    .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
    .where(eq(ProductoTable.restauranteId, restauranteId))
    .orderBy(asc(ProductoTable.nombre), asc(ProductoTable.id))

  const variantesRows = await db
    .select({
      id: VarianteProductoTable.id,
      productoId: VarianteProductoTable.productoId,
      nombre: VarianteProductoTable.nombre,
      grupo: VarianteProductoTable.grupo,
      activo: VarianteProductoTable.activo,
    })
    .from(VarianteProductoTable)
    .innerJoin(ProductoTable, eq(VarianteProductoTable.productoId, ProductoTable.id))
    .where(eq(ProductoTable.restauranteId, restauranteId))
    .orderBy(asc(VarianteProductoTable.grupo), asc(VarianteProductoTable.id))

  const consumosRows = await db
    .select({
      productoId: ProductoConsumoTable.productoId,
      insumoId: ProductoConsumoTable.insumoId,
      varianteId: ProductoConsumoTable.varianteId,
      cantidad: ProductoConsumoTable.cantidad,
    })
    .from(ProductoConsumoTable)
    .innerJoin(ProductoTable, eq(ProductoConsumoTable.productoId, ProductoTable.id))
    .where(eq(ProductoTable.restauranteId, restauranteId))

  const variantesPorProducto = new Map<number, any[]>()
  for (const variante of variantesRows) {
    const lista = variantesPorProducto.get(Number(variante.productoId)) ?? []
    lista.push({
      id: Number(variante.id),
      nombre: variante.nombre,
      grupo: Number(variante.grupo),
      activo: variante.activo !== false,
    })
    variantesPorProducto.set(Number(variante.productoId), lista)
  }

  const consumosPorProducto = new Map<number, any[]>()
  for (const consumo of consumosRows) {
    const lista = consumosPorProducto.get(Number(consumo.productoId)) ?? []
    lista.push({
      insumoId: Number(consumo.insumoId),
      varianteId: consumo.varianteId == null ? null : Number(consumo.varianteId),
      cantidad: Number(consumo.cantidad),
    })
    consumosPorProducto.set(Number(consumo.productoId), lista)
  }

  const productos = productosRows.map((producto: any) => {
    const consumos = consumosPorProducto.get(Number(producto.id)) ?? []
    return {
      id: Number(producto.id),
      nombre: producto.nombre,
      activo: producto.activo !== false,
      categoriaId: producto.categoriaId == null ? null : Number(producto.categoriaId),
      categoria: producto.categoria ?? null,
      variantes: variantesPorProducto.get(Number(producto.id)) ?? [],
      consumos,
      tieneConsumos: consumos.length > 0,
    }
  })

  const gastosRows = await db
    .select()
    .from(StockGastoTable)
    .where(eq(StockGastoTable.restauranteId, restauranteId))
    .orderBy(desc(StockGastoTable.fecha), desc(StockGastoTable.id))
    .limit(8)

  let gastos: any[] = []
  if (gastosRows.length > 0) {
    const gastoIds = gastosRows.map((gasto: any) => Number(gasto.id))
    const itemsGasto = await db
      .select({
        gastoId: StockGastoItemTable.gastoId,
        insumoId: StockGastoItemTable.insumoId,
        cantidad: StockGastoItemTable.cantidad,
        costoUnitario: StockGastoItemTable.costoUnitario,
        subtotal: StockGastoItemTable.subtotal,
        insumoNombre: InsumoTable.nombre,
        unidad: InsumoTable.unidad,
      })
      .from(StockGastoItemTable)
      .innerJoin(InsumoTable, eq(StockGastoItemTable.insumoId, InsumoTable.id))
      .where(inArray(StockGastoItemTable.gastoId, gastoIds))
    const itemsPorGasto = new Map<number, any[]>()
    for (const item of itemsGasto) {
      const lista = itemsPorGasto.get(Number(item.gastoId)) ?? []
      lista.push({
        insumoId: Number(item.insumoId),
        insumoNombre: item.insumoNombre,
        unidad: item.unidad,
        cantidad: Number(item.cantidad),
        costoUnitario: Number(item.costoUnitario),
        subtotal: Number(item.subtotal),
      })
      itemsPorGasto.set(Number(item.gastoId), lista)
    }
    gastos = gastosRows.map((gasto: any) => ({
      id: Number(gasto.id),
      descripcion: gasto.descripcion,
      proveedor: gasto.proveedor,
      fecha: gasto.fecha,
      total: Number(gasto.total),
      items: itemsPorGasto.get(Number(gasto.id)) ?? [],
    }))
  }

  const movimientosRows = await db
    .select({
      id: StockMovimientoTable.id,
      insumoId: StockMovimientoTable.insumoId,
      insumoNombre: InsumoTable.nombre,
      unidad: InsumoTable.unidad,
      tipo: StockMovimientoTable.tipo,
      cantidad: StockMovimientoTable.cantidad,
      nota: StockMovimientoTable.nota,
      createdAt: StockMovimientoTable.createdAt,
    })
    .from(StockMovimientoTable)
    .innerJoin(InsumoTable, eq(StockMovimientoTable.insumoId, InsumoTable.id))
    .where(eq(StockMovimientoTable.restauranteId, restauranteId))
    .orderBy(desc(StockMovimientoTable.createdAt), desc(StockMovimientoTable.id))
    .limit(15)

  return {
    insumos,
    productos,
    gastos,
    alertas: { total: alertas.length, insumos: alertas },
    movimientos: movimientosRows.map((movimiento: any) => ({
      id: Number(movimiento.id),
      insumoId: Number(movimiento.insumoId),
      insumoNombre: movimiento.insumoNombre,
      unidad: movimiento.unidad,
      tipo: movimiento.tipo,
      cantidad: Number(movimiento.cantidad),
      nota: movimiento.nota,
      createdAt: movimiento.createdAt,
    })),
  }
}

/** Consulta liviana para el banner del Dashboard: no arma productos ni gastos. */
export async function alertasStock(db: any, restauranteId: number) {
  await sincronizarStock(db, restauranteId)
  const filas = await db
    .select()
    .from(InsumoTable)
    .where(and(eq(InsumoTable.restauranteId, restauranteId), eq(InsumoTable.activo, true)))
    .orderBy(asc(InsumoTable.nombre), asc(InsumoTable.id))
  const insumos = filas.map(mapInsumo).filter((insumo: InsumoDto) => insumo.bajoStock)
  return { total: insumos.length, insumos }
}

export interface CrearInsumoInput {
  nombre: string
  unidad: UnidadStock
  stockInicial?: number | null
  stockMinimo?: number | null
  costoUnitario?: number | null
}

export async function crearInsumo(db: any, restauranteId: number, input: CrearInsumoInput) {
  return db.transaction(async (tx: any) => {
    const stockInicial = redondearCantidad(Number(input.stockInicial ?? 0))
    if (stockInicial < 0) throw new Error('El stock inicial no puede ser negativo')
    const [insertado] = await tx.insert(InsumoTable).values({
      restauranteId,
      nombre: input.nombre.trim(),
      unidad: input.unidad,
      stockActual: stockInicial.toFixed(3),
      stockMinimo: input.stockMinimo == null ? null : redondearCantidad(Number(input.stockMinimo)).toFixed(3),
      stockMaximo: Math.max(0, stockInicial).toFixed(3),
      costoUltimo: input.costoUnitario == null ? null : Number(input.costoUnitario).toFixed(2),
    })
    const id = Number(insertado.insertId)
    if (stockInicial !== 0) {
      await tx.insert(StockMovimientoTable).values({
        restauranteId,
        insumoId: id,
        tipo: 'ajuste',
        cantidad: stockInicial.toFixed(3),
        costoUnitario: input.costoUnitario == null ? null : Number(input.costoUnitario).toFixed(2),
        nota: 'Stock inicial',
      })
    }
    const [fila] = await tx.select().from(InsumoTable).where(eq(InsumoTable.id, id)).limit(1)
    return mapInsumo(fila)
  })
}

export interface ActualizarInsumoInput {
  nombre?: string
  unidad?: UnidadStock
  stockActual?: number
  stockMinimo?: number | null
  costoUnitario?: number | null
  activo?: boolean
}

export async function actualizarInsumo(
  db: any,
  restauranteId: number,
  insumoId: number,
  input: ActualizarInsumoInput,
) {
  return db.transaction(async (tx: any) => {
    const [actual] = await tx
      .select()
      .from(InsumoTable)
      .where(and(eq(InsumoTable.id, insumoId), eq(InsumoTable.restauranteId, restauranteId)))
      .limit(1)
      .for('update')
    if (!actual) return null

    const cambios: any = {}
    if (input.nombre !== undefined) cambios.nombre = input.nombre.trim()
    if (input.unidad !== undefined) cambios.unidad = input.unidad
    if (input.stockMinimo !== undefined) {
      cambios.stockMinimo = input.stockMinimo == null ? null : redondearCantidad(Number(input.stockMinimo)).toFixed(3)
    }
    if (input.costoUnitario !== undefined) {
      cambios.costoUltimo = input.costoUnitario == null ? null : Number(input.costoUnitario).toFixed(2)
    }
    if (input.activo !== undefined) cambios.activo = input.activo

    if (input.stockActual !== undefined) {
      const nuevo = redondearCantidad(Number(input.stockActual))
      if (!Number.isFinite(nuevo)) throw new Error('El stock debe ser un número válido')
      const anterior = Number(actual.stockActual)
      const delta = redondearCantidad(nuevo - anterior)
      cambios.stockActual = nuevo.toFixed(3)
      if (Math.abs(delta) >= 0.0005) {
        await tx.insert(StockMovimientoTable).values({
          restauranteId,
          insumoId,
          tipo: 'ajuste',
          cantidad: delta.toFixed(3),
          nota: 'Ajuste manual de stock',
        })
      }
      if (nuevo > Number(actual.stockMaximo)) cambios.stockMaximo = nuevo.toFixed(3)
    }

    if (Object.keys(cambios).length > 0) {
      await tx.update(InsumoTable)
        .set(cambios)
        .where(and(eq(InsumoTable.id, insumoId), eq(InsumoTable.restauranteId, restauranteId)))
    }
    const [fila] = await tx.select().from(InsumoTable).where(eq(InsumoTable.id, insumoId)).limit(1)
    return mapInsumo(fila)
  })
}

export async function eliminarInsumo(db: any, restauranteId: number, insumoId: number) {
  return db.transaction(async (tx: any) => {
    const [actual] = await tx
      .select()
      .from(InsumoTable)
      .where(and(eq(InsumoTable.id, insumoId), eq(InsumoTable.restauranteId, restauranteId)))
      .limit(1)
      .for('update')
    if (!actual) return { ok: false as const, motivo: 'no_encontrado' as const }

    const [movimiento] = await tx
      .select({ id: StockMovimientoTable.id })
      .from(StockMovimientoTable)
      .where(and(eq(StockMovimientoTable.restauranteId, restauranteId), eq(StockMovimientoTable.insumoId, insumoId)))
      .limit(1)
    if (movimiento) return { ok: false as const, motivo: 'con_movimientos' as const }

    const [gastoItem] = await tx
      .select({ id: StockGastoItemTable.id })
      .from(StockGastoItemTable)
      .where(eq(StockGastoItemTable.insumoId, insumoId))
      .limit(1)
    if (gastoItem) return { ok: false as const, motivo: 'con_movimientos' as const }

    await tx.delete(ProductoConsumoTable).where(eq(ProductoConsumoTable.insumoId, insumoId))
    await tx.delete(InsumoTable).where(and(eq(InsumoTable.id, insumoId), eq(InsumoTable.restauranteId, restauranteId)))
    return { ok: true as const }
  })
}

export interface GastoItemInput {
  insumoId: number
  cantidad: number
  costoUnitario: number
}

export interface GastoInput {
  descripcion: string
  proveedor?: string | null
  fecha?: string | Date | null
  items: GastoItemInput[]
}

export async function cargarGasto(db: any, restauranteId: number, input: GastoInput) {
  // La conciliación previa evita que una compra se mezcle con consumos que
  // todavía no se habían asentado.
  await sincronizarStock(db, restauranteId)
  return db.transaction(async (tx: any) => {
    const items = input.items
      .map((item) => ({
        insumoId: Number(item.insumoId),
        cantidad: redondearCantidad(Number(item.cantidad)),
        costoUnitario: Number(item.costoUnitario) || 0,
      }))
      .filter((item) => item.insumoId > 0 && item.cantidad > 0)
    if (items.length === 0) throw new Error('Agregá al menos un insumo con cantidad')

    const ids = [...new Set(items.map((item) => item.insumoId))]
    const existentes = await tx
      .select({ id: InsumoTable.id })
      .from(InsumoTable)
      .where(and(eq(InsumoTable.restauranteId, restauranteId), inArray(InsumoTable.id, ids)))
    if (existentes.length !== ids.length) throw new Error('Algún insumo no pertenece a este local')

    const total = items.reduce((suma, item) => suma + item.cantidad * item.costoUnitario, 0)
    const fecha = input.fecha ? new Date(input.fecha) : new Date()
    const [gasto] = await tx.insert(StockGastoTable).values({
      restauranteId,
      descripcion: input.descripcion.trim(),
      proveedor: input.proveedor?.trim() || null,
      fecha: Number.isNaN(fecha.getTime()) ? new Date() : fecha,
      total: total.toFixed(2),
    })
    const gastoId = Number(gasto.insertId)

    for (const item of items) {
      const subtotal = redondearCantidad(item.cantidad * item.costoUnitario)
      await tx.insert(StockGastoItemTable).values({
        gastoId,
        insumoId: item.insumoId,
        cantidad: item.cantidad.toFixed(3),
        costoUnitario: item.costoUnitario.toFixed(2),
        subtotal: subtotal.toFixed(2),
      })
      await tx.update(InsumoTable)
        .set({
          stockActual: sql`${InsumoTable.stockActual} + ${item.cantidad}`,
          stockMaximo: sql`GREATEST(${InsumoTable.stockMaximo}, ${InsumoTable.stockActual} + ${item.cantidad})`,
          costoUltimo: item.costoUnitario.toFixed(2),
        })
        .where(and(eq(InsumoTable.id, item.insumoId), eq(InsumoTable.restauranteId, restauranteId)))
      await tx.insert(StockMovimientoTable).values({
        restauranteId,
        insumoId: item.insumoId,
        tipo: 'compra',
        cantidad: item.cantidad.toFixed(3),
        costoUnitario: item.costoUnitario.toFixed(2),
        gastoId,
        nota: input.descripcion.trim(),
      })
    }

    return { id: gastoId, total: Number(total.toFixed(2)) }
  })
}

export interface ConsumoInput {
  insumoId: number
  varianteId: number | null
  cantidad: number
}

export async function guardarConsumosProducto(
  db: any,
  restauranteId: number,
  productoId: number,
  consumos: ConsumoInput[],
) {
  // Lo que ya pasó con la receta anterior queda asentado antes de cambiarla.
  await sincronizarStock(db, restauranteId)
  return db.transaction(async (tx: any) => {
    const [producto] = await tx
      .select({ id: ProductoTable.id })
      .from(ProductoTable)
      .where(and(eq(ProductoTable.id, productoId), eq(ProductoTable.restauranteId, restauranteId)))
      .limit(1)
    if (!producto) return { ok: false as const, motivo: 'producto' as const }

    const variantes = await tx
      .select({ id: VarianteProductoTable.id })
      .from(VarianteProductoTable)
      .where(eq(VarianteProductoTable.productoId, productoId))
    const variantesValidas = new Set(variantes.map((variante: any) => Number(variante.id)))

    const insumos = await tx
      .select({ id: InsumoTable.id })
      .from(InsumoTable)
      .where(eq(InsumoTable.restauranteId, restauranteId))
    const insumosValidos = new Set(insumos.map((insumo: any) => Number(insumo.id)))

    const normalizados: Array<{ insumoId: number; varianteId: number | null; cantidad: number }> = []
    for (const consumo of consumos) {
      const insumoId = Number(consumo.insumoId)
      const varianteId = consumo.varianteId == null ? null : Number(consumo.varianteId)
      const cantidad = redondearCantidad(Number(consumo.cantidad))
      if (!insumosValidos.has(insumoId)) return { ok: false as const, motivo: 'insumo' as const }
      if (varianteId != null && !variantesValidas.has(varianteId)) return { ok: false as const, motivo: 'variante' as const }
      if (!Number.isFinite(cantidad) || cantidad <= 0) continue
      normalizados.push({ insumoId, varianteId, cantidad })
    }

    await tx.delete(ProductoConsumoTable).where(eq(ProductoConsumoTable.productoId, productoId))
    if (normalizados.length > 0) {
      // Se agrupan por insumo+variante para no guardar filas repetidas.
      const agrupados = new Map<string, { insumoId: number; varianteId: number | null; cantidad: number }>()
      for (const item of normalizados) {
        const clave = `${item.varianteId ?? 'base'}:${item.insumoId}`
        const anterior = agrupados.get(clave)
        agrupados.set(clave, {
          ...item,
          cantidad: redondearCantidad((anterior?.cantidad ?? 0) + item.cantidad),
        })
      }
      await tx.insert(ProductoConsumoTable).values([...agrupados.values()].map((item) => ({
        productoId,
        insumoId: item.insumoId,
        varianteId: item.varianteId,
        cantidad: item.cantidad.toFixed(3),
      })))
    }
    return { ok: true as const, consumos: normalizados.length }
  })
}
