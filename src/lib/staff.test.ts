import { expect, test } from 'bun:test'
import {
  extraerTelefonoArgentino10,
  formatearParaWhatsApp,
  telefonosCoinciden,
} from './staff'

test('extraerTelefonoArgentino10 extrae los 10 dígitos nacionales en todos los formatos', () => {
  expect(extraerTelefonoArgentino10('+54 9 341 512-3456')).toBe('3415123456')
  expect(extraerTelefonoArgentino10('5491123456789')).toBe('1123456789')
  expect(extraerTelefonoArgentino10('5493511234567')).toBe('3511234567')

  expect(extraerTelefonoArgentino10('+54 341 512 3456')).toBe('3415123456')
  expect(extraerTelefonoArgentino10('541123456789')).toBe('1123456789')

  expect(extraerTelefonoArgentino10('9 351 123 4567')).toBe('3511234567')

  expect(extraerTelefonoArgentino10('0341 15 512 3456')).toBe('3415123456')
  expect(extraerTelefonoArgentino10('011 15 2345 6789')).toBe('1123456789')
  expect(extraerTelefonoArgentino10('03476 15 123456')).toBe('3476123456')

  expect(extraerTelefonoArgentino10('0341 512 3456')).toBe('3415123456')
  expect(extraerTelefonoArgentino10('011 2345 6789')).toBe('1123456789')

  expect(extraerTelefonoArgentino10('341 512 3456')).toBe('3415123456')
  expect(extraerTelefonoArgentino10('11 2345 6789')).toBe('1123456789')
  expect(extraerTelefonoArgentino10('3511234567')).toBe('3511234567')

  expect(extraerTelefonoArgentino10(null)).toBeNull()
  expect(extraerTelefonoArgentino10(undefined)).toBeNull()
  expect(extraerTelefonoArgentino10('')).toBeNull()
  expect(extraerTelefonoArgentino10('1234')).toBeNull()
})

test('formatearParaWhatsApp asegura formato 549 + 10 dígitos para Meta', () => {
  expect(formatearParaWhatsApp('341 512 3456')).toBe('5493415123456')
  expect(formatearParaWhatsApp('+54 9 341 512 3456')).toBe('5493415123456')
  expect(formatearParaWhatsApp('0341 15 512 3456')).toBe('5493415123456')
  expect(formatearParaWhatsApp('543415123456')).toBe('5493415123456')
  expect(formatearParaWhatsApp('9 351 123 4567')).toBe('5493511234567')
})

test('telefonosCoinciden reconoce equivalencias entre formatos variados', () => {
  expect(telefonosCoinciden('341 512 3456', '+54 9 341 512-3456')).toBe(true)
  expect(telefonosCoinciden('543415123456', '5493415123456')).toBe(true)
  expect(telefonosCoinciden('0341 15 512 3456', '3415123456')).toBe(true)
  expect(telefonosCoinciden('9 351 123 4567', '351 123 4567')).toBe(true)
  expect(telefonosCoinciden('+5491123456789', '11 2345 6789')).toBe(true)

  expect(telefonosCoinciden('341 512 3456', '341 512 3457')).toBe(false)
  expect(telefonosCoinciden('341 512 3456', '11 512 3456')).toBe(false)
  expect(telefonosCoinciden('341 512 3456', null)).toBe(false)
  expect(telefonosCoinciden(null, undefined)).toBe(false)
})
