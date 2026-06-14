import { env } from 'hono/adapter'

// Interfaces para tipado estricto
interface OrderItem {
    name: string;
    quantity: number;
}

export interface OrderNotification {
    phone: string;        // El número del restaurante
    customerName: string; // {{nombre_cliente}}
    address: string;      // {{direccion_cliente}}
    total: string;        // {{monto_total}}
    items: OrderItem[];   // Array para generar {{lista_items}}
    orderId: string;      // Variable {{1}} para el botón
    horarioProgramado?: string | null;
}

export interface ClientPaymentConfirmedData {
    phone: string;
    customerName: string;
    restaurantName: string;
    total: string;
    orderId: string;
    demoraMinutos?: number;
    horarioProgramado?: string | null;
}

export interface ClientOrderDispatchedData {
    phone: string;
    customerName: string;
    restaurantName: string;
    orderStatus: string;
}

export interface ClientOrderConfirmedWithDelayData {
    phone: string;
    customerName: string;
    restaurantName: string;
    total: string;
    orderId: string;
    demoraMinutos: number;
}

type WaCredentials = { phoneId: string; token: string }

// Helper: Convierte el array de items en un string multilinea formateado
const formatOrderSummary = (items: OrderItem[], horarioProgramado?: string | null): string => {
    const totalArticulos = items.reduce((suma, item) => suma + item.quantity, 0);
    let resumen = `${totalArticulos} producto${totalArticulos > 1 ? 's' : ''} (Ver en el panel)`;
    if (horarioProgramado) {
        resumen += ` · Programado: ${horarioProgramado}`;
    }
    return resumen;
};

export const sendOrderWhatsApp = async (c: any, data: OrderNotification, creds?: WaCredentials) => {
    const { WHATSAPP_API_TOKEN, WHATSAPP_PHONE_ID } = env<{ WHATSAPP_API_TOKEN: string; WHATSAPP_PHONE_ID: string }>(c);
    const phoneId = creds?.phoneId ?? WHATSAPP_PHONE_ID;
    const token = creds?.token ?? WHATSAPP_API_TOKEN;

    const url = `https://graph.facebook.com/v22.0/${phoneId}/messages`;

    // Preparamos el string de la lista
    const itemsListString = formatOrderSummary(data.items, data.horarioProgramado);

    // Formatear el método de pago para que sea amigable en lectura
    const formattedTotal = data.total
        .replace('(cash)', '(Efectivo)')
        .replace('(manual_transfer)', '(Transferencia)');

    const body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: data.phone,
        type: "template",
        template: {
            name: "pedido_detalle_v1", // Nombre de la plantilla en Meta
            language: { code: "es_AR" },
            components: [
                {
                    type: "body",
                    parameters: [
                        // El orden NO importa si son parámetros nombrados, pero asegurate que coincidan los keys
                        { type: "text", parameter_name: "nombre_cliente", text: data.customerName },
                        { type: "text", parameter_name: "direccion_cliente", text: data.address },
                        { type: "text", parameter_name: "lista_items", text: itemsListString },
                        { type: "text", parameter_name: "monto_total", text: formattedTotal }
                    ]
                },
                {
                    type: "button",
                    sub_type: "url",
                    index: 0,
                    parameters: [
                        // En botones, la variable siempre es posicional {{1}}
                        { type: "text", text: data.orderId }
                    ]
                }
            ]
        }
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        const result = await response.json();

        if (!response.ok) {
            console.error("❌ Error WhatsApp API:", JSON.stringify(result, null, 2));
            return { success: false, error: result };
        }

        console.log("✅ WhatsApp enviado correctamente");
        return { success: true, id: result.messages?.[0]?.id };

    } catch (error) {
        console.error("❌ Error de red enviando WhatsApp:", error);
        return { success: false, error };
    }
};

export const sendClientPaymentConfirmedWhatsApp = async (c: any, data: ClientPaymentConfirmedData, creds?: WaCredentials) => {
    const { WHATSAPP_API_TOKEN, WHATSAPP_PHONE_ID } = env<{ WHATSAPP_API_TOKEN: string; WHATSAPP_PHONE_ID: string }>(c);
    const phoneId = creds?.phoneId ?? WHATSAPP_PHONE_ID;
    const token = creds?.token ?? WHATSAPP_API_TOKEN;

    const url = `https://graph.facebook.com/v22.0/${phoneId}/messages`;

    let totalConDemora = data.demoraMinutos != null
        ? `${data.total} · Demora aprox. ${data.demoraMinutos} min`
        : data.total;
    if (data.horarioProgramado) {
        totalConDemora += ` · Programado: ${data.horarioProgramado}`;
    }

    const body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: data.phone,
        type: "template",
        template: {
            name: "pedido_confirmado_v1",
            language: { code: "es_AR" },
            components: [
                {
                    type: "body",
                    parameters: [
                        { type: "text", parameter_name: "nombre_cliente", text: data.customerName },
                        { type: "text", parameter_name: "nombre_del_local", text: data.restaurantName },
                        { type: "text", parameter_name: "monto_total", text: totalConDemora }
                    ]
                },
                {
                    type: "button",
                    sub_type: "url",
                    index: 0,
                    parameters: [
                        { type: "text", text: data.orderId }
                    ]
                }
            ]
        }
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        const result = await response.json();

        if (!response.ok) {
            console.error("❌ Error WhatsApp API:", JSON.stringify(result, null, 2));
            return { success: false, error: result };
        }

        console.log("✅ WhatsApp enviado correctamente");
        return { success: true, id: result.messages?.[0]?.id };

    } catch (error) {
        console.error("❌ Error de red enviando WhatsApp:", error);
        return { success: false, error };
    }
};

export const sendClientOrderConfirmedWithDelayWhatsApp = async (c: any, data: ClientOrderConfirmedWithDelayData, creds?: WaCredentials) => {
    const { WHATSAPP_API_TOKEN, WHATSAPP_PHONE_ID } = env<{ WHATSAPP_API_TOKEN: string; WHATSAPP_PHONE_ID: string }>(c);
    const phoneId = creds?.phoneId ?? WHATSAPP_PHONE_ID;
    const token = creds?.token ?? WHATSAPP_API_TOKEN;

    const url = `https://graph.facebook.com/v22.0/${phoneId}/messages`;

    const body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: data.phone,
        type: "template",
        template: {
            name: "pedido_confirmado_con_demora_v1",
            language: { code: "es_AR" },
            components: [
                {
                    type: "body",
                    parameters: [
                        { type: "text", parameter_name: "nombre_cliente", text: data.customerName },
                        { type: "text", parameter_name: "nombre_del_local", text: data.restaurantName },
                        { type: "text", parameter_name: "monto_total", text: data.total },
                        { type: "text", parameter_name: "demora_minutos", text: String(data.demoraMinutos) }
                    ]
                },
                {
                    type: "button",
                    sub_type: "url",
                    index: 0,
                    parameters: [
                        { type: "text", text: data.orderId }
                    ]
                }
            ]
        }
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        const result = await response.json();

        if (!response.ok) {
            console.error("❌ Error WhatsApp API:", JSON.stringify(result, null, 2));
            return { success: false, error: result };
        }

        console.log("✅ WhatsApp con demora enviado correctamente");
        return { success: true, id: result.messages?.[0]?.id };

    } catch (error) {
        console.error("❌ Error de red enviando WhatsApp:", error);
        return { success: false, error };
    }
};

export const sendClientOrderDispatchedWhatsApp = async (c: any, data: ClientOrderDispatchedData, creds?: WaCredentials) => {
    const { WHATSAPP_API_TOKEN, WHATSAPP_PHONE_ID } = env<{ WHATSAPP_API_TOKEN: string; WHATSAPP_PHONE_ID: string }>(c);
    const phoneId = creds?.phoneId ?? WHATSAPP_PHONE_ID;
    const token = creds?.token ?? WHATSAPP_API_TOKEN;

    const url = `https://graph.facebook.com/v22.0/${phoneId}/messages`;

    const body = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: data.phone,
        type: "template",
        template: {
            name: "pedido_despachado_v1",
            language: { code: "es_AR" },
            components: [
                {
                    type: "body",
                    parameters: [
                        { type: "text", parameter_name: "nombre_cliente", text: data.customerName },
                        { type: "text", parameter_name: "nombre_del_local", text: data.restaurantName },
                        { type: "text", parameter_name: "estado_del_pedido", text: data.orderStatus }
                    ]
                }
            ]
        }
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        });

        const result = await response.json();

        if (!response.ok) {
            console.error("❌ Error WhatsApp API:", JSON.stringify(result, null, 2));
            return { success: false, error: result };
        }

        console.log("✅ WhatsApp enviado correctamente");
        return { success: true, id: result.messages?.[0]?.id };

    } catch (error) {
        console.error("❌ Error de red enviando WhatsApp:", error);
        return { success: false, error };
    }
};

export interface WhatsAppTextMessage {
  phone: string;
  text: string;
  phoneNumberId?: string;
}

export const sendWhatsAppText = async (
  token: string,
  phoneNumberId: string,
  data: WhatsAppTextMessage
): Promise<{ success: boolean; messageId?: string; error?: unknown }> => {
  const targetPhoneId = data.phoneNumberId ?? phoneNumberId;
  const url = `https://graph.facebook.com/v22.0/${targetPhoneId}/messages`;

  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: data.phone,
    type: "text",
    text: {
      preview_url: false,
      body: data.text,
    },
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const result = await response.json() as any;

    if (!response.ok) {
      console.error("❌ [sendWhatsAppText] Error:", JSON.stringify(result, null, 2));
      return { success: false, error: result };
    }

    return { success: true, messageId: result.messages?.[0]?.id };
  } catch (error) {
    console.error("❌ [sendWhatsAppText] Error de red:", error);
    return { success: false, error };
  }
};
