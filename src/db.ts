import { createPool } from 'mysql2/promise';

// Argentina UTC-3: timestamps en la API se devuelven correctos para el Dashboard y comandas
const TZ_ARGENTINA = '-03:00';

export const pool = createPool({
  host: 'localhost',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: TZ_ARGENTINA,
});

// Verificar si el servidor se inició correctamente
pool
  .getConnection()
  .then(async (connection) => {
    await connection.query(`SET time_zone = '${TZ_ARGENTINA}'`);
    console.log('Conexión a la base de datos establecida correctamente.');
    connection.release();
  })
  .catch((err) => {
    console.error('Error al conectar a la base de datos:', err);
  });
