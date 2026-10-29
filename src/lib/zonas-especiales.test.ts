import { describe, expect, test } from 'bun:test'
import {
  estadoVentanaZona,
  horarioValido,
  mensajeLlegadaZona,
  minutosDeHora,
  normalizarHora,
  puedePedirZonaEspecial,
  telefonoWaMe,
  ventanaDeEntrega,
} from './zonas-especiales'

const zona = { horaInicio: '17:00', horaFin: '20:00', activa: true }
const dia = (hora: number, minuto = 0) => new Date(2026, 9, 28, hora, minuto, 0, 0)

describe('horas de zona especial', () => {
  test('valida y normaliza HH:mm', () => {
    expect(minutosDeHora('17:30')).toBe(1050)
    expect(minutosDeHora('24:00')).toBeNull()
    expect(normalizarHora('7:05')).toBe('07:05')
    expect(normalizarHora('17:00:00')).toBe('17:00')
    expect(horarioValido(zona)).toBe(true)
    expect(horarioValido({ horaInicio: '17:00', horaFin: '' })).toBe(false)
  })

  test('antes de la ventana devuelve la de hoy', () => {
    const v = ventanaDeEntrega(zona, dia(15))
    expect(v.inicio.getDate()).toBe(28)
    expect(v.inicio.getHours()).toBe(17)
    expect(v.fin.getHours()).toBe(20)
    expect(v.esHoy).toBe(true)
  })

  test('dentro de la ventana devuelve la vigente', () => {
    const estado = estadoVentanaZona(zona, dia(18))
    expect(estado.enVentana).toBe(true)
    expect(estado.ventana.etiqueta).toBe('Hoy de 17:00 a 20:00')
  })

  test('después de la ventana devuelve la de mañana', () => {
    const estado = estadoVentanaZona(zona, dia(21))
    expect(estado.enVentana).toBe(false)
    expect(estado.ventana.inicio.getDate()).toBe(29)
    expect(estado.ventana.esManana).toBe(true)
  })

  test('una ventana que cruza medianoche sigue vigente de madrugada', () => {
    const nocturna = { horaInicio: '20:00', horaFin: '02:00' }
    const estado = estadoVentanaZona(nocturna, dia(1))
    expect(estado.enVentana).toBe(true)
    expect(estado.ventana.inicio.getDate()).toBe(27)
  })
})

describe('pre-pedidos de zona especial', () => {
  test('dentro de la ventana se pide sin pre-orden', () => {
    const resultado = puedePedirZonaEspecial(zona, {
      ahora: dia(18),
      pedidosPreOrdenadosHabilitados: false,
    })
    expect(resultado).toMatchObject({ permitido: true, esPreOrden: false })
  })

  test('fuera de la ventana exige la opción de pre-pedidos', () => {
    expect(puedePedirZonaEspecial(zona, {
      ahora: dia(21),
      pedidosPreOrdenadosHabilitados: false,
    })).toMatchObject({ permitido: false, motivo: 'fuera_de_ventana' })

    expect(puedePedirZonaEspecial(zona, {
      ahora: dia(21),
      pedidosPreOrdenadosHabilitados: true,
    })).toMatchObject({ permitido: true, esPreOrden: true })
  })

  test('con el local cerrado sólo se pide si hay pre-pedidos', () => {
    expect(puedePedirZonaEspecial(zona, {
      ahora: dia(18),
      localCerrado: true,
      pedidosPreOrdenadosHabilitados: false,
    })).toMatchObject({ permitido: false })

    expect(puedePedirZonaEspecial(zona, {
      ahora: dia(18),
      localCerrado: true,
      pedidosPreOrdenadosHabilitados: true,
    })).toMatchObject({ permitido: true, esPreOrden: true })
  })

  test('una zona inactiva nunca acepta pedidos', () => {
    expect(puedePedirZonaEspecial({ ...zona, activa: false }, {
      ahora: dia(18),
      pedidosPreOrdenadosHabilitados: true,
    })).toMatchObject({ permitido: false, motivo: 'inactiva' })
  })
})

describe('aviso de llegada', () => {
  test('arma el texto manual sin datos sensibles de más', () => {
    expect(mensajeLlegadaZona({
      nombreCliente: 'Martina',
      nombreZona: 'Country Los Aromos',
      nombreLocal: 'Alfajor',
    })).toBe('Hola Martina, tu pedido de Alfajor ya está en la puerta de Country Los Aromos esperándote. ¡Te esperamos!')
  })

  test('normaliza el teléfono para wa.me', () => {
    expect(telefonoWaMe('+54 9 342 555-1234')).toBe('5493425551234')
    expect(telefonoWaMe('123')).toBeNull()
  })
})
