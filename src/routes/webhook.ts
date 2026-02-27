import { Hono } from 'hono'

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

// GET de prueba para crear una cuenta de cobro en Cucuru desde el backend
// Accede desde el navegador a esta ruta para disparar la request y ver la respuesta.
webhookRoute.get('/cucuru/create_account', async (c) => {
  try {
    const apiKey = process.env.CUCURU_API_KEY;
    const collectorId = process.env.CUCURU_COLLECTOR_ID;

    if (!apiKey || !collectorId) {
      return c.json(
        {
          ok: false,
          message:
            'Faltan variables de entorno CUCURU_API_KEY o CUCURU_COLLECTOR_ID. Configúralas en el backend.',
        },
        500
      );
    }

    const url = 'https://api.cucuru.com/app/v1/Collection/accounts/account';

    // Puedes cambiar estos valores para probar distintos customer_id / read_only
    const body = {
      customer_id: 'CLIENTE_TEST_BACKEND',
      read_only: 'true', // "true" o "false", o elimina este campo si quieres usar el default
    };

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Cucuru-Api-Key': apiKey,
        'X-Cucuru-Collector-id': collectorId,
      },
      body: JSON.stringify(body),
    });

    let data: any;
    const text = await response.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    // Devolvemos al navegador el status HTTP de Cucuru y el cuerpo que respondió
    return c.json(
      {
        ok: response.ok,
        status: response.status,
        data,
      },
      response.status
    );
  } catch (error) {
    console.error('❌ Error creando cuenta en Cucuru:', error);
    return c.json(
      {
        ok: false,
        message: 'Error interno llamando a la API de Cucuru',
      },
      500
    );
  }
});


export { webhookRoute }