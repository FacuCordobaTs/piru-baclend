// migration.ts - Endpoint temporal para migrar datos legacy a pedidoUnificado
import { Hono } from "hono";
import { pool } from "../db";
import {
  pedidoDelivery as PedidoDeliveryTable,
  itemPedidoDelivery as ItemPedidoDeliveryTable,
  pedidoTakeaway as PedidoTakeawayTable,
  itemPedidoTakeaway as ItemPedidoTakeawayTable,
  pedidoUnificado as PedidoUnificadoTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  pago as PagoTable,
} from "../db/schema";
import { drizzle } from "drizzle-orm/mysql2";
import { eq, asc } from "drizzle-orm";

// Mapeo de estados legacy -> pedidoUnificado
const mapEstadoDeliveryTakeaway = (
  estado: string | null
): "pending" | "received" | "dispatched" | "delivered" | "cancelled" | "archived" => {
  switch (estado) {
    case "preparing":
    case "ready":
      return "received";
    case "dispatched":
      return "dispatched";
    case "delivered":
      return "delivered";
    case "cancelled":
      return "cancelled";
    case "archived":
      return "archived";
    default:
      return "pending";
  }
};

const migrationRoute = new Hono().post("/", async (c) => {
  const db = drizzle(pool);

  const summary = {
    delivery: { pedidos: 0, items: 0, errores: 0 },
    takeaway: { pedidos: 0, items: 0, errores: 0 },
    pagosActualizados: 0,
  };

  try {
    // --- 1. Migrar PedidoDelivery + items ---
    const pedidosDelivery = await db.select().from(PedidoDeliveryTable);

    for (const pd of pedidosDelivery) {
      try {
        const resultDelivery = await db.insert(PedidoUnificadoTable).values({
          restauranteId: pd.restauranteId!,
          clienteId: pd.clienteId ?? null,
          tipo: "delivery",
          estado: mapEstadoDeliveryTakeaway(pd.estado),
          nombreCliente: pd.nombreCliente ?? null,
          telefono: pd.telefono ?? null,
          notas: pd.notas ?? null,
          total: pd.total ?? "0.00",
          pagado: pd.pagado ?? false,
          metodoPago: pd.metodoPago ?? null,
          direccion: pd.direccion ?? null,
          latitud: pd.latitud ?? null,
          longitud: pd.longitud ?? null,
          rapiboyTrackingUrl: pd.rapiboyTrackingUrl ?? null,
          rapiboyTripId: pd.rapiboyTripId ?? null,
          codigoDescuentoId: pd.codigoDescuentoId ?? null,
          montoDescuento: pd.montoDescuento ?? null,
          impreso: pd.impreso ?? false,
          deliveredAt: pd.deliveredAt ?? null,
        });

        const nuevoPedidoId = Number(resultDelivery[0].insertId);
        summary.delivery.pedidos++;

        const items = await db
          .select()
          .from(ItemPedidoDeliveryTable)
          .where(eq(ItemPedidoDeliveryTable.pedidoDeliveryId, pd.id));

        for (const item of items) {
          await db.insert(ItemPedidoUnificadoTable).values({
            pedidoId: nuevoPedidoId,
            productoId: item.productoId,
            cantidad: item.cantidad ?? 1,
            precioUnitario: item.precioUnitario,
            esCanjePuntos: item.esCanjePuntos ?? false,
          });
          summary.delivery.items++;
        }
      } catch (err) {
        console.error(`Error migrando pedido delivery ${pd.id}:`, err);
        summary.delivery.errores++;
      }
    }

    // --- 2. Migrar PedidoTakeaway + items ---
    const pedidosTakeaway = await db.select().from(PedidoTakeawayTable);

    for (const pt of pedidosTakeaway) {
      try {
        const resultTakeaway = await db.insert(PedidoUnificadoTable).values({
          restauranteId: pt.restauranteId!,
          clienteId: pt.clienteId ?? null,
          tipo: "takeaway",
          estado: mapEstadoDeliveryTakeaway(pt.estado),
          nombreCliente: pt.nombreCliente ?? null,
          telefono: pt.telefono ?? null,
          notas: pt.notas ?? null,
          total: pt.total ?? "0.00",
          pagado: pt.pagado ?? false,
          metodoPago: pt.metodoPago ?? null,
          codigoDescuentoId: pt.codigoDescuentoId ?? null,
          montoDescuento: pt.montoDescuento ?? null,
          impreso: pt.impreso ?? false,
          deliveredAt: pt.deliveredAt ?? null,
        });

        const nuevoPedidoId = Number(resultTakeaway[0].insertId);
        summary.takeaway.pedidos++;

        const items = await db
          .select()
          .from(ItemPedidoTakeawayTable)
          .where(eq(ItemPedidoTakeawayTable.pedidoTakeawayId, pt.id));

        for (const item of items) {
          await db.insert(ItemPedidoUnificadoTable).values({
            pedidoId: nuevoPedidoId,
            productoId: item.productoId,
            cantidad: item.cantidad ?? 1,
            precioUnitario: item.precioUnitario,
            esCanjePuntos: item.esCanjePuntos ?? false,
          });
          summary.takeaway.items++;
        }
      } catch (err) {
        console.error(`Error migrando pedido takeaway ${pt.id}:`, err);
        summary.takeaway.errores++;
      }
    }

    // --- 3. (Opcional) Actualizar tabla pago con pedidoUnificadoId ---
    // Necesitamos un mapa viejoId -> nuevoId para delivery y takeaway
    // Como ya insertamos, reconstruimos el orden por createdAt para hacer el match
    const todosDelivery = await db
      .select({ id: PedidoDeliveryTable.id, createdAt: PedidoDeliveryTable.createdAt })
      .from(PedidoDeliveryTable)
      .orderBy(asc(PedidoDeliveryTable.createdAt));
    const todosTakeaway = await db
      .select({ id: PedidoTakeawayTable.id, createdAt: PedidoTakeawayTable.createdAt })
      .from(PedidoTakeawayTable)
      .orderBy(asc(PedidoTakeawayTable.createdAt));

    const unificadosDelivery = await db
      .select({ id: PedidoUnificadoTable.id, createdAt: PedidoUnificadoTable.createdAt })
      .from(PedidoUnificadoTable)
      .where(eq(PedidoUnificadoTable.tipo, "delivery"))
      .orderBy(asc(PedidoUnificadoTable.createdAt));
    const unificadosTakeaway = await db
      .select({ id: PedidoUnificadoTable.id, createdAt: PedidoUnificadoTable.createdAt })
      .from(PedidoUnificadoTable)
      .where(eq(PedidoUnificadoTable.tipo, "takeaway"))
      .orderBy(asc(PedidoUnificadoTable.createdAt));

    const mapDeliveryId = new Map<number, number>();
    const mapTakeawayId = new Map<number, number>();
    for (let i = 0; i < todosDelivery.length && i < unificadosDelivery.length; i++) {
      mapDeliveryId.set(todosDelivery[i].id, unificadosDelivery[i].id);
    }
    for (let i = 0; i < todosTakeaway.length && i < unificadosTakeaway.length; i++) {
      mapTakeawayId.set(todosTakeaway[i].id, unificadosTakeaway[i].id);
    }

    // Obtener todos los pagos y actualizar los que tienen pedidoDeliveryId o pedidoTakeawayId
    const todosPagos = await db.select().from(PagoTable);
    for (const p of todosPagos) {
      let nuevoId: number | null = null;
      if (p.pedidoDeliveryId != null) {
        nuevoId = mapDeliveryId.get(p.pedidoDeliveryId) ?? null;
      } else if (p.pedidoTakeawayId != null) {
        nuevoId = mapTakeawayId.get(p.pedidoTakeawayId) ?? null;
      }
      if (nuevoId != null) {
        await db
          .update(PagoTable)
          .set({ pedidoUnificadoId: nuevoId })
          .where(eq(PagoTable.id, p.id));
        summary.pagosActualizados++;
      }
    }

    return c.json({
      success: true,
      message: "Migración completada",
      summary: {
        delivery: {
          pedidosMigrados: summary.delivery.pedidos,
          itemsMigrados: summary.delivery.items,
          errores: summary.delivery.errores,
        },
        takeaway: {
          pedidosMigrados: summary.takeaway.pedidos,
          itemsMigrados: summary.takeaway.items,
          errores: summary.takeaway.errores,
        },
        pagosActualizados: summary.pagosActualizados,
      },
    });
  } catch (error) {
    console.error("Error en migración:", error);
    return c.json(
      {
        success: false,
        message: "Error durante la migración",
        error: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

export { migrationRoute };
