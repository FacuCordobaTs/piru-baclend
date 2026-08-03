// src/lib/mp-recarga.ts
// Creación de la preferencia de Checkout Pro para una recarga de mensajes. El pago va a
// la cuenta de la PLATAFORMA (Piru), no a la del restaurante: se usa el access token de
// plataforma y SIN marketplace_fee (100% a Piru). Compartido por el checkout autenticado
// (routes/mensajes.ts) y el link de pago por QR público (routes/pago.ts).

const MP_PLATFORM_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
const MP_WEBHOOK_URL = 'https://api.piru.app/api/mp/webhook'

export type ResultadoPreferenciaMP =
  | { ok: true; preferenceId: string; initPoint: string }
  | { ok: false; error: unknown }

/** ¿Está configurado el token de plataforma para cobrar recargas? */
export function pagosRecargaDisponibles(): boolean {
  return Boolean(MP_PLATFORM_ACCESS_TOKEN)
}

/**
 * Crea la preferencia de MercadoPago para una recarga ya existente (identificada por su
 * `recargaId`, que viaja como external_reference `piru-recarga-{id}` para que el webhook
 * la acredite). Devuelve el init_point para redirigir al pago.
 */
export async function crearPreferenciaRecargaMP(opts: {
  recargaId: number
  titulo: string
  precio: number
  backUrl: string
}): Promise<ResultadoPreferenciaMP> {
  const externalReference = `piru-recarga-${opts.recargaId}`

  const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MP_PLATFORM_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      items: [{
        title: opts.titulo,
        quantity: 1,
        currency_id: 'ARS',
        unit_price: opts.precio,
      }],
      back_urls: { success: opts.backUrl, failure: opts.backUrl, pending: opts.backUrl },
      auto_return: 'approved',
      external_reference: externalReference,
      notification_url: MP_WEBHOOK_URL,
      statement_descriptor: 'PIRU',
      expires: true,
      expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  })

  const preference = await mpResponse.json() as any
  if (!mpResponse.ok) {
    console.error('❌ [Recarga MP] Error creando preferencia:', preference)
    return { ok: false, error: preference }
  }

  return { ok: true, preferenceId: String(preference.id), initPoint: preference.init_point }
}
