// src/lib/mp-suscripcion.ts
// Creación de la preferencia de Checkout Pro para el pago de la cuota de un plan (suscripción).
// El pago va a la cuenta de la PLATAFORMA (Piru): access token de plataforma y SIN marketplace_fee
// (100% a Piru). Compartido por el checkout autenticado (routes/planes.ts → /suscribir) y el link
// de pago público que se envía por WhatsApp (routes/pago.ts). Es un pago ÚNICO, no una suscripción
// recurrente de MP: el webhook (external_reference `piru-plansub-{id}`) extiende la suscripción un
// ciclo al aprobarse.

const MP_PLATFORM_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN
const MP_WEBHOOK_URL = 'https://api.piru.app/api/mp/webhook'

export type ResultadoPreferenciaMP =
  | { ok: true; preferenceId: string; initPoint: string }
  | { ok: false; error: unknown }

/** ¿Está configurado el token de plataforma para cobrar la cuota del plan? */
export function pagosSuscripcionDisponibles(): boolean {
  return Boolean(MP_PLATFORM_ACCESS_TOKEN)
}

/**
 * Crea la preferencia de MercadoPago para un pago de suscripción ya existente (identificado por su
 * `pagoId`, que viaja como external_reference `piru-plansub-{id}` para que el webhook lo confirme).
 * Devuelve el init_point para redirigir al pago.
 */
export async function crearPreferenciaSuscripcionMP(opts: {
  pagoId: number
  titulo: string
  precio: number
  backUrl: string
}): Promise<ResultadoPreferenciaMP> {
  const externalReference = `piru-plansub-${opts.pagoId}`

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
      expiration_date_to: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  })

  const preference = await mpResponse.json() as any
  if (!mpResponse.ok) {
    console.error('❌ [Suscripción MP] Error creando preferencia:', preference)
    return { ok: false, error: preference }
  }

  return { ok: true, preferenceId: String(preference.id), initPoint: preference.init_point }
}
