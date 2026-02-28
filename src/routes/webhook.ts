import { Hono } from 'hono'
import { pool } from '../db'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, ne } from 'drizzle-orm'
import {
  pedido as PedidoTable,
  pedidoDelivery as PedidoDeliveryTable,
  pedidoTakeaway as PedidoTakeawayTable,
  pago as PagoTable,
  notificacion as NotificacionTable
} from '../db/schema'
import { wsManager } from '../websocket/manager'

const webhookRoute = new Hono()

webhookRoute.get('/', async (c) => {
  return c.json({ message: 'Webhook get received' }, 200)
})

webhookRoute.post('/', async (c) => {
  return c.json({ message: 'Webhook received' }, 200)
})

webhookRoute.post('/cucuru/collection_received', async (c: any) => {
  try {
    const body = await c.req.json();

    console.log('🔔 Webhook recibido de Cucuru:', JSON.stringify(body, null, 2));

    const amount = body.amount;
    const customerIdStr = body.customer_id;
    const collectionId = body.collection_id;

    if (amount === 0) {
      console.log('✅ Validación de Webhook exitosa (Importe 0)');
      return c.json({ status: 'ok' }, 200);
    }

    if (!customerIdStr || amount === undefined) {
      console.warn('⚠️ Webhook inválido: Falta customer_id o amount');
      return c.json({ error: 'Missing data' }, 400);
    }

    const restauranteId = Number(customerIdStr);
    const db = drizzle(pool);

    // 1. Buscar en Delivery
    const pedidosDelivery = await db.select()
      .from(PedidoDeliveryTable)
      .where(
        and(
          eq(PedidoDeliveryTable.restauranteId, restauranteId),
          eq(PedidoDeliveryTable.total, String(amount)),
          eq(PedidoDeliveryTable.pagado, false),
          ne(PedidoDeliveryTable.estado, 'delivered'),
          ne(PedidoDeliveryTable.estado, 'archived'),
          ne(PedidoDeliveryTable.estado, 'cancelled')
        )
      )
      .limit(1);

    if (pedidosDelivery.length > 0) {
      const pedido = pedidosDelivery[0];
      await db.update(PedidoDeliveryTable).set({
        pagado: true,
        metodoPago: 'transferencia'
      }).where(eq(PedidoDeliveryTable.id, pedido.id));

      await db.insert(PagoTable).values({
        pedidoDeliveryId: pedido.id,
        metodo: 'transferencia',
        estado: 'paid',
        monto: String(amount),
        mpPaymentId: collectionId
      });

      const notifId = `notif-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      await db.insert(NotificacionTable).values({
        id: notifId,
        restauranteId: restauranteId,
        tipo: 'PAGO_RECIBIDO',
        mesaId: null as any,
        mesaNombre: 'Delivery',
        pedidoId: pedido.id,
        mensaje: `Cobro CUCURU de $${amount} (Delivery)`,
        detalles: `Transacción: ${collectionId}`
      });

      console.log(`🚀 [Cucuru] Pago acreditado para Delivery #${pedido.id}`);
      wsManager.broadcastAdminUpdate(restauranteId, 'delivery');
      wsManager.notifyPublicClientPayment('delivery', pedido.id);
      return c.json({ status: 'received' }, 200);
    }

    // 2. Buscar en Takeaway
    const pedidosTakeaway = await db.select()
      .from(PedidoTakeawayTable)
      .where(
        and(
          eq(PedidoTakeawayTable.restauranteId, restauranteId),
          eq(PedidoTakeawayTable.total, String(amount)),
          eq(PedidoTakeawayTable.pagado, false),
          ne(PedidoTakeawayTable.estado, 'delivered'),
          ne(PedidoTakeawayTable.estado, 'archived'),
          ne(PedidoTakeawayTable.estado, 'cancelled')
        )
      )
      .limit(1);

    if (pedidosTakeaway.length > 0) {
      const pedido = pedidosTakeaway[0];
      await db.update(PedidoTakeawayTable).set({
        pagado: true,
        metodoPago: 'transferencia'
      }).where(eq(PedidoTakeawayTable.id, pedido.id));

      await db.insert(PagoTable).values({
        pedidoTakeawayId: pedido.id,
        metodo: 'transferencia',
        estado: 'paid',
        monto: String(amount),
        mpPaymentId: collectionId
      });

      const notifId = `notif-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      await db.insert(NotificacionTable).values({
        id: notifId,
        restauranteId: restauranteId,
        tipo: 'PAGO_RECIBIDO',
        mesaId: null as any,
        mesaNombre: 'Take Away',
        pedidoId: pedido.id,
        mensaje: `Cobro CUCURU de $${amount} (Take Away)`,
        detalles: `Transacción: ${collectionId}`
      });

      console.log(`🏃‍♂️ [Cucuru] Pago acreditado para TakeAway #${pedido.id}`);
      wsManager.broadcastAdminUpdate(restauranteId, 'takeaway');
      wsManager.notifyPublicClientPayment('takeaway', pedido.id);
      return c.json({ status: 'received' }, 200);
    }

    // 3. Buscar en tabla pedido normal (Restaurante/Mesas)
    const pedidos = await db.select()
      .from(PedidoTable)
      .where(
        and(
          eq(PedidoTable.restauranteId, restauranteId),
          eq(PedidoTable.total, String(amount)),
          eq(PedidoTable.pagado, false),
          ne(PedidoTable.estado, 'closed'),
          ne(PedidoTable.estado, 'archived')
        )
      )
      .limit(1);

    if (pedidos.length === 0) {
      console.log('⚠️ Pago Huérfano / Posible Propina (No Match) - Buscado en Delivery, Takeaway y Mesas');
      return c.json({ status: 'received' }, 200);
    }

    const pedido = pedidos[0];
    await db.update(PedidoTable)
      .set({
        pagado: true,
        estado: 'closed',
        metodoPago: 'transferencia',
        closedAt: new Date()
      })
      .where(eq(PedidoTable.id, pedido.id));

    await db.insert(PagoTable)
      .values({
        pedidoId: pedido.id,
        metodo: 'transferencia',
        estado: 'paid',
        monto: String(amount),
        mpPaymentId: collectionId
      });

    const notifId = `notif-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    await db.insert(NotificacionTable)
      .values({
        id: notifId,
        restauranteId: restauranteId,
        tipo: 'PAGO_RECIBIDO',
        mesaId: pedido.mesaId,
        pedidoId: pedido.id,
        mensaje: `Pago de $${amount} recibido vía Cucuru`,
        detalles: `Transacción: ${collectionId}`
      });

    console.log(`🍽️ [Cucuru] Pago acreditado para Mesa #${pedido.mesaId}`);
    if (pedido.mesaId) wsManager.broadcastEstadoToAdmins(pedido.mesaId);
    return c.json({ status: 'received' }, 200);

  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    return c.json({ error: 'Internal Error' }, 500);
  }
});

export { webhookRoute }
