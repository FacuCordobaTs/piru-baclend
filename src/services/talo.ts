const TALO_API_BASE =
  process.env.TALO_ENV === 'production'
    ? 'https://api.talo.com.ar'
    : 'https://sandbox-api.talo.com.ar';

const WEBHOOK_BASE = process.env.API_PUBLIC_URL || 'https://api.piru.app';

export interface CrearPagoTaloParams {
  restauranteId: number;
  total: number;
  pedidoId: string;
  api_key: string;
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

const normalizeApiKey = (key: string) => {
  // Algunas veces la key en DB puede venir con espacios o prefijo "Bearer ".
  const trimmed = key.trim();
  return trimmed.replace(/^Bearer\s+/i, '');
};

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
  const { total, pedidoId, api_key, talo_user_id } = params;
  const normalizedApiKey = normalizeApiKey(api_key);
  const webhookUrl = `${WEBHOOK_BASE}/api/webhook/talo`;

  console.log('[Talo] crearPagoTalo INICIO:', {
    pedidoId,
    total,
    talo_user_id,
    webhookUrl,
    apiBase: TALO_API_BASE,
    apiKeyMasked: maskSecret(api_key),
    apiKeyNormalizedMasked: maskSecret(normalizedApiKey),
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
        Authorization: `Bearer ${normalizedApiKey}`,
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
  api_key: string
): Promise<ConsultarPagoTaloResponse['data']> {
  const normalizedApiKey = normalizeApiKey(api_key);
  console.log('[Talo] consultarPagoTalo INICIO:', {
    paymentId,
    apiBase: TALO_API_BASE,
    apiKeyMasked: maskSecret(api_key),
    apiKeyNormalizedMasked: maskSecret(normalizedApiKey),
  });

  try {
    const response = await fetch(`${TALO_API_BASE}/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${normalizedApiKey}`,
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
