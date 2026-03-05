export async function configurarWebhookCliente(apiKey: string, collectorId: string) {
    try {
        const url = "https://api.cucuru.com/app/v1/Collection/webhooks/endpoint";
        const body = { url: "https://api.piru.app/api/webhooks/cucuru/collection_received" };

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
