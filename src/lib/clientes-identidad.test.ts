import { expect, test } from 'bun:test'
import { normalizarTelefonoCliente } from './clientes-identidad'
import { sentenciasMigracion } from './pos-mantenimiento'

test('normalización conservadora: conserva prefijos 54, 9, 0 y 15', () => {
  expect(normalizarTelefonoCliente('+54 (9) 341-512-3456')).toBe('5493415123456')
  expect(normalizarTelefonoCliente('0341 15 5123456')).toBe('0341155123456')
  expect(normalizarTelefonoCliente('341 5123456')).toBe('3415123456')
  expect(normalizarTelefonoCliente('0341 15 5123456')).not.toBe(normalizarTelefonoCliente('+54 9 341 5123456'))
})
test('no crea identidad con vacíos, números cortos o más de 20 dígitos', () => {
  for (const valor of [undefined, null, '', 'Sin celular', '1234567', '1'.repeat(21)]) expect(normalizarTelefonoCliente(valor)).toBeNull()
  expect(normalizarTelefonoCliente('12345678')).toBe('12345678')
  expect(normalizarTelefonoCliente('1'.repeat(20))).toBe('1'.repeat(20))
})
test('lector SQL preserva el cuerpo del procedimiento y sus guardas', async () => {
  for (const archivo of ['add_pos_offline_clientes.sql', 'unique_cliente_telefono_normalizado.sql']) {
    const statements = sentenciasMigracion(await Bun.file(new URL('../../migrations/' + archivo, import.meta.url)).text())
    expect(statements.some(s => s.includes('CREATE PROCEDURE') && s.includes('END IF;'))).toBe(true)
    expect(statements.some(s => /DELIMITER/.test(s))).toBe(false)
    expect(statements.some(s => s.startsWith('CALL '))).toBe(true)
  }
  expect(() => sentenciasMigracion('SELECT 1')).toThrow()
})
