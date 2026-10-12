import { describe, expect, test } from 'bun:test'
import {
  demoBloqueaEnAppMarketing,
  demoPuede,
  esProspectoSinReclamar,
  estadoPanelDemo,
  ocultarSecretos,
} from './demo-panel'

const PROSPECTO = { origen: 'outbound', claimedAt: null, telefonoVerificado: false, completedOnboarding: true }

describe('qué tienda abre la demo del panel', () => {
  test('sólo un prospecto que el dueño todavía no reclamó', () => {
    expect(esProspectoSinReclamar(PROSPECTO)).toBe(true)
    expect(esProspectoSinReclamar({ ...PROSPECTO, claimedAt: new Date() })).toBe(false)
    expect(esProspectoSinReclamar({ ...PROSPECTO, telefonoVerificado: true })).toBe(false)
    expect(esProspectoSinReclamar({ ...PROSPECTO, origen: 'self_serve' })).toBe(false)
    expect(esProspectoSinReclamar(null)).toBe(false)
  })

  test('una tienda que se está armando no se muestra', () => {
    expect(estadoPanelDemo(PROSPECTO)).toBe('abierta')
    expect(estadoPanelDemo({ ...PROSPECTO, completedOnboarding: false })).toBe('en_construccion')
    expect(estadoPanelDemo({ ...PROSPECTO, claimedAt: new Date() })).toBe('cerrada')
    expect(estadoPanelDemo({ ...PROSPECTO, origen: 'self_serve', completedOnboarding: true })).toBe('cerrada')
  })
})

describe('lo que la sesión de la demo puede hacer', () => {
  test('puede mirar el panel y operar el servicio, el menú y el marketing', () => {
    for (const [method, path] of [
      ['GET', '/api/restaurante/profile'],
      ['GET', '/api/pedido-unificado/list-dia?dia=2026-10-12&page=1'],
      ['GET', '/api/producto'],
      ['GET', '/api/clientes/indice-pos'],
      ['GET', '/api/datos-ejemplo'],
      ['GET', '/api/modulos/mis-modulos'],
      ['PUT', '/api/pedido-unificado/12/estado'],
      ['PUT', '/api/pedido-unificado/12/pagado'],
      ['DELETE', '/api/pedido-unificado/12'],
      ['POST', '/api/pedido-unificado/create'],
      ['POST', '/api/producto/create'],
      ['PUT', '/api/categoria/update'],
      ['POST', '/api/mesas-locales'],
      ['POST', '/api/zona-delivery/create'],
      ['POST', '/api/marketing/campanas'],
      ['POST', '/api/codigo-descuento/create'],
      ['DELETE', '/api/clientes/7'],
      ['DELETE', '/api/clientes/7/pedidos/4'],
      ['DELETE', '/api/datos-ejemplo'],
      ['POST', '/api/datos-ejemplo'],
      ['PUT', '/api/modulos/crecimiento/activar'],
      ['POST', '/api/marketing-duenio/entrada'],
    ]) {
      expect(demoPuede(method, path), `${method} ${path}`).toBe(true)
    }
  })

  test('no toca lo que redirige pedidos o plata, ni credenciales, accesos o conexiones', () => {
    for (const [method, path] of [
      // Identidad, WhatsApp, alias y medios de pago del local.
      ['PUT', '/api/restaurante/update'],
      ['PUT', '/api/restaurante/metodos-pago'],
      ['PUT', '/api/restaurante/pasarela-pago'],
      ['POST', '/api/restaurante/configurar-talo'],
      ['PUT', '/api/restaurante/toggle-whatsapp-enabled'],
      ['POST', '/api/sucursales/create'],
      ['PUT', '/api/sucursales/3'],
      // Credenciales y accesos que quedarían después de la demo.
      ['PUT', '/api/auth/change-password'],
      ['POST', '/api/staff/usuarios'],
      ['POST', '/api/mi-marketer'],
      ['DELETE', '/api/mi-marketer'],
      // Conexiones con terceros, facturación y plata.
      ['POST', '/api/whatsapp-oauth/connect'],
      ['POST', '/api/mp/desconectar'],
      ['POST', '/api/pos-qr/conexion/iniciar'],
      ['POST', '/api/facturacion/configurar'],
      ['POST', '/api/suscripcion/checkout'],
      ['POST', '/api/planes/suscribir'],
      ['POST', '/api/mensajes/recarga/checkout'],
      ['POST', '/api/modulos/motor_recompra/checkout'],
      ['PUT', '/api/modulos/motor_recompra/desactivar'],
      ['POST', '/api/modulos/motor_recompra/pago-link-whatsapp'],
      ['POST', '/api/carta-ia/extraer'],
      // Mensajes que salen del número de Piru o de un tercero.
      ['POST', '/api/pedido-unificado/5/notificar-cliente'],
      ['POST', '/api/pedido-unificado/5/confirmar-con-demora'],
      ['POST', '/api/pedido-unificado/rapiboy/asignar'],
      ['POST', '/api/marketing/enlaces/4/enviar-whatsapp'],
      // La construcción de tiendas es del fundador.
      ['POST', '/api/onboarding/terminar-alta'],
      ['POST', '/api/onboarding/iniciar-prueba'],
      ['PUT', '/api/onboarding/complete'],
      ['POST', '/api/interno/locales/1/acceso-temporal'],
    ]) {
      expect(demoPuede(method, path), `${method} ${path}`).toBe(false)
    }
  })

  test('tampoco lee la operación interna ni las cuentas de otros', () => {
    for (const path of [
      '/api/interno/locales',
      '/api/onboarding/algo',
      '/api/staff/usuarios',
      '/api/facturacion/estado',
      '/api/marketer/locales',
    ]) {
      expect(demoPuede('GET', path), path).toBe(false)
    }
  })

  test('rechaza rutas ambiguas en lugar de normalizarlas a una permitida', () => {
    for (const [method, path] of [
      ['GET', '/api/pedido-unificado/../interno/locales'],
      ['PUT', '/api/pedido-unificado/%2e%2e/restaurante/update'],
      ['GET', '/api//restaurante/profile'],
      ['HEAD', '/api/restaurante/profile'],
      ['GET', '/restaurante/profile'],
      ['PUT', '/api/marketing-duenio/sesion'],
      // `marketing-` no es el prefijo `marketing/`.
      ['POST', '/api/marketing-interno/campanas'],
    ]) {
      expect(demoPuede(method, path), `${method} ${path}`).toBe(false)
    }
  })

  test('dentro de la app de marketing, además, no cobra ni manda mensajes desde Piru', () => {
    expect(demoBloqueaEnAppMarketing('POST', '/api/modulos/motor_recompra/checkout')).toBe(true)
    expect(demoBloqueaEnAppMarketing('POST', '/api/modulos/motor_recompra/pago-link-whatsapp')).toBe(true)
    expect(demoBloqueaEnAppMarketing('POST', '/api/marketing/enlaces/4/enviar-whatsapp')).toBe(true)
    expect(demoBloqueaEnAppMarketing('GET', '/api/clientes/list')).toBe(false)
    expect(demoBloqueaEnAppMarketing('POST', '/api/marketing/campanas')).toBe(false)
    expect(demoBloqueaEnAppMarketing('GET', '/api/%2e%2e/interno')).toBe(true)
  })
})

describe('las credenciales no salen en las respuestas de la demo', () => {
  test('oculta claves secretas en cualquier nivel y conserva la forma', () => {
    const respuesta = {
      success: true,
      data: {
        restaurante: {
          id: 6,
          nombre: 'Brasa',
          password: '$2b$10$hash',
          claimToken: 'abc123',
          claimTokenExpira: '2026-10-20',
          mpAccessToken: 'APP_USR-secreto',
          whatsappAccessToken: 'EAAG',
          rapiboyToken: 'rb',
          afipClaveFiscal: 'x',
          mpConnected: true,
          creado: new Date('2026-10-01T00:00:00Z'),
        },
        sucursales: [{ id: 1, nombre: 'Centro', rapiboyToken: 'otro', activo: true }],
      },
    }
    const copia = JSON.parse(JSON.stringify(respuesta))
    const limpia = ocultarSecretos(respuesta) as typeof respuesta
    expect(limpia.data.restaurante).toMatchObject({
      id: 6,
      nombre: 'Brasa',
      password: null,
      claimToken: null,
      claimTokenExpira: null,
      mpAccessToken: null,
      whatsappAccessToken: null,
      rapiboyToken: null,
      afipClaveFiscal: null,
      mpConnected: true,
    })
    expect(limpia.data.restaurante.creado).toEqual(new Date('2026-10-01T00:00:00Z'))
    expect(limpia.data.sucursales[0]).toEqual({ id: 1, nombre: 'Centro', rapiboyToken: null as unknown as string, activo: true })
    // No muta el original.
    expect(JSON.parse(JSON.stringify(respuesta))).toEqual(copia)
  })

  test('deja pasar valores simples', () => {
    expect(ocultarSecretos(null)).toBeNull()
    expect(ocultarSecretos('hola')).toBe('hola')
    expect(ocultarSecretos([1, { token: 'x' }])).toEqual([1, { token: 'x' }])
  })
})
