import { describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/mysql2'
import { createConnection } from 'mysql2/promise'
import { mpConexionQr } from '../db/schema'
import { crearRepositorioConexionQr } from './mp-conexion-qr-db'
import { LOCAL, SCOPE_QR_EXTENSO, T0 } from './mp-conexion-qr.fakes'

test('el schema admite los permisos extensos de OAuth sin el límite histórico de 255', () => {
  const tipo = mpConexionQr.scope.getSQLType().toLowerCase()
  const capacidad = tipo === 'text' ? 65_535 : Number(tipo.match(/^varchar\((\d+)\)$/)?.[1] ?? 0)
  expect(capacidad).toBeGreaterThanOrEqual(Buffer.byteLength(SCOPE_QR_EXTENSO))
})

// Opt-in: una conexión exclusiva y tablas TEMPORARY que desaparecen al cerrarla.
// No modifica tablas persistentes ni utiliza las credenciales DB_* del runtime.
describe.skipIf(!process.env.MP_QR_TEST_MYSQL_URL)('persistencia OAuth con MySQL real', () => {
  test('reproduce el fallo histórico y migra para insertar, reconectar y renovar scopes completos', async () => {
    const conexion = await createConnection(process.env.MP_QR_TEST_MYSQL_URL!)
    try {
      await conexion.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES'")
      const historica = await Bun.file(new URL('../../migrations/add_mp_conexion_qr.sql', import.meta.url)).text()
      const ddl = historica.match(/^CREATE TABLE IF NOT EXISTS[\s\S]+$/m)?.[0]
      if (!ddl) throw new Error('Falta el DDL histórico de mp_conexion_qr')
      const temporal = ddl
        .replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMPORARY TABLE')
        // MySQL no admite FK en tablas temporales. El resto es el DDL histórico sin cambios.
        .replace(/,\s*CONSTRAINT[\s\S]+?\n\);/, '\n);')
      if (!temporal.startsWith('CREATE TEMPORARY TABLE') || temporal.includes('CONSTRAINT')) throw new Error('Fixture temporal inválida')
      await conexion.query(temporal)
      const repo = crearRepositorioConexionQr(drizzle(conexion))
      const tokens = {
        accessToken: 'TOKEN-FICTICIO', refreshToken: 'TG-FICTICIO', mpUserId: '555',
        scope: 'read write offline_access', liveMode: true, expiraAt: new Date(T0.getTime() + 15_552_000_000),
      }
      await repo.guardar(LOCAL, tokens, T0)
      const extensos = { ...tokens, scope: SCOPE_QR_EXTENSO }
      const error = await repo.guardar(LOCAL, extensos, T0).then(() => null, (e: unknown) => e)
      expect(error).toMatchObject({ cause: { code: 'ER_DATA_TOO_LONG', errno: 1406 } })
      expect((await repo.leer(LOCAL))?.scope).toBe(tokens.scope)

      const migracion = await Bun.file(new URL('../../migrations/widen_mp_conexion_qr_scope.sql', import.meta.url)).text()
      const alter = migracion.match(/ALTER TABLE[\s\S]+?;/)?.[0]
      if (!alter) throw new Error('Falta la ampliación de scope en la migración')
      await conexion.query(alter)
      await repo.guardar(LOCAL, extensos, T0)
      await repo.guardar(LOCAL + 1, extensos, T0)
      expect((await repo.leer(LOCAL))?.scope).toBe(SCOPE_QR_EXTENSO)
      expect((await repo.leer(LOCAL + 1))?.scope).toBe(SCOPE_QR_EXTENSO)

      const scopeRenovado = `${SCOPE_QR_EXTENSO} urn:global:admin:oauth:/read-write`
      expect(await repo.renovar(LOCAL, tokens.accessToken, async () => ({
        ...extensos, accessToken: 'RENOVADO-FICTICIO', refreshToken: 'TG-RENOVADO-FICTICIO', scope: scopeRenovado,
      }), T0)).toBe('RENOVADO-FICTICIO')
      expect((await repo.leer(LOCAL))?.scope).toBe(scopeRenovado)
    } finally {
      await conexion.end()
    }
  })
})
