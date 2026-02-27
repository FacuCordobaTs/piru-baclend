import { Hono } from 'hono'
import { ContentfulStatusCode } from 'hono/utils/http-status';

const webhookRoute = new Hono()

.get('/', async (c) => { 
    return c.json({ message: 'Webhook get received' }, 200)
})

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

  
  const apiKey = process.env.CUCURU_API_KEY;
  const collectorId = process.env.CUCURU_COLLECTOR_ID;
  webhookRoute.get('/cucuru/create_account', async (c) => {
    try {
      const productId = collectorId; // El alias que conocemos
  
      // PASO 1: DESCUBRIR EL ID REAL (Investigación)
      // Llamamos al endpoint que descubriste en el navegador
      const configUrl = `https://api.cucuru.com/app/v1/Collection/config?product_Id=${productId}`;
      
      const configResponse = await fetch(configUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
          // A veces estos endpoints públicos no piden API Key, pero por si acaso:
          // 'X-Cucuru-Api-Key': apiKey 
        }
      });
  
      const configData = await configResponse.json();
      
      // Si esto funciona, imprimimos qué nos devolvió para encontrar el ID oculto
      console.log("🕵️‍♂️ DATOS DE CONFIGURACIÓN RECUPERADOS:", configData);
  
      // Intentamos adivinar cuál es el campo correcto del ID
      // (Ajustaremos esto según lo que salga en el console log)
      const realCollectorId = configData.id || configData.collector_id || configData.collectorId;
  
      if (!realCollectorId) {
          return c.json({ 
              message: "No encontramos el ID numérico en la config", 
              debug: configData 
          }, 400);
      }
  
      // PASO 2: USAR EL ID REAL PARA CREAR LA CUENTA
      const createUrl = 'https://api.cucuru.com/app/v1/Collection/accounts/account';
      const body = {
        customer_id: 'CLIENTE_TEST_FINAL',
        read_only: 'true',
      };
  
      const response = await fetch(createUrl, {
        method: 'PUT',
        headers: new Headers({
          'Content-Type': 'application/json',
          'X-Cucuru-Api-Key': apiKey ?? '',
          // AQUÍ USAMOS EL ID NUMÉRICO QUE DESCUBRIMOS
          'X-Cucuru-Collector-id': realCollectorId.toString(),
        }),
        body: JSON.stringify(body),
      });

      const result = await response.json();

      return c.json({
        paso_1_config: configData,
        id_usado: realCollectorId,
        resultado_final: result
      }, response.status as ContentfulStatusCode);
  
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  });

export { webhookRoute }