import { Hono } from 'hono'
import { pool } from '../db'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, ne } from 'drizzle-orm'
import {
  pedido as PedidoTable,
  pago as PagoTable,
  notificacion as NotificacionTable
} from '../db/schema'

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

    // LOGS: Fundamental para ver qué nos manda Cucuru la primera vez
    console.log('🔔 Webhook recibido de Cucuru:', JSON.stringify(body, null, 2));

    const amount = body.amount;
    const customerIdStr = body.customer_id;
    const collectionId = body.collection_id;

    // CASO DE PRUEBA (El "Handshake" inicial)
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

    // Buscar en la tabla pedido un registro que coincida
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
      console.log('⚠️ Pago Huérfano / Posible Propina (No Match)');
      return c.json({ status: 'received' }, 200);
    }

    const pedido = pedidos[0];

    // Match: Update pedido
    await db.update(PedidoTable)
      .set({
        pagado: true,
        estado: 'closed',
        metodoPago: 'transferencia',
        closedAt: new Date()
      })
      .where(eq(PedidoTable.id, pedido.id));

    // Insert en tabla pago: registrar la transacción
    await db.insert(PagoTable)
      .values({
        pedidoId: pedido.id,
        metodo: 'transferencia',
        estado: 'paid',
        monto: String(amount),
        mpPaymentId: collectionId
      });

    // Insert en tabla notificacion: Tipo PAGO_RECIBIDO
    const notifId = `notif-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    await db.insert(NotificacionTable)
      .values({
        id: notifId,
        restauranteId: restauranteId,
        tipo: 'PAGO_RECIBIDO',
        mesaId: pedido.mesaId,
        pedidoId: pedido.id,
        mensaje: `Pago de $${amount} recibido vía Cucuru`,
        detalles: `CVU origen: ${body.collection_account || 'Desconocido'} - Transacción: ${collectionId}`
      });

    return c.json({ status: 'received' }, 200);

  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    // Siempre responder 200 rápido para evitar encolados de Cucuru, excepto error interno real
    return c.json({ error: 'Internal Error' }, 500);
  }
});

export default webhookRoute;
