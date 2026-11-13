import { describe, expect, test } from 'bun:test'
import {
  anioArgentina,
  domingoDePascua,
  esFechaISO,
  esFeriadoNacional,
  feriadosNacionales,
  tipoDeDia,
} from './feriados-ar'

const fechas = (anio: number) => feriadosNacionales(anio).map((f) => f.fecha)

describe('feriados nacionales de Argentina', () => {
  test('la Pascua sale bien en años conocidos', () => {
    expect(domingoDePascua(2024)).toBe('2024-03-31')
    expect(domingoDePascua(2025)).toBe('2025-04-20')
    expect(domingoDePascua(2026)).toBe('2026-04-05')
    expect(domingoDePascua(2027)).toBe('2027-03-28')
  })

  test('Carnaval y Viernes Santo derivan de la Pascua', () => {
    const f2026 = fechas(2026)
    expect(f2026).toContain('2026-02-16')
    expect(f2026).toContain('2026-02-17')
    expect(f2026).toContain('2026-04-03')

    const f2025 = fechas(2025)
    expect(f2025).toContain('2025-03-03')
    expect(f2025).toContain('2025-03-04')
    expect(f2025).toContain('2025-04-18')
  })

  test('incluye los inamovibles y ordena por fecha', () => {
    const lista = feriadosNacionales(2026)
    const soloFechas = lista.map((f) => f.fecha)
    expect(soloFechas).toContain('2026-01-01')
    expect(soloFechas).toContain('2026-03-24')
    expect(soloFechas).toContain('2026-04-02')
    expect(soloFechas).toContain('2026-05-01')
    expect(soloFechas).toContain('2026-05-25')
    expect(soloFechas).toContain('2026-06-20')
    expect(soloFechas).toContain('2026-07-09')
    expect(soloFechas).toContain('2026-12-08')
    expect(soloFechas).toContain('2026-12-25')
    expect([...soloFechas].sort()).toEqual(soloFechas)
    expect(new Set(soloFechas).size).toBe(soloFechas.length)
  })

  test('traslada 17/8, 12/10 y 20/11 al lunes que corresponde', () => {
    // 2026-11-20 es viernes: pasa al lunes 23.
    expect(fechas(2026)).toContain('2026-11-23')
    expect(fechas(2026)).not.toContain('2026-11-20')
    // 2027-10-12 es martes: pasa al lunes 11.
    expect(fechas(2027)).toContain('2027-10-11')
    // 2027-08-17 es martes: pasa al lunes 16.
    expect(fechas(2027)).toContain('2027-08-16')
  })

  test('reconoce un feriado y distingue fin de semana de hábil', () => {
    expect(esFeriadoNacional('2026-08-17')).toBe(true)
    expect(esFeriadoNacional('2026-08-18')).toBe(false)
    expect(tipoDeDia('2026-08-17')).toBe('feriado')
    expect(tipoDeDia('2026-08-15')).toBe('fin_de_semana') // sábado
    expect(tipoDeDia('2026-08-16')).toBe('fin_de_semana') // domingo
    expect(tipoDeDia('2026-08-18')).toBe('habil') // martes
  })

  test('los feriados propios del local tienen prioridad', () => {
    expect(tipoDeDia('2026-08-18', new Set(['2026-08-18']))).toBe('feriado')
    // Un feriado propio en sábado se paga como feriado, no como fin de semana.
    expect(tipoDeDia('2026-08-15', new Set(['2026-08-15']))).toBe('feriado')
  })

  test('valida fechas ISO reales', () => {
    expect(esFechaISO('2026-02-29')).toBe(false)
    expect(esFechaISO('2024-02-29')).toBe(true)
    expect(esFechaISO('2026-13-01')).toBe(false)
    expect(esFechaISO('17/08/2026')).toBe(false)
  })

  test('el año argentino no depende del reloj UTC', () => {
    // 1 de enero 2027 02:00 UTC = 31 de diciembre 2026 23:00 en Argentina.
    expect(anioArgentina(new Date('2027-01-01T02:00:00Z'))).toBe(2026)
  })
})
