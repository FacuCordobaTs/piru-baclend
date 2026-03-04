import { defineConfig } from 'drizzle-kit';
import 'dotenv/config';

export default defineConfig({
    schema: './src/db/schema.ts',
    out: './migrations',
    dialect: 'mysql',
    dbCredentials: {
        url: `mysql://${process.env.DB_USER || 'root'}:${process.env.DB_PASSWORD || ''}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '3306'}/${process.env.DB_NAME || 'piru'}`,
    },
});
