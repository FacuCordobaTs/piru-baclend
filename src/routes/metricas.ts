import { Hono } from 'hono'
import { pool } from '../db'
import {
  pedidoUnificado as PedidoUnificadoTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  producto as ProductoTable,
  categoria as CategoriaTable,
} from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, and, sql } from 'drizzle-orm'

const metricasRoute = new Hono().use('*', authMiddleware)

// Dashboard operativo incluido en la suscripción base: ingresos, pedidos,
// medios de pago y productos principales. No usa el modelo legacy de
// planes/features ni requiere un módulo adicional.
metricasRoute.get('/', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  const monthQuery = c.req.query('month')
  const yearQuery = c.req.query('year')
  const fromQuery = c.req.query('from')
  const toQuery = c.req.query('to')

  const now = new Date()
  const year = yearQuery ? parseInt(yearQuery, 10) : now.getFullYear()
  const month = monthQuery ? parseInt(monthQuery, 10) : now.getMonth() + 1 // 1-12

  const hasRangeFilter = Boolean(fromQuery && toQuery)
  const hasValidMonth = Number.isInteger(month) && month >= 1 && month <= 12
  const hasValidYear = Number.isInteger(year) && year >= 2000 && year <= 3000

  const periodFilter = hasRangeFilter
    ? and(
        sql`DATE(${PedidoUnificadoTable.createdAt}) >= ${fromQuery!}`,
        sql`DATE(${PedidoUnificadoTable.createdAt}) <= ${toQuery!}`
      )
    : and(
        hasValidMonth ? sql`MONTH(${PedidoUnificadoTable.createdAt}) = ${month}` : sql`1 = 1`,
        hasValidYear ? sql`YEAR(${PedidoUnificadoTable.createdAt}) = ${year}` : sql`1 = 1`
      )

  // 1 & 2. Ingresos Totales del Mes Actual e Histórico
  const ingresosRes = await db
    .select({
      totalMensual: sql`SUM(CASE WHEN ${periodFilter} THEN ${PedidoUnificadoTable.total} ELSE 0 END)`,
      totalHistorico: sql`SUM(${PedidoUnificadoTable.total})`,
      // Desglose por origen: pedidos anotados manualmente en el local (sin comisión) vs tomados por la web
      totalMensualManual: sql`SUM(CASE WHEN ${periodFilter} AND ${PedidoUnificadoTable.anotadoManualmente} = true THEN ${PedidoUnificadoTable.total} ELSE 0 END)`,
      totalMensualWeb: sql`SUM(CASE WHEN ${periodFilter} AND ${PedidoUnificadoTable.anotadoManualmente} = false THEN ${PedidoUnificadoTable.total} ELSE 0 END)`,
    })
    .from(PedidoUnificadoTable)
    .where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId),
      eq(PedidoUnificadoTable.pagado, true),
      // Nos aseguramos de contar solo cancelados/archivados/etc si fueron pagados, pero mejor solo excluir cancelados que no se cobraron. eq(pagado, true) asume ingresos reales.
    ))

  const totalMensual = parseFloat(ingresosRes[0]?.totalMensual as string || '0')
  const totalHistorico = parseFloat(ingresosRes[0]?.totalHistorico as string || '0')
  const totalMensualManual = parseFloat(ingresosRes[0]?.totalMensualManual as string || '0')
  const totalMensualWeb = parseFloat(ingresosRes[0]?.totalMensualWeb as string || '0')

  // 3 & 4. Cantidad de Pedidos del Mes Actual e Históricos
  const pedidosRes = await db
    .select({
      pedidosMensuales: sql`SUM(CASE WHEN ${periodFilter} THEN 1 ELSE 0 END)`,
      pedidosMensualesPagados: sql`SUM(CASE WHEN ${periodFilter} AND ${PedidoUnificadoTable.pagado} = true THEN 1 ELSE 0 END)`,
      pedidosMensualesManual: sql`SUM(CASE WHEN ${periodFilter} AND ${PedidoUnificadoTable.anotadoManualmente} = true THEN 1 ELSE 0 END)`,
      pedidosMensualesWeb: sql`SUM(CASE WHEN ${periodFilter} AND ${PedidoUnificadoTable.anotadoManualmente} = false THEN 1 ELSE 0 END)`,
      pedidosHistoricos: sql`COUNT(${PedidoUnificadoTable.id})`,
    })
    .from(PedidoUnificadoTable)
    .where(eq(PedidoUnificadoTable.restauranteId, restauranteId))

  const pedidosMensuales = parseInt(pedidosRes[0]?.pedidosMensuales as string || '0', 10)
  const pedidosMensualesPagados = parseInt(pedidosRes[0]?.pedidosMensualesPagados as string || '0', 10)
  const pedidosMensualesManual = parseInt(pedidosRes[0]?.pedidosMensualesManual as string || '0', 10)
  const pedidosMensualesWeb = parseInt(pedidosRes[0]?.pedidosMensualesWeb as string || '0', 10)
  const pedidosHistoricos = parseInt(pedidosRes[0]?.pedidosHistoricos as string || '0', 10)

  // 5. Desglose de ingresos del Mes Actual por Medio de Pago
  const desgloseMetodoPago = await db
    .select({
      metodoPago: PedidoUnificadoTable.metodoPago,
      total: sql`SUM(${PedidoUnificadoTable.total})`,
    })
    .from(PedidoUnificadoTable)
    .where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId),
      eq(PedidoUnificadoTable.pagado, true),
      periodFilter
    ))
    .groupBy(PedidoUnificadoTable.metodoPago)

  const desglosePagoFormat = desgloseMetodoPago.map(d => ({
    metodoPago: d.metodoPago || 'desconocido',
    total: parseFloat(d.total as string || '0')
  }))

  // 6. Top 5 Productos más vendidos del mes
  const topProductosRes = await db
    .select({
      productoId: ItemPedidoUnificadoTable.productoId,
      nombre: ProductoTable.nombre,
      cantidad: sql`SUM(${ItemPedidoUnificadoTable.cantidad})`,
      totalVendido: sql`SUM(${ItemPedidoUnificadoTable.cantidad} * ${ItemPedidoUnificadoTable.precioUnitario})`,
    })
    .from(ItemPedidoUnificadoTable)
    .innerJoin(PedidoUnificadoTable, eq(ItemPedidoUnificadoTable.pedidoId, PedidoUnificadoTable.id))
    .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
    .where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId),
      eq(PedidoUnificadoTable.pagado, true),
      periodFilter
    ))
    .groupBy(ItemPedidoUnificadoTable.productoId, ProductoTable.nombre)
    .orderBy(sql`SUM(${ItemPedidoUnificadoTable.cantidad}) DESC`)
    .limit(5)

  const topProductos = topProductosRes.map(p => ({
    productoId: p.productoId,
    nombre: p.nombre || 'Producto eliminado',
    cantidad: parseInt(p.cantidad as string || '0', 10),
    totalVendido: parseFloat(p.totalVendido as string || '0')
  }))

  // Las series de abajo cuentan sólo pedidos cobrados del período, como los ingresos:
  // sus totales suman lo mismo que `ingresos.mensual`. La conexión corre en horario
  // del local (db.ts), así que HOUR() y DATE() ya son la hora y el día de Argentina.
  const cobradosDelPeriodo = and(
    eq(PedidoUnificadoTable.restauranteId, restauranteId),
    eq(PedidoUnificadoTable.pagado, true),
    periodFilter
  )
  const numero = (valor: unknown) => {
    const n = Number(valor ?? 0)
    return Number.isFinite(n) ? n : 0
  }

  // 7. Pedidos y facturación por hora del día (sólo las horas con actividad).
  const porHoraRes = await db
    .select({
      hora: sql<number>`HOUR(${PedidoUnificadoTable.createdAt})`,
      pedidos: sql<number>`COUNT(*)`,
      total: sql<string>`SUM(${PedidoUnificadoTable.total})`,
    })
    .from(PedidoUnificadoTable)
    .where(cobradosDelPeriodo)
    .groupBy(sql`HOUR(${PedidoUnificadoTable.createdAt})`)
    .orderBy(sql`HOUR(${PedidoUnificadoTable.createdAt})`)

  // 8. Pedidos y facturación por día (sólo los días con actividad).
  const porDiaRes = await db
    .select({
      fecha: sql<string>`DATE(${PedidoUnificadoTable.createdAt})`,
      pedidos: sql<number>`COUNT(*)`,
      total: sql<string>`SUM(${PedidoUnificadoTable.total})`,
    })
    .from(PedidoUnificadoTable)
    .where(cobradosDelPeriodo)
    .groupBy(sql`DATE(${PedidoUnificadoTable.createdAt})`)
    .orderBy(sql`DATE(${PedidoUnificadoTable.createdAt})`)

  // 9. Unidades y facturación por categoría. Los productos sin categoría (o ya
  // borrados) quedan juntos con `categoriaId` y `nombre` en null.
  const porCategoriaRes = await db
    .select({
      categoriaId: ProductoTable.categoriaId,
      nombre: CategoriaTable.nombre,
      cantidad: sql`SUM(${ItemPedidoUnificadoTable.cantidad})`,
      totalVendido: sql`SUM(${ItemPedidoUnificadoTable.cantidad} * ${ItemPedidoUnificadoTable.precioUnitario})`,
    })
    .from(ItemPedidoUnificadoTable)
    .innerJoin(PedidoUnificadoTable, eq(ItemPedidoUnificadoTable.pedidoId, PedidoUnificadoTable.id))
    .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
    .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
    .where(cobradosDelPeriodo)
    .groupBy(ProductoTable.categoriaId, CategoriaTable.nombre)
    .orderBy(sql`SUM(${ItemPedidoUnificadoTable.cantidad} * ${ItemPedidoUnificadoTable.precioUnitario}) DESC`)

  // 10. Productos más vendidos, con su categoría: el ranking completo que el
  // top 5 de arriba no alcanza a mostrar (por categoría hace falta ver más).
  const productosVendidosRes = await db
    .select({
      productoId: ItemPedidoUnificadoTable.productoId,
      nombre: ProductoTable.nombre,
      categoria: CategoriaTable.nombre,
      cantidad: sql`SUM(${ItemPedidoUnificadoTable.cantidad})`,
      totalVendido: sql`SUM(${ItemPedidoUnificadoTable.cantidad} * ${ItemPedidoUnificadoTable.precioUnitario})`,
    })
    .from(ItemPedidoUnificadoTable)
    .innerJoin(PedidoUnificadoTable, eq(ItemPedidoUnificadoTable.pedidoId, PedidoUnificadoTable.id))
    .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
    .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
    .where(cobradosDelPeriodo)
    .groupBy(ItemPedidoUnificadoTable.productoId, ProductoTable.nombre, CategoriaTable.nombre)
    .orderBy(sql`SUM(${ItemPedidoUnificadoTable.cantidad}) DESC`)
    .limit(50)

  return c.json({
    success: true,
    data: {
      ingresos: {
        mensual: totalMensual,
        historico: totalHistorico,
        mensualManual: totalMensualManual,
        mensualWeb: totalMensualWeb
      },
      pedidos: {
        mensuales: pedidosMensuales,
        mensualesPagados: pedidosMensualesPagados,
        mensualesManual: pedidosMensualesManual,
        mensualesWeb: pedidosMensualesWeb,
        historicos: pedidosHistoricos
      },
      desgloseMetodoPago: desglosePagoFormat,
      topProductos,
      porHora: porHoraRes.map(r => ({
        hora: numero(r.hora),
        pedidos: numero(r.pedidos),
        total: numero(r.total),
      })),
      porDia: porDiaRes.map(r => ({
        fecha: String(r.fecha).slice(0, 10),
        pedidos: numero(r.pedidos),
        total: numero(r.total),
      })),
      porCategoria: porCategoriaRes.map(r => ({
        categoriaId: r.categoriaId ?? null,
        nombre: r.nombre ?? 'Sin categoría',
        cantidad: numero(r.cantidad),
        totalVendido: numero(r.totalVendido),
      })),
      productosVendidos: productosVendidosRes.map(r => ({
        productoId: r.productoId,
        nombre: r.nombre || 'Producto eliminado',
        categoria: r.categoria ?? null,
        cantidad: numero(r.cantidad),
        totalVendido: numero(r.totalVendido),
      })),
    }
  }, 200)
})

export { metricasRoute }
