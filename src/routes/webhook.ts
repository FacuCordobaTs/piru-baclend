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
    let poolRestauranteId: number | null = null;
    let poolTipoPedido: 'delivery' | 'takeaway' | null = null;

    if (collectionAccount) {
      const colNorm = String(collectionAccount).trim();
      const colPadded = colNorm.padStart(22, '0');

      let poolRecords = await db.select()
        .from(AccountPoolTable)
        .where(eq(AccountPoolTable.accountNumber, colNorm))
        .limit(1);

      // Fallback: Cucuru puede enviar collection_account con/sin ceros a la izquierda
      if (poolRecords.length === 0 && colNorm !== colPadded) {
        poolRecords = await db.select()
          .from(AccountPoolTable)
          .where(eq(AccountPoolTable.accountNumber, colPadded))
          .limit(1);
      }
      // Fallback: buscar por coincidencia normalizada (por si Cucuru envía formato distinto)
      if (poolRecords.length === 0) {
        const allPool = await db.select()
          .from(AccountPoolTable)
          .where(eq(AccountPoolTable.restauranteId, restauranteId));
        const norm = (s: string) => String(s || '').trim().padStart(22, '0');
        const match = allPool.find(r => r.accountNumber && norm(r.accountNumber) === colPadded);
        if (match) poolRecords = [match];
      }

      if (poolRecords.length > 0 && poolRecords[0].pedidoIdAsignado) {
        assignedPedidoId = poolRecords[0].pedidoIdAsignado;
        poolRecordId = poolRecords[0].id;
        poolRestauranteId = poolRecords[0].restauranteId;
        poolTipoPedido = poolRecords[0].tipoPedido as 'delivery' | 'takeaway' | null;
        console.log(`🔍 Encontrado Alias Dinámico: CVU ${collectionAccount} apunta al Pedido #${assignedPedidoId} (${poolTipoPedido || 'legacy'})`);
      } else if (colNorm) {
        console.log(`🔍 [Cucuru] Pool lookup: collection_account="${colNorm}" no encontrado en account_pool`);
      }
    }

    // Si el restaurante usa alias dinámicos (cucuruConfigurado) y el pago NO
    // vino por un alias del pool, rechazar el matcheo por monto para evitar
    // que pagos al alias principal crucen pedidos.
    const resConf = await db.select({ cucuruConfigurado: RestauranteTable.cucuruConfigurado })
      .from(RestauranteTable).where(eq(RestauranteTable.id, restauranteId)).limit(1);
    const usaDinamicos = resConf.length > 0 && resConf[0].cucuruConfigurado;

    if (usaDinamicos && !assignedPedidoId) {
      console.log(`⚠️ [Cucuru] Pago de $${amount} al alias principal del restaurante ${restauranteId} ignorado (usa alias dinámicos). collection_account=${collectionAccount || 'N/A'}, collectionId=${collectionId}`);
      return c.json({ status: 'ignored_no_pool_match' }, 200);
    }

    // Los alias dinámicos NO se reciclan. Cada pedido mantiene su alias
    // permanentemente para evitar que webhooks duplicados/retrasados de Cucuru
    // crucen pagos entre pedidos.
    // FIX: Delivery y Takeaway tienen IDs independientes (ambos pueden tener id=49).
    // tipoPedido indica qué tabla consultar primero. Sin eso matcheábamos delivery en vez de takeaway.

    const effectiveRestauranteId = poolRestauranteId ?? restauranteId;
    const deliveryWhere = assignedPedidoId
      ? and(
          eq(PedidoDeliveryTable.id, assignedPedidoId),
          eq(PedidoDeliveryTable.restauranteId, effectiveRestauranteId)
        )
      : and(
          eq(PedidoDeliveryTable.restauranteId, restauranteId),
          eq(PedidoDeliveryTable.total, String(amount)),
          eq(PedidoDeliveryTable.pagado, false),
          ne(PedidoDeliveryTable.estado, 'delivered'),
          ne(PedidoDeliveryTable.estado, 'archived'),
          ne(PedidoDeliveryTable.estado, 'cancelled')
        );

    const takeawayWhere = assignedPedidoId
      ? and(
          eq(PedidoTakeawayTable.id, assignedPedidoId),
          eq(PedidoTakeawayTable.restauranteId, effectiveRestauranteId)
        )
      : and(
          eq(PedidoTakeawayTable.restauranteId, restauranteId),
          eq(PedidoTakeawayTable.total, String(amount)),
          eq(PedidoTakeawayTable.pagado, false),
          ne(PedidoTakeawayTable.estado, 'delivered'),
          ne(PedidoTakeawayTable.estado, 'archived'),
          ne(PedidoTakeawayTable.estado, 'cancelled')
        );

    const searchTakeawayFirst = poolTipoPedido === 'takeaway';
    let pedidosDelivery: typeof PedidoDeliveryTable.$inferSelect[] = [];
    let pedidosTakeaway: typeof PedidoTakeawayTable.$inferSelect[] = [];

    if (searchTakeawayFirst) {
      pedidosTakeaway = await db.select().from(PedidoTakeawayTable).where(takeawayWhere).limit(1);
      if (pedidosTakeaway.length === 0) {
        pedidosDelivery = await db.select().from(PedidoDeliveryTable).where(deliveryWhere).limit(1);
      }
    } else {
      pedidosDelivery = await db.select().from(PedidoDeliveryTable).where(deliveryWhere).limit(1);
      if (pedidosDelivery.length === 0) {
        pedidosTakeaway = await db.select().from(PedidoTakeawayTable).where(takeawayWhere).limit(1);
      }
    }

    if (pedidosDelivery.length > 0) {
      const pedido = pedidosDelivery[0];
      const targetRestauranteId = pedido.restauranteId ?? restauranteId;

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
      wsManager.notifyAdmins(targetRestauranteId, {
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

      console.log(`🚀 [Cucuru] Pago acreditado para Delivery #${pedido.id}`);
      wsManager.broadcastAdminUpdate(targetRestauranteId, 'delivery');
      wsManager.notifyPublicClientPayment('delivery', pedido.id);

      // WhatsApp Notification
      try {
        const restaurante = await db.select({
          whatsappEnabled: RestauranteTable.whatsappEnabled,
          whatsappNumber: RestauranteTable.whatsappNumber,
          deliveryFee: RestauranteTable.deliveryFee
        }).from(RestauranteTable).where(eq(RestauranteTable.id, targetRestauranteId)).limit(1);

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

    if (pedidosTakeaway.length > 0) {
      const pedido = pedidosTakeaway[0];
      const targetRestauranteId = pedido.restauranteId ?? restauranteId;

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
      wsManager.notifyAdmins(targetRestauranteId, {
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

      console.log(`🏃‍♂️ [Cucuru] Pago acreditado para TakeAway #${pedido.id}`);
      wsManager.broadcastAdminUpdate(targetRestauranteId, 'takeaway');
      wsManager.notifyPublicClientPayment('takeaway', pedido.id);

      // WhatsApp Notification
      try {
        const restaurante = await db.select({
          whatsappEnabled: RestauranteTable.whatsappEnabled,
          whatsappNumber: RestauranteTable.whatsappNumber
        }).from(RestauranteTable).where(eq(RestauranteTable.id, targetRestauranteId)).limit(1);

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

// ======================== RAPIBOY WEBHOOK ========================
webhookRoute.post('/rapiboy', async (c) => {
  try {
    const body = await c.req.json();
    console.log(`🔔 [webhook] Recibido de Rapiboy (ReferenciaExterna: ${body.ReferenciaExterna})`);

    // Procesar en background para retorno rápido 200 (evitar reintentos bloqueantes de Rapiboy)
    const processRapiboyWebhook = async () => {
      try {
        const db = drizzle(pool);
        const { ReferenciaExterna, TrackingUrl, Estado } = body;

        if (!ReferenciaExterna) return;

        const pedidoId = parseInt(String(ReferenciaExterna), 10);
        if (isNaN(pedidoId)) return;

        // Buscar el pedido
        const pedidos = await db.select().from(PedidoDeliveryTable).where(eq(PedidoDeliveryTable.id, pedidoId)).limit(1);
        if (pedidos.length === 0) return;

        const pedido = pedidos[0];
        const updateData: any = {};
        let changedSomething = false;

        // Determinar si debemos actualizar a "En Camino" (dispatched) o "Entregado" (delivered)
        // Se buscan palabras clave o convenciones ID 3/4 comunes.
        const strEstado = String(Estado).toLowerCase();
        let nuevoEstadoInterno = pedido.estado;

        if (strEstado.includes('en camino') || strEstado === '3' || strEstado.includes('retirado')) {
           nuevoEstadoInterno = 'dispatched';
        } else if (strEstado.includes('entregado') || strEstado === '4' || strEstado.includes('finalizado')) {
           nuevoEstadoInterno = 'delivered';
        }

        if (TrackingUrl && TrackingUrl !== pedido.rapiboyTrackingUrl) {
            updateData.rapiboyTrackingUrl = TrackingUrl;
            changedSomething = true;
        }

        if (nuevoEstadoInterno !== pedido.estado) {
            updateData.estado = nuevoEstadoInterno;
            changedSomething = true;
        }

        if (changedSomething && pedido.restauranteId !== null) {
            await db.update(PedidoDeliveryTable).set(updateData).where(eq(PedidoDeliveryTable.id, pedidoId));

            // Actualizar a los administradores
            wsManager.broadcastAdminUpdate(pedido.restauranteId, 'delivery');
            
            // Actualizar a los clientes públicos/tracking
            wsManager.notifyPublicClientEstado('delivery', pedidoId, updateData.estado || pedido.estado, updateData.rapiboyTrackingUrl || pedido.rapiboyTrackingUrl || undefined);
            
            console.log(`✅ [Rapiboy] Pedido ${pedidoId} actualizado. Estado=${updateData.estado || pedido.estado}`);
        }
      } catch (err) {
        console.error('❌ Error interno en Rapiboy webhook:', err);
      }
    };

    processRapiboyWebhook(); // fire and forget
    
    return c.json({ status: 'ok' }, 200);
  } catch (error) {
    console.error('❌ Error parseando webhook Rapiboy:', error);
    // Devolver 200 en vez de fallar para evitar encolamientos y reintentos innecesarios en la pasarela.
    return c.json({ status: 'ignored_error' }, 200);
  }
});

export { webhookRoute }
