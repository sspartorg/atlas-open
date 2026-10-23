import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../load-env.js';
import type { Knex } from 'knex';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function databaseUrl(): string {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is required (see .env.example)');
    return url;
}

const config: Knex.Config = {
    client: 'pg',
    connection: databaseUrl(),
    migrations: {
        directory: MIGRATIONS_DIR,
        extension: 'ts',
        loadExtensions: ['.ts'],
        tableName: '_knex_migrations',
    },
    pool: { min: 0, max: 10 },
};

export default config;
