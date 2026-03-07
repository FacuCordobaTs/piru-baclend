import { Hono } from 'hono'
import { pool } from '../db'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, ne } from 'drizzle-orm'
import {
  pedido as PedidoTable,
  pedidoDelivery as PedidoDeliveryTable,
  pedidoTakeaway as PedidoTakeawayTable,
  pago as PagoTable,
  notificacion as NotificacionTable,
  accountPool as AccountPoolTable,
  itemPedidoDelivery as ItemPedidoDeliveryTable,
  itemPedidoTakeaway as ItemPedidoTakeawayTable,
  producto as ProductoTable,
  restaurante as RestauranteTable
} from '../db/schema'
import { wsManager } from '../websocket/manager'
import { sendOrderWhatsApp } from '../services/whatsapp'

const webhookRoute = new Hono()

webhookRoute.get('/', async (c) => {
  return c.json({ message: 'Webhook get received' }, 200)
})

webhookRoute.post('/', async (c) => {
  return c.json({ message: 'Webhook received' }, 200)
})

const cucuruWebhookHandler = async (c: any) => {
  try {
    let body;
    try {
      body = await c.req.json();
    } catch (err) {
      console.log(`✅ [${c.req.method} ${c.req.path}] Validación de Webhook exitosa (Ping sin JSON)`);
      return c.json({ status: 'ok' }, 200);
    }

    console.log(`🔔 [${c.req.method} ${c.req.path}] Webhook recibido de Cucuru:`, JSON.stringify(body, null, 2));

    const amount = body.amount;
    const customerIdStr = body.customer_id;
    const collectionId = body.collection_id;
    const collectionAccount = body.collection_account;

    if (amount === 0) {
      console.log('✅ Validación de Webhook exitosa (Importe 0)');
      return c.json({ status: 'ok' }, 200);
    }

    if (!customerIdStr || amount === undefined) {
      console.warn('⚠️ Webhook inválido o ping de validación: Falta customer_id o amount. Respondiendo 200 OK.');
      return c.json({ status: 'ignored' }, 200);
    }

    const restauranteId = Number(customerIdStr);
    const db = drizzle(pool);

    let assignedPedidoId: number | null = null;
    let poolRecordId: number | null = null;

    if (collectionAccount) {
      const poolRecords = await db.select()
        .from(AccountPoolTable)
        .where(eq(AccountPoolTable.accountNumber, collectionAccount))
        .limit(1);

      if (poolRecords.length > 0 && poolRecords[0].pedidoIdAsignado) {
        assignedPedidoId = poolRecords[0].pedidoIdAsignado;
        poolRecordId = poolRecords[0].id;
        console.log(`🔍 Encontrado Alias Dinámico: CVU ${collectionAccount} apunta al Pedido #${assignedPedidoId}`);
      }
    }

    // Helper para liberar el alias
    const freePoolRecord = async () => {
      if (poolRecordId) {
        await db.update(AccountPoolTable)
          .set({ estado: 'disponible', pedidoIdAsignado: null, updatedAt: new Date() })
          .where(eq(AccountPoolTable.id, poolRecordId));
        console.log(`♻️ Alias Reciclado: CVU ${collectionAccount} ha sido liberado para futuros pedidos.`);
      }
    };

    // 1. Buscar en Delivery
    const pedidosDelivery = await db.select()
      .from(PedidoDeliveryTable)
      .where(
        assignedPedidoId
          ? eq(PedidoDeliveryTable.id, assignedPedidoId)
          : and(
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

      if (Number(amount) < Number(pedido.total)) {
        console.warn(`⚠️ [Cucuru] Pago insuficiente para Delivery #${pedido.id}. Pagado: $${amount}, Esperado: $${pedido.total}`);
        return c.json({ status: 'ignored_insufficient' }, 200);
      }

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
      wsManager.notifyAdmins(restauranteId, {
        id: notifId,
        tipo: 'NUEVO_PEDIDO',
        mesaId: 0,
        mesaNombre: 'Delivery',
        mensaje: `Nuevo pedido de Delivery (Pagado)`,
        detalles: `${pedido.nombreCliente || 'Cliente'} - $${pedido.total}`,
        timestamp: new Date().toISOString(),
        leida: false,
        pedidoId: pedido.id
      });

      await freePoolRecord();

      console.log(`🚀 [Cucuru] Pago acreditado para Delivery #${pedido.id}`);
      wsManager.broadcastAdminUpdate(restauranteId, 'delivery');
      wsManager.notifyPublicClientPayment('delivery', pedido.id);

      // WhatsApp Notification
      try {
        const restaurante = await db.select({
          whatsappEnabled: RestauranteTable.whatsappEnabled,
          whatsappNumber: RestauranteTable.whatsappNumber,
          deliveryFee: RestauranteTable.deliveryFee
        }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1);

        if (restaurante[0]?.whatsappEnabled && restaurante[0]?.whatsappNumber) {
          const itemsRaw = await db.select({
            cantidad: ItemPedidoDeliveryTable.cantidad,
            nombreProducto: ProductoTable.nombre,
            esCanjePuntos: ItemPedidoDeliveryTable.esCanjePuntos
          })
            .from(ItemPedidoDeliveryTable)
            .leftJoin(ProductoTable, eq(ItemPedidoDeliveryTable.productoId, ProductoTable.id))
            .where(eq(ItemPedidoDeliveryTable.pedidoDeliveryId, pedido.id));

          const orderItemsForWa = itemsRaw.map(item => ({
            name: item.esCanjePuntos ? `${item.nombreProducto} (Canje Puntos)` : item.nombreProducto!,
            quantity: item.cantidad!
          }));

          if (restaurante[0].deliveryFee) {
            orderItemsForWa.push({ name: 'Delivery', quantity: 1 });
          }

          sendOrderWhatsApp(c, {
            phone: restaurante[0].whatsappNumber,
            customerName: pedido.nombreCliente || 'Cliente no especificado',
            address: pedido.direccion || 'Sin dirección',
            total: `${pedido.total} (transferencia)`,
            items: orderItemsForWa,
            orderId: pedido.id.toString()
          }).catch(console.error);
        }
      } catch (error) {
        console.error("❌ Error enviando WhatsApp post-pago:", error);
      }

      return c.json({ status: 'received' }, 200);
    }

    // 2. Buscar en Takeaway
    const pedidosTakeaway = await db.select()
      .from(PedidoTakeawayTable)
      .where(
        assignedPedidoId
          ? eq(PedidoTakeawayTable.id, assignedPedidoId)
          : and(
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

      if (Number(amount) < Number(pedido.total)) {
        console.warn(`⚠️ [Cucuru] Pago insuficiente para TakeAway #${pedido.id}. Pagado: $${amount}, Esperado: $${pedido.total}`);
        return c.json({ status: 'ignored_insufficient' }, 200);
      }

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
      wsManager.notifyAdmins(restauranteId, {
        id: notifId,
        tipo: 'NUEVO_PEDIDO',
        mesaId: 0,
        mesaNombre: 'Take Away',
        mensaje: `Nuevo pedido de Take Away (Pagado)`,
        detalles: `${pedido.nombreCliente || 'Cliente'} - $${pedido.total}`,
        timestamp: new Date().toISOString(),
        leida: false,
        pedidoId: pedido.id
      });

      await freePoolRecord();

      console.log(`🏃‍♂️ [Cucuru] Pago acreditado para TakeAway #${pedido.id}`);
      wsManager.broadcastAdminUpdate(restauranteId, 'takeaway');
      wsManager.notifyPublicClientPayment('takeaway', pedido.id);

      // WhatsApp Notification
      try {
        const restaurante = await db.select({
          whatsappEnabled: RestauranteTable.whatsappEnabled,
          whatsappNumber: RestauranteTable.whatsappNumber
        }).from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1);

        if (restaurante[0]?.whatsappEnabled && restaurante[0]?.whatsappNumber) {
          const itemsRaw = await db.select({
            cantidad: ItemPedidoTakeawayTable.cantidad,
            nombreProducto: ProductoTable.nombre,
            esCanjePuntos: ItemPedidoTakeawayTable.esCanjePuntos
          })
            .from(ItemPedidoTakeawayTable)
            .leftJoin(ProductoTable, eq(ItemPedidoTakeawayTable.productoId, ProductoTable.id))
            .where(eq(ItemPedidoTakeawayTable.pedidoTakeawayId, pedido.id));

          const orderItemsForWa = itemsRaw.map(item => ({
            name: item.esCanjePuntos ? `${item.nombreProducto} (Canje Puntos)` : item.nombreProducto!,
            quantity: item.cantidad!
          }));

          sendOrderWhatsApp(c, {
            phone: restaurante[0].whatsappNumber,
            customerName: pedido.nombreCliente || 'Cliente no especificado',
            address: 'Retira en local (Take Away)',
            total: `${pedido.total} (transferencia)`,
            items: orderItemsForWa,
            orderId: pedido.id.toString()
          }).catch(console.error);
        }
      } catch (error) {
        console.error("❌ Error enviando WhatsApp post-pago:", error);
      }

      return c.json({ status: 'received' }, 200);
    }

    // 3. Buscar en tabla pedido normal (Restaurante/Mesas)
    const pedidos = await db.select()
      .from(PedidoTable)
      .where(
        assignedPedidoId
          ? eq(PedidoTable.id, assignedPedidoId)
          : and(
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
      // Aun si no lo encontramos para acoplar a un pedido (tal vez alguien transfirió demás),
      // reciclamos el CVU por seguridad para que no quede incrustado
      await freePoolRecord();
      return c.json({ status: 'received' }, 200);
    }

    const pedido = pedidos[0];

    if (Number(amount) < Number(pedido.total)) {
      console.warn(`⚠️ [Cucuru] Pago insuficiente para Mesa #${pedido.id}. Pagado: $${amount}, Esperado: $${pedido.total}`);
      return c.json({ status: 'ignored_insufficient' }, 200);
    }

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

    await freePoolRecord();

    console.log(`🍽️ [Cucuru] Pago acreditado para Mesa #${pedido.mesaId}`);
    if (pedido.mesaId) wsManager.broadcastEstadoToAdmins(pedido.mesaId);
    return c.json({ status: 'received' }, 200);

  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    return c.json({ error: 'Internal Error' }, 500);
  }
};

// Rutas para abarcar todas las posibles URL's a las que puede estar pegando el PING de Cucuru:
webhookRoute.post('/cucuru/collection_received', cucuruWebhookHandler);
webhookRoute.get('/cucuru/collection_received', (c) => c.json({ status: 'ok' }, 200));

webhookRoute.post('/cucuru/collection_received/collection_received', cucuruWebhookHandler);
webhookRoute.get('/cucuru/collection_received/collection_received', (c) => c.json({ status: 'ok' }, 200));

webhookRoute.post('/cucuru', cucuruWebhookHandler);
webhookRoute.get('/cucuru', (c) => c.json({ status: 'ok' }, 200));

export { webhookRoute }
