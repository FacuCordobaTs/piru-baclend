const TALO_API_BASE =
  process.env.TALO_ENV === 'production'
    ? 'https://api.talo.com.ar'
    : 'https://sandbox-api.talo.com.ar';

const WEBHOOK_BASE = process.env.API_PUBLIC_URL || 'https://api.piru.app';

// Caché en memoria para tokens JWT de Talo (expiran cada 1h, renovamos a los 50min)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Obtiene un token JWT de Talo, usando caché en memoria.
 * Si el token cacheado sigue vigente (< 50min), lo retorna directamente.
 */
async function obtenerTokenTalo(
  userId: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const cached = tokenCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  console.log('[Talo] obtenerTokenTalo: solicitando nuevo token para userId:', userId);

  const response = await fetch(`${TALO_API_BASE}/users/${userId}/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('[Talo] Error al obtener token:', response.status, errorBody);
    throw new Error(`Talo Auth Error: ${response.status} - ${errorBody}`);
  }

  const json = (await response.json()) as { data: { token: string } };
  const token = json.data.token;

  // Cachear por 50 minutos (tokens duran 60min)
  tokenCache.set(userId, { token, expiresAt: Date.now() + 50 * 60 * 1000 });
  console.log('[Talo] obtenerTokenTalo: token obtenido y cacheado para userId:', userId);

  return token;
}

export interface CrearPagoTaloParams {
  restauranteId: number;
  total: number;
  pedidoId: string;
  talo_client_id: string;
  talo_client_secret: string;
  talo_user_id: string;
}

// Talo usa "address" para el CVU y "alias" para el alias (no "cvu")
interface TaloQuote {
  address?: string;
  alias?: string;
  cvu?: string; // legacy, algunos endpoints podrían usarlo
}

interface CrearPagoTaloResponse {
  data: {
    id: string;
    payment_status: string;
    quotes: TaloQuote[];
    payment_url: string;
  };
}

interface ConsultarPagoTaloResponse {
  data: {
    payment_status: 'SUCCESS' | 'PENDING' | 'OVERPAID' | 'UNDERPAID' | 'EXPIRED';
    external_id: string;
    price: { amount: number };
  };
}



const maskSecret = (key: string) => {
  const k = key.trim();
  if (!k) return 'empty';
  const head = k.slice(0, 4);
  const tail = k.slice(-4);
  return `${head}...${tail} (len=${k.length})`;
};

/**
 * Crea un pago por transferencia en Talo y retorna los datos para que el cliente transfiera.
 */
export async function crearPagoTalo(
  params: CrearPagoTaloParams
): Promise<{ cvu: string; alias: string; paymentId: string }> {
  const { total, pedidoId, talo_client_id, talo_client_secret, talo_user_id } = params;
  const jwtToken = await obtenerTokenTalo(talo_user_id, talo_client_id, talo_client_secret);
  const webhookUrl = `${WEBHOOK_BASE}/api/webhook/talo`;

  console.log('[Talo] crearPagoTalo INICIO:', {
    pedidoId,
    total,
    talo_user_id,
    webhookUrl,
    apiBase: TALO_API_BASE,
  });

  try {
    const body = {
      user_id: talo_user_id,
      price: { amount: total, currency: 'ARS' },
      payment_options: ['transfer'],
      external_id: pedidoId,
      webhook_url: webhookUrl,
    };
    console.log('[Talo] crearPagoTalo REQUEST body:', JSON.stringify(body));

    const response = await fetch(`${TALO_API_BASE}/payments/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    console.log('[Talo] crearPagoTalo RESPONSE status:', response.status);

    const json = (await response.json()) as CrearPagoTaloResponse;
    console.log('[Talo] crearPagoTalo RESPONSE body:', JSON.stringify(json));

    if (!response.ok) {
      console.error(
        '[Talo] Error al crear pago:',
        response.status,
        JSON.stringify(json)
      );
      throw new Error(
        `Talo API Error: ${response.status} - ${JSON.stringify(json)}`
      );
    }

    const quote = json.data?.quotes?.[0];
    const cvu = quote?.address ?? quote?.cvu;
    const alias = quote?.alias;
    console.log('[Talo] crearPagoTalo quote extraído:', { quote, cvu, alias, paymentId: json.data?.id });

    if (!cvu && !alias) {
      console.error('[Talo] Respuesta sin CVU/alias:', JSON.stringify(json));
      throw new Error('Talo no devolvió CVU ni alias en la respuesta');
    }

    const result = { cvu: cvu ?? '', alias: alias ?? '', paymentId: json.data.id };
    console.log('[Talo] crearPagoTalo OK retornando:', result);
    return result;
  } catch (error) {
    console.error('[Talo] Error al crear pago (pedidoId:', pedidoId, '):', error);
    throw error;
  }
}

/**
 * Consulta el estado de un pago en Talo.
 */
export async function consultarPagoTalo(
  paymentId: string,
  taloUserId: string,
  taloClientId: string,
  taloClientSecret: string
): Promise<ConsultarPagoTaloResponse['data']> {
  const jwtToken = await obtenerTokenTalo(taloUserId, taloClientId, taloClientSecret);
  console.log('[Talo] consultarPagoTalo INICIO:', {
    paymentId,
    apiBase: TALO_API_BASE,
    taloUserId,
  });

  try {
    const response = await fetch(`${TALO_API_BASE}/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwtToken}`,
      },
    });

    console.log('[Talo] consultarPagoTalo RESPONSE status:', response.status);

    const json = (await response.json()) as ConsultarPagoTaloResponse;
    console.log('[Talo] consultarPagoTalo RESPONSE body:', JSON.stringify(json));

    if (!response.ok) {
      console.error(
        '[Talo] Error al consultar pago:',
        paymentId,
        response.status,
        JSON.stringify(json)
      );
      throw new Error(
        `Talo API Error: ${response.status} - ${JSON.stringify(json)}`
      );
    }

    console.log('[Talo] consultarPagoTalo OK data:', json.data);
    return json.data;
  } catch (error) {
    console.error('[Talo] Error al consultar pago (paymentId:', paymentId, '):', error);
    throw error;
  }
}
