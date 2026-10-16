import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema/core.js';

export type Db = MySql2Database<typeof schema>;

type ErrorLog = (obj: object, msg: string) => void;
type RawConnection = { query(sql: string, cb: (err: Error | null) => void): unknown };

const consoleError: ErrorLog = (obj, msg) => console.error(msg, obj);

/**
 * Réglage UTC de chaque nouvelle connexion du pool. L'erreur éventuelle est journalisée (jamais d'événement 'error'
 * non géré) ; la requête suivante sur une connexion cassée échouera normalement.
 */
export function initPoolConnection(conn: RawConnection, logError: ErrorLog = consoleError): void {
  conn.query("SET time_zone = '+00:00'", (err) => {
    if (err) logError({ err }, 'échec du réglage du fuseau UTC sur une connexion MariaDB');
  });
}

export function createDb(url: string): { db: Db; close(): Promise<void> } {
  const pool = mysql.createPool({
    uri: url,
    timezone: 'Z',
    dateStrings: false,
    connectionLimit: 10,
    waitForConnections: true,
  });
  // Les défauts CURRENT_TIMESTAMP(3) et NOW() doivent être en UTC quel que soit le réglage du serveur.
  pool.pool.on('connection', (conn) => initPoolConnection(conn as unknown as RawConnection));
  const db = drizzle(pool, { schema, mode: 'default' });
  return { db, close: () => pool.end() };
}

/** Pool mysql2 sous-jacent (connexion dédiée : verrous nommés, etc.). */
export function poolOf(db: Db): mysql.Pool {
  return (db as unknown as { $client: mysql.Pool }).$client;
}
