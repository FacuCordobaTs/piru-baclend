import { sql, eq, and } from 'drizzle-orm';
import { accountPool } from '../db/schema';

export async function configurarWebhookCliente(apiKey: string, collectorId: string) {
    try {
        const url = "https://api.cucuru.com/app/v1/Collection/webhooks/endpoint";
        const body = { url: "https://api.piru.app/api/webhook/cucuru/collection_received" };

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Cucuru-Api-Key": apiKey,
                "X-Cucuru-Collector-id": collectorId
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Cucuru API Error: ${response.status} - ${errorText}`);
        }

        return await response.json();
    } catch (error) {
        console.error("Error al configurar webhook en Cucuru:", error);
        throw error;
    }
}

/**
 * Asigna un alias existente o crea uno nuevo on-demand de la cuenta de Cucuru
 * del restaurante. Asegura operaciones consistentes usando transacciones.
 */
export async function asignarAliasAPedido({
    db,
    restaurante,
    pedidoId,
    slug,
    tipoPedido
}: {
    db: any,
    restaurante: any,
    pedidoId: number,
    slug: string,
    tipoPedido: 'delivery' | 'takeaway'
}) {
    if (!restaurante.cucuruApiKey || !restaurante.cucuruCollectorId) {
        throw new Error("El restaurante no tiene configurado Cucuru.");
    }

    const { cucuruApiKey, cucuruCollectorId, id: restauranteId } = restaurante;

    return await db.transaction(async (tx: any) => {
        // Cada pedido obtiene un alias nuevo y exclusivo. Los alias nunca se
        // reciclan para evitar que webhooks duplicados/retrasados de Cucuru
        // acrediten el pedido equivocado.

        // 1. Contar cuántos alias existen en total
        const countQueryRows = await tx
            .select({ count: sql<number>`count(*)` })
            .from(accountPool)
            .where(eq(accountPool.restauranteId, restauranteId));
        const totalAccounts = countQueryRows[0].count;

        if (totalAccounts >= 10000) {
            throw new Error("Límite máximo de 10.000 alias alcanzado para este restaurante.");
        }

        // 3. Crear nuevo CVU en Cucuru
        let newAccountRes;
        try {
            const createCvuRequest = await fetch("https://api.cucuru.com/app/v1/Collection/accounts/account", {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    "X-Cucuru-Api-Key": cucuruApiKey,
                    "X-Cucuru-Collector-id": cucuruCollectorId
                },
                body: JSON.stringify({
                    customer_id: restauranteId.toString()
                })
            });

            if (!createCvuRequest.ok) {
                const err = await createCvuRequest.text();
                throw new Error(`Error creando CVU: ${createCvuRequest.status} ${err}`);
            }

            newAccountRes = await createCvuRequest.json();
        } catch (error) {
            console.error("Error creando cuenta en Cucuru:", error);
            throw new Error("Fallo al crear cuenta CVU virtual en el proveedor.");
        }

        const accountNumber = String(newAccountRes.account_number || '').trim().padStart(22, '0');
        // Construimos el alias con un formato secuencial: piru.[slug].[numero_secuencial]
        const aliasSecuencial = `piru.${slug}.${totalAccounts + 1}`.slice(0, 20); // Asegurar límite de caracteres si aplica según Cucuru

        // 4. Asignar el Alias al nuevo CVU
        try {
            const createAliasRequest = await fetch("https://api.cucuru.com/app/v1/Collection/accounts/account/alias", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Cucuru-Api-Key": cucuruApiKey,
                    "X-Cucuru-Collector-id": cucuruCollectorId
                },
                body: JSON.stringify({
                    account_number: accountNumber,
                    alias: aliasSecuencial
                })
            });

            if (!createAliasRequest.ok) {
                const err = await createAliasRequest.text();
                throw new Error(`Error asignando Alias: ${createAliasRequest.status} ${err}`);
            }
        } catch (error) {
            console.error("Error asignando alias en Cucuru:", error);
            throw new Error("Fallo al asignar alias al nuevo CVU en el proveedor.");
        }

        // 5. Insertar y Asignar la cuenta en la Base de Datos
        await tx.insert(accountPool).values({
            restauranteId,
            accountNumber,
            alias: aliasSecuencial,
            estado: 'asignado',
            pedidoIdAsignado: pedidoId,
            tipoPedido
        });

        return {
            alias: aliasSecuencial,
            accountNumber: accountNumber
        };
    });
}
