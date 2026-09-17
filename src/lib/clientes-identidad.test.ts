import { expect, test } from 'bun:test'
import { construirRosterParticipantes, normalizarNombreComensal, normalizarTelefonoCliente } from './clientes-identidad'
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

test('normaliza el nombre del comensal sin perder identidad por formato', () => {
  expect(normalizarNombreComensal('  José   PÉREZ ')).toBe('jose perez')
  expect(normalizarNombreComensal('Jose Perez')).toBe(normalizarNombreComensal('josé pérez'))
  expect(normalizarNombreComensal('')).toBe('')
  expect(normalizarNombreComensal(null)).toBe('')
})

test('roster de sala: cada participante es un cliente distinto y no se colapsa en el receptor', () => {
  const { participantes } = construirRosterParticipantes([
    { nombre: 'Ana', telefono: '+54 9 341 512-3456' },
    { nombre: 'Bruno', telefono: '0341 15 600-1122' },
    { nombre: 'Ana', telefono: '341 555-0000' },
    { nombre: 'Receptor', telefono: '341 444-9999' },
  ])
  expect(participantes.size).toBe(4)
  expect(participantes.get('5493415123456')).toEqual({ nombre: 'Ana', telefono: '+54 9 341 512-3456' })
  expect(participantes.get('0341156001122')).toEqual({ nombre: 'Bruno', telefono: '0341 15 600-1122' })
  expect(participantes.get('3415550000')?.nombre).toBe('Ana')
})

test('roster de sala: el nombre vincula ítems sin celular y descarta datos incompletos', () => {
  const { participantes, porNombre } = construirRosterParticipantes([
    { nombre: '  Bruno ', telefono: null },
    { nombre: 'Bruno', telefono: '341 600-1122' },
    { nombre: 'Sin celular', telefono: '123' },
    { nombre: null, telefono: '341 777-8888' },
  ])
  expect(porNombre.get('bruno')).toBe('3416001122')
  expect(participantes.size).toBe(1)
  expect(participantes.has('123')).toBe(false)
})

test('roster de sala: el receptor no pisa el celular de un participante homónimo previo', () => {
  const { participantes, porNombre } = construirRosterParticipantes([
    { nombre: 'Ana', telefono: '341 512-3456' },
    { nombre: 'Ana', telefono: '341 999-9999' },
  ])
  expect(participantes.size).toBe(2)
  expect(porNombre.get('ana')).toBe('3415123456')
})

test('roster de sala: un conectado sin ítems presta su celular pero no crea cliente', () => {
  const { participantes, porNombre } = construirRosterParticipantes([
    { nombre: 'Carla', telefono: null },
    { nombre: 'Diego', telefono: '341 700-1122' },
    { nombre: 'Carla', telefono: '341 555-8877', delPedido: false },
  ])
  expect(porNombre.get('carla')).toBe('3415558877')
  expect([...participantes.keys()]).toEqual(['3417001122'])
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
