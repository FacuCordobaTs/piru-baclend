import { describe, expect, test } from 'bun:test'
import { canalDelNumero, mismoNumero, numeroDelLocal, puntosEnvio, resolverPunto, type DatosPuntosEnvio } from './recompra-puntos'

const sucursal = (id: number, numero: string | null, extra: Partial<DatosPuntosEnvio['sucursales'][number]> = {}) => ({
  id, nombre: `Sede ${id}`, activo: true, soloPos: false, whatsappEnabled: numero != null, whatsappNumber: numero, ...extra,
})
const base = (extra: Partial<DatosPuntosEnvio> = {}): DatosPuntosEnvio => ({
  nombreLocal: 'Local', whatsappNumber: '+54 9 341 555 0000', whatsappPhoneId: null, sucursales: [], pedidosSinSucursal: 0, ...extra,
})

describe('puntos de envío', () => {
  test('sin sucursales con número, un solo punto que mira toda la base', () => {
    const puntos = puntosEnvio(base({ sucursales: [sucursal(1, null)] }), false)
    expect(puntos.map((p) => p.alcance)).toEqual(['todo'])
    expect(resolverPunto(puntos)).toEqual({ punto: puntos[0] })
  })

  test('con sucursales con número hay que elegir; las sedes de eventos no cuentan', () => {
    const puntos = puntosEnvio(base({
      sucursales: [sucursal(1, '3415551111'), sucursal(2, '3415552222'), sucursal(3, '3415553333', { soloPos: true })],
    }), false)
    expect(puntos.map((p) => p.sucursalId)).toEqual([1, 2])
    expect('error' in resolverPunto(puntos) && resolverPunto(puntos)).toMatchObject({ error: { code: 'elegir_sucursal' } })
    expect(resolverPunto(puntos, { sucursalId: 2 })).toEqual({ punto: puntos[1] })
    expect(resolverPunto(puntos, { sucursalId: 99 })).toMatchObject({ error: { status: 404 } })
  })

  test('Alfajor: número sólo en comprobantes, Meta conectada y avisos → punto local automático', () => {
    const numero = numeroDelLocal({ whatsappNumber: null, comprobantesWhatsapp: '543426319272', telefono: null })
    const puntos = puntosEnvio(base({ whatsappNumber: numero, whatsappPhoneId: '1271223376070494' }), true)
    expect(puntos).toHaveLength(1)
    expect(puntos[0]).toMatchObject({ alcance: 'todo', numero: '543426319272', canal: 'api', motivo: null })
    expect(resolverPunto(puntos)).toEqual({ punto: puntos[0] })
  })

  test('sin número cargado, el local igual puede mandar a mano', () => {
    const puntos = puntosEnvio(base({ whatsappNumber: null }), false)
    expect(puntos).toHaveLength(1)
    expect(puntos[0]).toMatchObject({ alcance: 'todo', numero: null, canal: 'manual', motivo: null })
    expect(resolverPunto(puntos)).toEqual({ punto: puntos[0] })
  })

  test('el número del local sale de la primera columna legacy con algo (caso Alfajor)', () => {
    // Alfajor tiene whatsapp_number y telefono en NULL y el número en comprobantes_whatsapp.
    expect(numeroDelLocal({ whatsappNumber: null, comprobantesWhatsapp: '543426319272', telefono: null }))
      .toBe('543426319272')
    expect(numeroDelLocal({ whatsappNumber: '  ', comprobantesWhatsapp: '543426319272', telefono: null }))
      .toBe('543426319272')
    expect(numeroDelLocal({ whatsappNumber: null, comprobantesWhatsapp: null, telefono: '+54 9 342 631 9272' }))
      .toBe('+54 9 342 631 9272')
    expect(numeroDelLocal({ whatsappNumber: null, comprobantesWhatsapp: null, telefono: null })).toBeNull()
  })

  test('sin número el punto del local sale manual aunque tenga Meta conectada', () => {
    // El envío por Meta vuelve a chequear el número de la tanda contra el del local; sin
    // número no hay forma de mandarlo automático, pero la tanda se arma igual.
    const puntos = puntosEnvio(base({ whatsappNumber: null, whatsappPhoneId: 'pid' }), true)
    expect(puntos[0]).toMatchObject({ numero: null, canal: 'manual', motivo: null })
  })

  test('el local suma como punto sólo si quedaron pedidos sin sucursal', () => {
    const puntos = puntosEnvio(base({ sucursales: [sucursal(1, '3415551111')], pedidosSinSucursal: 3 }), false)
    expect(puntos.map((p) => p.alcance)).toEqual(['sucursal', 'local'])
  })

  test('el punto del local no exige número cuando hay sucursales con número', () => {
    const puntos = puntosEnvio(base({
      whatsappNumber: null,
      sucursales: [sucursal(1, '3415551111')],
      pedidosSinSucursal: 3,
    }), false)
    expect(puntos.map((p) => p.alcance)).toEqual(['sucursal', 'local'])
    expect(puntos[1]).toMatchObject({ numero: null, motivo: null, canal: 'manual' })
  })

  test('sucursal inactiva o sin número se devuelve marcada y no se puede elegir', () => {
    const puntos = puntosEnvio(base({ sucursales: [sucursal(1, '3415551111'), sucursal(2, null), sucursal(3, '3415553333', { activo: false })] }), false)
    expect(puntos.map((p) => p.motivo)).toEqual([null, 'sin_numero', 'inactiva'])
    expect(resolverPunto(puntos)).toEqual({ punto: puntos[0] })
    expect(resolverPunto(puntos, { sucursalId: 2 })).toMatchObject({ error: { code: 'sucursal_sin_numero' } })
  })

  test('el envío automático sale sólo desde el número conectado a Meta', () => {
    const local = { whatsappNumber: '+54 9 341 555 1111', whatsappPhoneId: 'pid' }
    expect(mismoNumero('3415551111', '+5493415551111')).toBe(true)
    expect(canalDelNumero('3415551111', local, true)).toBe('api')
    expect(canalDelNumero('3415552222', local, true)).toBe('manual')
    expect(canalDelNumero('3415551111', local, false)).toBe('manual')
  })
})
