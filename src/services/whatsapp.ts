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
}

// Helper: Convierte el array de items en un string multilinea formateado
const formatOrderSummary = (items: OrderItem[]): string => {
    // Calculamos la cantidad total de cosas que pidió
    const totalArticulos = items.reduce((suma, item) => suma + item.quantity, 0);

    // Armamos un string separado por comas (sin saltos de línea)
    // Ej: "2x Hamburguesa Doble, 1x Papas"
    const resumen = items.map(item => `${item.quantity}x ${item.name}`).join(', ');

    // Meta limita los caracteres de las variables. Si el pedido es gigante,
    // aplicamos tu brillante idea del texto genérico para que vayan al panel.
    if (resumen.length > 50) {
        return `${totalArticulos} producto${totalArticulos > 1 ? 's' : ''} (Ver en el panel)`;
    }

    return resumen;
};

export const sendOrderWhatsApp = async (c: any, data: OrderNotification) => {
    const { WHATSAPP_API_TOKEN, WHATSAPP_PHONE_ID } = env<{ WHATSAPP_API_TOKEN: string; WHATSAPP_PHONE_ID: string }>(c);

    // Ajustar versión de API si es necesario, v22.0 o superior
    const url = `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_ID}/messages`;

    // Preparamos el string de la lista
    const itemsListString = formatOrderSummary(data.items);

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
                        { type: "text", parameter_name: "monto_total", text: data.total }
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
                "Authorization": `Bearer ${WHATSAPP_API_TOKEN}`,
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
