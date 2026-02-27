import { Hono } from 'hono'

const webhookRoute = new Hono()

.post('/', async (c) => {
    return c.json({ message: 'Webhook received' }, 200)
})

webhookRoute.post('/cucuru/collection_received', async (c: any) => {
    try {
      const body = await c.req.json();
  
      // LOGS: Fundamental para ver qué nos manda Cucuru la primera vez
      console.log('🔔 Webhook recibido de Cucuru:', JSON.stringify(body, null, 2));
  
      const amount = body.amount; // [cite: 187]
  
      // CASO DE PRUEBA (El "Handshake" inicial)
      // Cuando configuramos el webhook, mandan importe 0 [cite: 245]
      if (amount === 0) {
        console.log('✅ Validación de Webhook exitosa (Importe 0)');
        return c.json({ status: 'ok' }, 200); // [cite: 246]
      }
  
      // AQUÍ IRÁ LA LÓGICA DE NEGOCIO (Split payment, liberar pedido, etc.)
      // ... procesarPago(body) ...
  
      return c.json({ status: 'received' }, 200); // Responder siempre 200 rápido [cite: 200]
  
    } catch (error) {
      console.error('❌ Error procesando webhook:', error);
      // Aunque falle tu lógica interna, a veces conviene responder 200 para que no reintenten,
      // pero en desarrollo responde 500 para enterarte.
      return c.json({ error: 'Internal Error' }, 500);
    }
  });


export { webhookRoute }