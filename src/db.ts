import { createPool } from 'mysql2/promise';

// Argentina UTC-3: timestamps en la API se devuelven correctos para el Dashboard y comandas
const TZ_ARGENTINA = '-03:00';

const rawPool = createPool({
  host: 'localhost',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: TZ_ARGENTINA,
});

async function withTzConnection<T>(fn: (conn: Awaited<ReturnType<typeof rawPool.getConnection>>) => Promise<T>): Promise<T> {
  const conn = await rawPool.getConnection();
  try {
    await conn.query(`SET time_zone = '${TZ_ARGENTINA}'`);
    return await fn(conn);
  } finally {
    conn.release();
  }
}

// Wrapper: ejecuta SET time_zone en cada conexión antes de usarla (evita horarios 3h atrasados)
export const pool = {
  getConnection: () =>
    rawPool.getConnection().then(async (conn) => {
      await conn.query(`SET time_zone = '${TZ_ARGENTINA}'`);
      return conn;
    }),
  query: (sql: any, args?: any) =>
    withTzConnection((conn) => conn.query(sql, args)),
  execute: (sql: any, args?: any) =>
    withTzConnection((conn) => conn.execute(sql, args)),
  end: rawPool.end.bind(rawPool),
};

// Verificar si el servidor se inició correctamente
rawPool.getConnection()
  .then(async (connection) => {
    await connection.query(`SET time_zone = '${TZ_ARGENTINA}'`);
    console.log('Conexión a la base de datos establecida correctamente.');
    connection.release();
  })
  .catch(err => {
    console.error('Error al conectar a la base de datos:', err);
  });