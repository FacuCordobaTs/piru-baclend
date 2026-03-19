import { Hono } from 'hono'
import { pool } from '../db'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, ne, or } from 'drizzle-orm'
import {
  pedido as PedidoTable,
  pedidoUnificado as PedidoUnificadoTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  pago as PagoTable,
  notificacion as NotificacionTable,
  accountPool as AccountPoolTable,
  producto as ProductoTable,
  restaurante as RestauranteTable
} from '../db/schema'
import { wsManager } from '../websocket/manager'
import { sendOrderWhatsApp } from '../services/whatsapp'
import { consultarPagoTalo } from '../services/talo'

const webhookRoute = new Hono()

webhookRoute.get('/', async (c) => {
  return c.json({ message: 'Webhook get received' }, 200)
})

webhookRoute.post('/', async (c) => {
  return c.json({ message: 'Webhook received' }, 200)
})

const cucuruWebhookHandler = async (c: any) => {
  console.log(`🔴 [CUCURU] LLEGÓ WEBHOOK: ${c.req.method} ${c.req.path} @ ${new Date().toISOString()}`);
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

    // Cucuru puede enviar collection_account como account_number (22 dígitos) o como alias (ej: piru.alfajor.171)
    if (collectionAccount) {
      const poolRecords = await db.select()
        .from(AccountPoolTable)
        .where(or(
          eq(AccountPoolTable.accountNumber, collectionAccount),
          eq(AccountPoolTable.alias, collectionAccount)
        ))
        .limit(1);

      if (poolRecords.length > 0 && poolRecords[0].pedidoIdAsignado) {
        assignedPedidoId = poolRecords[0].pedidoIdAsignado;
        poolRecordId = poolRecords[0].id;
        poolRestauranteId = poolRecords[0].restauranteId;
        poolTipoPedido = poolRecords[0].tipoPedido as 'delivery' | 'takeaway' | null;
        console.log(`🔍 Encontrado Alias Dinámico: collection_account=${collectionAccount} -> Pedido #${assignedPedidoId} (${poolTipoPedido || 'legacy'})`);
      } else if (amount > 0) {
        console.log(`🔍 [Cucuru] collection_account=${collectionAccount} no matcheó en account_pool. Buscando por accountNumber y alias.`);
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
          eq(PedidoUnificadoTable.id, assignedPedidoId),
          eq(PedidoUnificadoTable.restauranteId, effectiveRestauranteId),
          eq(PedidoUnificadoTable.tipo, 'delivery')
        )
      : and(
          eq(PedidoUnificadoTable.restauranteId, restauranteId),
          eq(PedidoUnificadoTable.tipo, 'delivery'),
          eq(PedidoUnificadoTable.total, String(amount)),
          eq(PedidoUnificadoTable.pagado, false),
          ne(PedidoUnificadoTable.estado, 'delivered'),
          ne(PedidoUnificadoTable.estado, 'archived'),
          ne(PedidoUnificadoTable.estado, 'cancelled')
        );

    const takeawayWhere = assignedPedidoId
      ? and(
          eq(PedidoUnificadoTable.id, assignedPedidoId),
          eq(PedidoUnificadoTable.restauranteId, effectiveRestauranteId),
          eq(PedidoUnificadoTable.tipo, 'takeaway')
        )
      : and(
          eq(PedidoUnificadoTable.restauranteId, restauranteId),
          eq(PedidoUnificadoTable.tipo, 'takeaway'),
          eq(PedidoUnificadoTable.total, String(amount)),
          eq(PedidoUnificadoTable.pagado, false),
          ne(PedidoUnificadoTable.estado, 'delivered'),
          ne(PedidoUnificadoTable.estado, 'archived'),
          ne(PedidoUnificadoTable.estado, 'cancelled')
        );

    const searchTakeawayFirst = poolTipoPedido === 'takeaway';
    let pedidosEncontrados: typeof PedidoUnificadoTable.$inferSelect[] = [];
    let tipoEncontrado: 'delivery' | 'takeaway' | null = null;

    if (searchTakeawayFirst) {
      pedidosEncontrados = await db.select().from(PedidoUnificadoTable).where(takeawayWhere).limit(1);
      tipoEncontrado = pedidosEncontrados.length > 0 ? 'takeaway' : null;
      if (pedidosEncontrados.length === 0) {
        pedidosEncontrados = await db.select().from(PedidoUnificadoTable).where(deliveryWhere).limit(1);
        tipoEncontrado = pedidosEncontrados.length > 0 ? 'delivery' : null;
      }
    } else {
      pedidosEncontrados = await db.select().from(PedidoUnificadoTable).where(deliveryWhere).limit(1);
      tipoEncontrado = pedidosEncontrados.length > 0 ? 'delivery' : null;
      if (pedidosEncontrados.length === 0) {
        pedidosEncontrados = await db.select().from(PedidoUnificadoTable).where(takeawayWhere).limit(1);
        tipoEncontrado = pedidosEncontrados.length > 0 ? 'takeaway' : null;
      }
    }

    if (pedidosEncontrados.length > 0 && tipoEncontrado) {
      const pedido = pedidosEncontrados[0];
      const targetRestauranteId = pedido.restauranteId ?? restauranteId;

      if (Number(amount) < Number(pedido.total)) {
        console.warn(`⚠️ [Cucuru] Pago insuficiente para ${tipoEncontrado} #${pedido.id}. Pagado: $${amount}, Esperado: $${pedido.total}`);
        return c.json({ status: 'ignored_insufficient' }, 200);
      }

      await db.update(PedidoUnificadoTable).set({
        pagado: true,
        metodoPago: 'transferencia'
      }).where(eq(PedidoUnificadoTable.id, pedido.id));

      await db.insert(PagoTable).values({
        pedidoUnificadoId: pedido.id,
        metodo: 'transferencia',
        estado: 'paid',
        monto: String(amount),
        mpPaymentId: collectionId
      });

      const mesaNombre = tipoEncontrado === 'delivery' ? 'Delivery' : 'Take Away';
      const notifId = `notif-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      wsManager.notifyAdmins(targetRestauranteId, {
        id: notifId,
        tipo: 'NUEVO_PEDIDO',
        mesaId: 0,
        mesaNombre,
        mensaje: `Nuevo pedido de ${mesaNombre} (Pagado)`,
        detalles: `${pedido.nombreCliente || 'Cliente'} - $${pedido.total}`,
        timestamp: new Date().toISOString(),
        leida: false,
        pedidoId: pedido.id
      });

      console.log(`🚀 [Cucuru] Pago acreditado para ${tipoEncontrado} #${pedido.id}`);
      wsManager.broadcastAdminUpdate(targetRestauranteId, tipoEncontrado);
      wsManager.notifyPublicClientPayment(tipoEncontrado, pedido.id);

      // WhatsApp Notification
      try {
        const restaurante = await db.select({
          whatsappEnabled: RestauranteTable.whatsappEnabled,
          whatsappNumber: RestauranteTable.whatsappNumber,
          deliveryFee: RestauranteTable.deliveryFee
        }).from(RestauranteTable).where(eq(RestauranteTable.id, targetRestauranteId)).limit(1);

        if (restaurante[0]?.whatsappEnabled && restaurante[0]?.whatsappNumber) {
          const itemsRaw = await db.select({
            cantidad: ItemPedidoUnificadoTable.cantidad,
            nombreProducto: ProductoTable.nombre,
            esCanjePuntos: ItemPedidoUnificadoTable.esCanjePuntos
          })
            .from(ItemPedidoUnificadoTable)
            .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
            .where(eq(ItemPedidoUnificadoTable.pedidoId, pedido.id));

          const orderItemsForWa = itemsRaw.map(item => ({
            name: item.esCanjePuntos ? `${item.nombreProducto} (Canje Puntos)` : item.nombreProducto!,
            quantity: item.cantidad!
          }));

          if (tipoEncontrado === 'delivery' && restaurante[0].deliveryFee) {
            orderItemsForWa.push({ name: 'Delivery', quantity: 1 });
          }

          sendOrderWhatsApp(c, {
            phone: restaurante[0].whatsappNumber,
            customerName: pedido.nombreCliente || 'Cliente no especificado',
            address: tipoEncontrado === 'delivery' ? (pedido.direccion || 'Sin dirección') : 'Retira en local (Take Away)',
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

// ======================== TALO WEBHOOK ========================
webhookRoute.post('/talo', async (c) => {
  console.log('[Talo Webhook] POST /talo recibido @', new Date().toISOString());

  let body: { message?: string; paymentId?: string; externalId?: string };
  try {
    const rawText = await c.req.text();
    console.log('[Talo Webhook] Body raw:', rawText);
    body = JSON.parse(rawText) as typeof body;
    console.log('[Talo Webhook] Body parseado:', body);
  } catch (err) {
    console.error('[Talo Webhook] Error parseando JSON:', err);
    return c.json({ status: 'ok' }, 200);
  }

  const paymentId = body?.paymentId;
  const externalId = body?.externalId;

  if (!paymentId || !externalId) {
    console.log('[Talo Webhook] Rechazado: falta paymentId o externalId. paymentId=', paymentId, 'externalId=', externalId);
    return c.json({ status: 'ok' }, 200);
  }

  console.log('[Talo Webhook] Datos válidos. paymentId=', paymentId, 'externalId=', externalId, 'message=', body?.message);
  const envForBackground = c.env;

  (async () => {
    console.log('[Talo Webhook] Iniciando procesamiento en background para paymentId=', paymentId);
    try {
      const db = drizzle(pool);
      const pedidoId = parseInt(String(externalId), 10);
      if (isNaN(pedidoId)) {
        console.log('[Talo Webhook] externalId no es número válido:', externalId);
        return;
      }
      console.log('[Talo Webhook] Buscando pedido id=', pedidoId);

      const pedidos = await db
        .select({
          id: PedidoUnificadoTable.id,
          restauranteId: PedidoUnificadoTable.restauranteId,
          tipo: PedidoUnificadoTable.tipo,
          nombreCliente: PedidoUnificadoTable.nombreCliente,
          direccion: PedidoUnificadoTable.direccion,
          total: PedidoUnificadoTable.total,
        })
        .from(PedidoUnificadoTable)
        .where(eq(PedidoUnificadoTable.id, pedidoId))
        .limit(1);

      if (pedidos.length === 0) {
        console.log('[Talo Webhook] Pedido no encontrado:', pedidoId);
        return;
      }

      const pedido = pedidos[0];
      const restauranteId = pedido.restauranteId;
      console.log('[Talo Webhook] Pedido encontrado:', { id: pedido.id, tipo: pedido.tipo, restauranteId, total: pedido.total });

      const restaurantes = await db
        .select({ taloApiKey: RestauranteTable.taloApiKey })
        .from(RestauranteTable)
        .where(eq(RestauranteTable.id, restauranteId))
        .limit(1);

      if (restaurantes.length === 0 || !restaurantes[0].taloApiKey) {
        console.error('[Talo Webhook] Restaurante sin taloApiKey para pedido #' + pedidoId, 'restauranteId=', restauranteId);
        return;
      }
      console.log('[Talo Webhook] Restaurante con taloApiKey OK. Llamando consultarPagoTalo...');

      const taloApiKeyRaw = String(restaurantes[0].taloApiKey ?? '');
      const taloApiKeyMasked = (() => {
        const k = taloApiKeyRaw.trim();
        if (!k) return 'empty';
        return `${k.slice(0, 4)}...${k.slice(-4)} (len=${k.length})`;
      })();

      console.log('[Talo Webhook] taloApiKey:', {
        masked: taloApiKeyMasked,
        length: taloApiKeyRaw.length,
        hasWhitespace: /\s/.test(taloApiKeyRaw),
      });

      const taloData = await consultarPagoTalo(paymentId, taloApiKeyRaw);
      console.log('[Talo Webhook] consultarPagoTalo retornó:', taloData);

      if (taloData.payment_status === 'OVERPAID' || taloData.payment_status === 'UNDERPAID') {
        console.warn(
          `[Talo] Pago con status ${taloData.payment_status} - paymentId: ${paymentId}, externalId: ${externalId}, amount: ${taloData.price?.amount}`
        );
      }

      if (taloData.payment_status !== 'SUCCESS') {
        console.log('[Talo Webhook] Status no es SUCCESS, ignorando. status=', taloData.payment_status);
        return;
      }

      console.log('[Talo Webhook] Actualizando pedido pagado=true, metodoPago=transferencia...');
      await db
        .update(PedidoUnificadoTable)
        .set({ pagado: true, metodoPago: 'transferencia' })
        .where(eq(PedidoUnificadoTable.id, pedido.id));

      await db.insert(PagoTable).values({
        pedidoUnificadoId: pedido.id,
        metodo: 'transferencia',
        estado: 'paid',
        monto: String(taloData.price?.amount ?? pedido.total),
        mpPaymentId: paymentId,
      });
      console.log('[Talo Webhook] Pago insertado en PagoTable. Notificando WebSockets...');

      const mesaNombre = pedido.tipo === 'delivery' ? 'Delivery' : 'Take Away';
      wsManager.notifyAdmins(restauranteId, {
        id: `notif-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        tipo: 'NUEVO_PEDIDO',
        mesaId: 0,
        mesaNombre,
        mensaje: `Nuevo pedido de ${mesaNombre} (Pagado)`,
        detalles: `${pedido.nombreCliente || 'Cliente'} - $${pedido.total}`,
        timestamp: new Date().toISOString(),
        leida: false,
        pedidoId: pedido.id,
      });
      wsManager.broadcastAdminUpdate(restauranteId, pedido.tipo);
      wsManager.notifyPublicClientPayment(pedido.tipo, pedido.id);
      console.log('[Talo Webhook] WebSockets enviados. Verificando WhatsApp...');

      const restaurante = await db
        .select({
          whatsappEnabled: RestauranteTable.whatsappEnabled,
          whatsappNumber: RestauranteTable.whatsappNumber,
          deliveryFee: RestauranteTable.deliveryFee,
        })
        .from(RestauranteTable)
        .where(eq(RestauranteTable.id, restauranteId))
        .limit(1);

      if (restaurante[0]?.whatsappEnabled && restaurante[0]?.whatsappNumber) {
        const itemsRaw = await db
          .select({
            cantidad: ItemPedidoUnificadoTable.cantidad,
            nombreProducto: ProductoTable.nombre,
            esCanjePuntos: ItemPedidoUnificadoTable.esCanjePuntos,
          })
          .from(ItemPedidoUnificadoTable)
          .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
          .where(eq(ItemPedidoUnificadoTable.pedidoId, pedido.id));

        const orderItemsForWa = itemsRaw.map((item) => ({
          name: item.esCanjePuntos ? `${item.nombreProducto} (Canje Puntos)` : item.nombreProducto!,
          quantity: item.cantidad!,
        }));

        if (pedido.tipo === 'delivery' && restaurante[0].deliveryFee) {
          orderItemsForWa.push({ name: 'Delivery', quantity: 1 });
        }

        sendOrderWhatsApp(
          { env: envForBackground } as any,
          {
            phone: restaurante[0].whatsappNumber,
            customerName: pedido.nombreCliente || 'Cliente no especificado',
            address:
              pedido.tipo === 'delivery' ? (pedido.direccion || 'Sin dirección') : 'Retira en local (Take Away)',
            total: `${pedido.total} (transferencia)`,
            items: orderItemsForWa,
            orderId: pedido.id.toString(),
          }
        ).catch((e) => console.error('[Talo Webhook] Error enviando WhatsApp:', e));
        console.log('[Talo Webhook] WhatsApp enviado');
      } else {
        console.log('[Talo Webhook] WhatsApp no configurado o deshabilitado');
      }

      console.log('[Talo Webhook] ✅ Pago acreditado para', pedido.tipo, '#', pedido.id);
    } catch (err) {
      console.error('[Talo Webhook] ❌ Error procesando webhook en background:', err);
    }
  })();

  console.log('[Talo Webhook] Respondiendo 200 OK inmediatamente (procesamiento en background)');
  return c.json({ status: 'ok' }, 200);
});

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

        // Buscar el pedido (pedido_unificado tipo delivery)
        const pedidos = await db.select().from(PedidoUnificadoTable).where(and(eq(PedidoUnificadoTable.id, pedidoId), eq(PedidoUnificadoTable.tipo, 'delivery'))).limit(1);
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
            await db.update(PedidoUnificadoTable).set(updateData).where(eq(PedidoUnificadoTable.id, pedidoId));

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
