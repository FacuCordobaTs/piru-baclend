import { env } from 'hono/adapter'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import { pool } from '../db'
import {
    restaurante as RestauranteTable,
    pedidoUnificado as PedidoUnificadoTable,
    mensajeWhatsapp as MensajeWhatsappTable,
} from '../db/schema'
import { tieneAcceso, FEATURE_KEYS } from '../lib/planes'

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

export type WaCredentials = { phoneId: string; token: string }

/**
 * Resuelve las credenciales de Meta a usar para enviar en nombre de un restaurante.
 *
 * Reglas:
 *  - Si el local NO tiene `whatsappPhoneId` → devuelve `undefined`: los envíos salen con el
 *    número de plataforma Piru (los `send*WhatsApp` caen a `WHATSAPP_PHONE_ID`/`WHATSAPP_API_TOKEN`).
 *  - Si el local tiene `whatsappPhoneId` → se envía DESDE ese número. El token es su
 *    `whatsappAccessToken` si lo tiene (número bajo otra app/WABA, p. ej. OAuth oficial de Meta);
 *    si está vacío, se reusa el System User token de plataforma (`WHATSAPP_API_TOKEN`). Esto es
 *    lo que permite dar de alta a mano chips que Piru compra bajo su PROPIA Meta Business: alcanza
 *    con cargar el phoneId, el token es el mismo para todos los números del negocio.
 *
 * Por eso el gate es solo sobre `phoneId` (antes se exigían ambos): un número cargado a mano sin
 * token propio debe seguir enviando DESDE ese número, no caer al de plataforma.
 */
export const resolverCredsRestaurante = (
    rest: { whatsappPhoneId?: string | null; whatsappAccessToken?: string | null } | null | undefined,
): WaCredentials | undefined => {
    if (!rest?.whatsappPhoneId) return undefined;
    return { phoneId: rest.whatsappPhoneId, token: rest.whatsappAccessToken ?? process.env.WHATSAPP_API_TOKEN! };
};

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

export interface VerificationCodeData {
    phone: string; // Número del usuario que se está registrando (formato internacional, solo dígitos)
    code: string;  // Código de 6 dígitos
}

/**
 * Envía el código de verificación de registro por WhatsApp usando la plantilla de
 * autenticación `codigo_verificacion_v1` (categoría AUTHENTICATION, con botón de copiar código).
 * Usa el número de la plataforma Piru (WHATSAPP_PHONE_ID) porque la cuenta aún no existe.
 */
export const sendVerificationCodeWhatsApp = async (c: any, data: VerificationCodeData, creds?: WaCredentials) => {
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
            name: "codigo_verificacion_v1",
            language: { code: "es_AR" },
            components: [
                {
                    // En plantillas de autenticación el código es posicional {{1}} en el body
                    type: "body",
                    parameters: [
                        { type: "text", text: data.code }
                    ]
                },
                {
                    // Botón "copiar código" de la plantilla de autenticación
                    type: "button",
                    sub_type: "url",
                    index: 0,
                    parameters: [
                        { type: "text", text: data.code }
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
            console.error("❌ Error WhatsApp API (código verificación):", JSON.stringify(result, null, 2));
            return { success: false, error: result };
        }

        console.log("✅ Código de verificación WhatsApp enviado correctamente");
        return { success: true, id: result.messages?.[0]?.id };

    } catch (error) {
        console.error("❌ Error de red enviando código de verificación:", error);
        return { success: false, error };
    }
};

/**
 * Notifica al cliente por WhatsApp que su pago fue confirmado (template `pedido_confirmado_v1`).
 * Pensado para llamarse desde los webhooks de pago online (MercadoPago, Cucuru, Talo) una vez
 * acreditado el pago, ya que en esos flujos la creación del pedido no notifica al cliente
 * (espera la confirmación del webhook — ver `debeEsperarWebhookParaNotificar`).
 *
 * Respeta la config: solo envía si el restaurante tiene `notificarClientesWhatsapp`, hay teléfono,
 * y NO está en modo confirmación manual (en ese modo el aviso lo dispara el admin desde el panel
 * con la demora). NO se exige el flag por-pedido `notificarWhatsapp`: es redundante con el setting
 * del restaurante (los clientes lo mandan siempre en true) y depende de la versión del build del
 * cliente, así que exigirlo generaba falsos negativos. La fuente de verdad es el restaurante.
 * Se auto-abastece de la DB para que el call site solo pase los IDs. Idempotente ante fallos.
 */
export const notificarClientePagoConfirmado = async (
    c: any,
    { restauranteId, pedidoId }: { restauranteId: number; pedidoId: number }
): Promise<void> => {
    const db = drizzle(pool);

    // Los avisos automáticos al cliente por WhatsApp son feature de plan Intermedio+.
    // En el plan Básico el cliente NUNCA recibe estos mensajes (los manda él mismo con
    // el botón "Enviar pedido al WhatsApp"). Cuentas pre-planes: fail-open (tieneAcceso true).
    if (!(await tieneAcceso(db, restauranteId, FEATURE_KEYS.AVISOS_WHATSAPP_CLIENTE))) {
        console.log(`📲 [Notificar Cliente Pago] Pedido #${pedidoId} omitido (plan sin avisos automáticos al cliente)`);
        return;
    }

    const [row] = await db
        .select({
            telefono: PedidoUnificadoTable.telefono,
            nombreCliente: PedidoUnificadoTable.nombreCliente,
            total: PedidoUnificadoTable.total,
            demoraMinutos: PedidoUnificadoTable.demoraMinutos,
            horarioProgramado: PedidoUnificadoTable.horarioProgramado,
            nombreRestaurante: RestauranteTable.nombre,
            notificarClientesWhatsapp: RestauranteTable.notificarClientesWhatsapp,
            modoConfirmacionManual: RestauranteTable.modoConfirmacionManual,
            whatsappPhoneId: RestauranteTable.whatsappPhoneId,
            whatsappAccessToken: RestauranteTable.whatsappAccessToken,
        })
        .from(PedidoUnificadoTable)
        .leftJoin(RestauranteTable, eq(PedidoUnificadoTable.restauranteId, RestauranteTable.id))
        .where(eq(PedidoUnificadoTable.id, pedidoId))
        .limit(1);

    if (!row) return;
    if (!row.notificarClientesWhatsapp || !row.telefono || row.modoConfirmacionManual) {
        console.log(`📲 [Notificar Cliente Pago] Pedido #${pedidoId} omitido (notificarClientesWhatsapp=${row.notificarClientesWhatsapp}, telefono=${!!row.telefono}, modoManual=${row.modoConfirmacionManual})`);
        return;
    }

    const creds = resolverCredsRestaurante(row);

    const result = await sendClientPaymentConfirmedWhatsApp(c, {
        phone: row.telefono,
        customerName: row.nombreCliente || 'Cliente',
        restaurantName: row.nombreRestaurante || 'El local',
        total: row.total,
        orderId: pedidoId.toString(),
        demoraMinutos: row.demoraMinutos ?? undefined,
        horarioProgramado: row.horarioProgramado ?? undefined,
    }, creds);

    if (result.success) {
        await db.insert(MensajeWhatsappTable).values({
            pedidoUnificadoId: pedidoId,
            restauranteId,
            telefono: row.telefono,
            tipo: 'pedido_confirmado',
        }).catch((err) => console.error('❌ [Notificar Cliente Pago] Error registrando mensaje:', err));
        console.log(`📲 [Notificar Cliente Pago] ✅ Cliente ${row.telefono} notificado (pedido #${pedidoId})`);
    } else {
        console.error(`📲 [Notificar Cliente Pago] ❌ Error enviando a ${row.telefono} (pedido #${pedidoId}):`, result.error);
    }
};

export interface ClientRecuperoData {
    phone: string;            // teléfono del cliente
    customerName: string;     // {{nombre_cliente}}
    restaurantName: string;   // {{nombre_del_local}}
    tiempoSinPedir: string;   // {{tiempo_sin_pedir}} — ej: "3 semanas"
    productoFavorito: string; // {{producto_favorito}} — ej: "tus Alfajores de maicena"
    incentivo: string;        // {{incentivo}} — la línea del escalón (sin descuento / 10% / 20% con vencimiento)
    usernameTienda: string;   // sufijo dinámico del botón URL (base https://my.piru.app/). Puede
                              // incluir el carrito precargado (4.3): `username?rep=12x2-15x1`.
    imageUrl?: string | null; // header IMAGE (foto del producto favorito → logo del local → default)
}

// Imagen por defecto del header cuando el producto favorito y el local no tienen foto propia.
const RECUPERO_IMAGE_FALLBACK = 'https://my.piru.app/og-image.png';

/**
 * Playbook de recupero de dormidos (Motor de Recompra · tarea 4.2). Envía un mensaje de
 * MARKETING al cliente con la marca del local (requiere sus credenciales de Meta vía OAuth),
 * usando la plantilla `recupero_dormido_v1`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PLANTILLA A CREAR EN META (WhatsApp Manager → Plantillas de mensajes):
 *   • Nombre:        recupero_dormido_v1
 *   • Categoría:     MARKETING
 *   • Idioma:        Español (Argentina) — es_AR
 *   • Encabezado:    IMAGEN (media dinámico; se envía por `link` en cada mensaje).
 *                    Subí una imagen de muestra al crearla (una foto de producto sirve).
 *   • Cuerpo (con variables POSICIONALES {{1}}..{{5}} — así está creada en prod):
 *
 *        ¡Hola {{1}}! 👋
 *
 *        En {{2}} hace {{3}} que no te vemos y se nos antojó tentarte con {{4}}. 😋
 *
 *        {{5}}
 *
 *        Tocá el botón y pedí en segundos 👇
 *
 *     El ORDEN es el contrato (lo respeta el `body.parameters` de abajo):
 *       {{1}} nombre_cliente · {{2}} nombre_del_local · {{3}} tiempo_sin_pedir ·
 *       {{4}} producto_favorito · {{5}} incentivo
 *     Muestras sugeridas: {{1}}=Facundo · {{2}}=Alfajor con Papas · {{3}}=1 semana ·
 *     {{4}}=Alfajor Especial · {{5}}=Y esta vez va con un 10% OFF: usá el código VOLVE10-45 al pedir.
 *   • Botón:         Uno solo, tipo "Visitar sitio web" → URL DINÁMICA.
 *                    Base: https://my.piru.app/    Variable {{1}}: alfajor (el username del local).
 *   • Pie (footer):  NO agregar un pie que instruya "respondé BAJA para no recibir más". El opt-out
 *                    funciona igual sin anunciarlo: si el cliente escribe "BAJA"/"STOP" por su cuenta,
 *                    el webhook lo respeta (ver `procesarComandoOptOut` en `lib/proteccion-base.ts`).
 *                    Dejar el mensaje limpio, sin texto de baja visible para el comensal.
 *
 * NOTA sobre categoría: es MARKETING (no utility) porque es un mensaje proactivo de
 * reactivación. Por eso consume el bucket `marketing` del wallet, no el `utility`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const sendClientRecuperoWhatsApp = async (c: any, data: ClientRecuperoData, creds?: WaCredentials) => {
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
            name: "recupero_dormido_v1",
            language: { code: "es_AR" },
            components: [
                {
                    type: "header",
                    parameters: [
                        { type: "image", image: { link: data.imageUrl || RECUPERO_IMAGE_FALLBACK } }
                    ]
                },
                {
                    type: "body",
                    // La plantilla usa variables POSICIONALES {{1}}..{{5}} (así se creó en Meta).
                    // El orden ES el contrato: {{1}} nombre · {{2}} local · {{3}} tiempo · {{4}} producto · {{5}} incentivo.
                    parameters: [
                        { type: "text", text: data.customerName },   // {{1}}
                        { type: "text", text: data.restaurantName },  // {{2}}
                        { type: "text", text: data.tiempoSinPedir },  // {{3}}
                        { type: "text", text: data.productoFavorito },// {{4}}
                        { type: "text", text: data.incentivo }        // {{5}}
                    ]
                },
                {
                    type: "button",
                    sub_type: "url",
                    index: 0,
                    parameters: [
                        // Sufijo dinámico del botón URL: base https://my.piru.app/ + {{1}} = username del local.
                        { type: "text", text: data.usernameTienda }
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
            console.error("❌ Error WhatsApp API (recupero):", JSON.stringify(result, null, 2));
            return { success: false, error: result };
        }

        console.log("✅ WhatsApp de recupero enviado correctamente");
        return { success: true, id: result.messages?.[0]?.id };

    } catch (error) {
        console.error("❌ Error de red enviando recupero:", error);
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
