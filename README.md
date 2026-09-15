# Backend de Piru

API multi-tenant en Bun + Hono, MySQL y Drizzle. Monta REST bajo `/api`, WebSockets bajo `/ws` y jobs periódicos desde `src/index.ts`.

Antes de cambiar un dominio, usar el mapa raíz [`../AGENTS.md`](../AGENTS.md). Arquitectura, datos, migraciones y despliegue están en [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) y [`../docs/DATABASE_AND_DEPLOYMENT.md`](../docs/DATABASE_AND_DEPLOYMENT.md).

```bash
bun install
bun run dev
bun test
```

No hay scripts `build` ni `lint`. Para validar el bundle: `bun build src/index.ts --target=bun --outdir <directorio-temporal>`.

Modificar `src/db/schema.ts` exige una migración SQL aditiva en `migrations/`. La existencia de una migración no prueba que esté aplicada.
