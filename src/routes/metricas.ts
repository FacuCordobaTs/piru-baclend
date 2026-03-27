import { Hono } from 'hono'
import { pool } from '../db'
import {
  pedidoUnificado as PedidoUnificadoTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  producto as ProductoTable,
} from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, and, sql } from 'drizzle-orm'

const metricasRoute = new Hono().use('*', authMiddleware)

metricasRoute.get('/', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id

  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1 // 1-12

  // 1 & 2. Ingresos Totales del Mes Actual e Histórico
  const ingresosRes = await db
    .select({
      totalMensual: sql`SUM(CASE WHEN MONTH(${PedidoUnificadoTable.createdAt}) = ${month} AND YEAR(${PedidoUnificadoTable.createdAt}) = ${year} THEN ${PedidoUnificadoTable.total} ELSE 0 END)`,
      totalHistorico: sql`SUM(${PedidoUnificadoTable.total})`,
    })
    .from(PedidoUnificadoTable)
    .where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId),
      eq(PedidoUnificadoTable.pagado, true),
      // Nos aseguramos de contar solo cancelados/archivados/etc si fueron pagados, pero mejor solo excluir cancelados que no se cobraron. eq(pagado, true) asume ingresos reales.
    ))
  
  const totalMensual = parseFloat(ingresosRes[0]?.totalMensual as string || '0')
  const totalHistorico = parseFloat(ingresosRes[0]?.totalHistorico as string || '0')

  // 3 & 4. Cantidad de Pedidos del Mes Actual e Históricos
  const pedidosRes = await db
    .select({
      pedidosMensuales: sql`SUM(CASE WHEN MONTH(${PedidoUnificadoTable.createdAt}) = ${month} AND YEAR(${PedidoUnificadoTable.createdAt}) = ${year} THEN 1 ELSE 0 END)`,
      pedidosMensualesPagados: sql`SUM(CASE WHEN MONTH(${PedidoUnificadoTable.createdAt}) = ${month} AND YEAR(${PedidoUnificadoTable.createdAt}) = ${year} AND ${PedidoUnificadoTable.pagado} = true THEN 1 ELSE 0 END)`,
      pedidosHistoricos: sql`COUNT(${PedidoUnificadoTable.id})`,
    })
    .from(PedidoUnificadoTable)
    .where(eq(PedidoUnificadoTable.restauranteId, restauranteId))

  const pedidosMensuales = parseInt(pedidosRes[0]?.pedidosMensuales as string || '0', 10)
  const pedidosMensualesPagados = parseInt(pedidosRes[0]?.pedidosMensualesPagados as string || '0', 10)
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
      sql`MONTH(${PedidoUnificadoTable.createdAt}) = ${month}`,
      sql`YEAR(${PedidoUnificadoTable.createdAt}) = ${year}`
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
      sql`MONTH(${PedidoUnificadoTable.createdAt}) = ${month}`,
      sql`YEAR(${PedidoUnificadoTable.createdAt}) = ${year}`
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

  return c.json({
    success: true,
    data: {
      ingresos: {
        mensual: totalMensual,
        historico: totalHistorico
      },
      pedidos: {
        mensuales: pedidosMensuales,
        mensualesPagados: pedidosMensualesPagados,
        historicos: pedidosHistoricos
      },
      desgloseMetodoPago: desglosePagoFormat,
      topProductos
    }
  }, 200)
})

export { metricasRoute }
