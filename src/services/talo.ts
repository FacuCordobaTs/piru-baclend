const TALO_API_BASE =
  process.env.NODE_ENV === 'production'
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

interface TaloQuote {
  cvu: string;
  alias: string;
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

/**
 * Crea un pago por transferencia en Talo y retorna los datos para que el cliente transfiera.
 */
export async function crearPagoTalo(
  params: CrearPagoTaloParams
): Promise<{ cvu: string; alias: string; paymentId: string }> {
  const { total, pedidoId, api_key, talo_user_id } = params;
  const webhookUrl = `${WEBHOOK_BASE}/api/webhook/talo`;

  try {
    const response = await fetch(`${TALO_API_BASE}/payments/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: talo_user_id,
        price: { amount: total, currency: 'ARS' },
        payment_options: ['transfer'],
        external_id: pedidoId,
        webhook_url: webhookUrl,
      }),
    });

    const json = (await response.json()) as CrearPagoTaloResponse;

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
    if (!quote?.cvu || !quote?.alias) {
      console.error('[Talo] Respuesta sin CVU/alias:', JSON.stringify(json));
      throw new Error('Talo no devolvió CVU ni alias en la respuesta');
    }

    return {
      cvu: quote.cvu,
      alias: quote.alias,
      paymentId: json.data.id,
    };
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
  try {
    const response = await fetch(`${TALO_API_BASE}/payments/${paymentId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${api_key}`,
      },
    });

    const json = (await response.json()) as ConsultarPagoTaloResponse;

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

    return json.data;
  } catch (error) {
    console.error('[Talo] Error al consultar pago (paymentId:', paymentId, '):', error);
    throw error;
  }
}
