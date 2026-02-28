export async function createRestaurantWallet(restaurantId: number, slug: string) {
    const API_KEY = process.env.CUCURU_API_KEY || '';
    const COLLECTOR_ID = process.env.CUCURU_COLLECTOR_ID || '';

    // Paso 1: Llamar al endpoint PUT para crear la cuenta
    const accountRes = await fetch('https://api.cucuru.com/app/v1/Collection/accounts/account', {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'X-Cucuru-Api-Key': API_KEY,
            'X-Cucuru-Collector-id': COLLECTOR_ID
        },
        body: JSON.stringify({
            customer_id: String(restaurantId),
            read_only: 'true'
        })
    });

    if (!accountRes.ok) {
        throw new Error(`Failed to create Cucuru account: ${accountRes.statusText}`);
    }

    const accountData = await accountRes.json();
    const accountNumber = accountData.account_number;

    if (!accountNumber) {
        throw new Error('Account number not returned by Cucuru');
    }

    // Paso 2: Generar alias limpio y llamar al endpoint POST para asignar alias
    const cleanSlug = slug.replace(/[^a-zA-Z0-9.-]/g, '');
    const alias = `piru.${cleanSlug}`;

    let aliasSuccess = true;
    let aliasWarning: string | null = null;

    try {
        const aliasRes = await fetch('https://api.cucuru.com/app/v1/Collection/accounts/account/alias', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Cucuru-Api-Key': API_KEY,
                'X-Cucuru-Collector-id': COLLECTOR_ID
            },
            body: JSON.stringify({
                account_number: accountNumber,
                alias: alias
            })
        });

        if (!aliasRes.ok) {
            aliasSuccess = false;
            aliasWarning = `Failed to set alias: ${aliasRes.status} ${aliasRes.statusText}`;
            console.warn(aliasWarning);
        }
    } catch (err) {
        aliasSuccess = false;
        aliasWarning = err instanceof Error ? err.message : 'Unknown error setting alias';
        console.warn(aliasWarning);
    }

    // Retornar un objeto con los datos para actualizar la DB
    return {
        cucuruCustomerId: String(restaurantId),
        cucuruAccountNumber: accountNumber,
        cucuruAlias: aliasSuccess ? alias : null,
        cucuruEnabled: true,
        warning: aliasWarning
    };
}
