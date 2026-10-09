import { describe, expect, test } from 'bun:test'
import type { Pool } from 'mysql2/promise'
import { COOLDOWN_ALFAJOR_MS, crearRespuestaAlfajor, RESPUESTA_ALFAJOR, restauranteDeAtencionWhatsApp } from './whatsapp-alfajor'

describe('enrutado del número de WhatsApp', () => {
  const prueba = { id: 1, token: 'token-prueba' }
  const alfajor = { id: 6, token: 'token-alfajor' }

  test('el número compartido para debug usa Alfajor, independientemente del orden de DB', () => {
    expect(restauranteDeAtencionWhatsApp([prueba, alfajor])).toBe(alfajor)
    expect(restauranteDeAtencionWhatsApp([alfajor, prueba])).toBe(alfajor)
  })

  test('la excepción de debug no mezcla la atención de otros locales', () => {
    expect(restauranteDeAtencionWhatsApp([alfajor, { id: 7, token: 'otro' }])).toBeUndefined()
    expect(restauranteDeAtencionWhatsApp([prueba, alfajor, { id: 7, token: 'otro' }])).toBeUndefined()
    expect(restauranteDeAtencionWhatsApp([prueba, { id: 7, token: 'otro' }])).toBeUndefined()
  })

  test('un número exclusivo conserva su local, incluido Piru Prueba', () => {
    expect(restauranteDeAtencionWhatsApp([prueba])).toBe(prueba)
    expect(restauranteDeAtencionWhatsApp([alfajor])).toBe(alfajor)
    expect(restauranteDeAtencionWhatsApp([])).toBeUndefined()
  })
})

const consulta = {
  restauranteId: 6, telefono: '5493511234567', phoneNumberId: 'numero-propio-alfajor', token: 'token-propio-alfajor',
}

// Las conversaciones y locks se comparten aun al recrear el servicio.
function entorno() {
  const locks = new Set<string>()
  const conversaciones: { telefono: string; fecha: number; mensajes: any[] }[] = []
  let liberadas = 0
  const pool = {
    async getConnection() {
      return {
        async query(sql: string, parametros: any[]) {
          if (sql.includes('GET_LOCK')) {
            if (locks.has(parametros[0])) return [[{ adquirido: 0 }]]
            locks.add(parametros[0])
            return [[{ adquirido: 1 }]]
          }
          if (sql.includes('RELEASE_LOCK')) {
            locks.delete(parametros[0])
            return [[{ liberado: 1 }]]
          }
          if (sql.includes('SELECT id')) {
            return [conversaciones.filter(c => c.telefono === parametros[1]
              && c.mensajes[0]?.tipo === parametros[2]
              && c.fecha > Date.now() - COOLDOWN_ALFAJOR_MS)]
          }
          if (sql.includes('INSERT INTO')) {
            conversaciones.push({ telefono: parametros[1], fecha: Date.now(), mensajes: JSON.parse(parametros[2]) })
            return [{ insertId: conversaciones.length }]
          }
          throw new Error('Consulta SQL inesperada')
        },
        release() { liberadas++ },
      }
    },
  } as unknown as Pick<Pool, 'getConnection'>
  const envios: unknown[] = []
  const enviar = async (token: string, phoneId: string, data: { phone: string; text: string }) => {
    envios.push({ token, phoneId, ...data })
    return { success: true }
  }
  return { pool, enviar, envios, conversaciones, locks, liberadas: () => liberadas }
}

describe('respuesta automática de Alfajor', () => {
  test('usa el número y token del local, y el texto exacto sin saludo ni link', async () => {
    const e = entorno()
    await crearRespuestaAlfajor(e.pool, e.enviar)(consulta)
    expect(e.envios).toEqual([{
      token: consulta.token, phoneId: consulta.phoneNumberId, phone: consulta.telefono,
      text: 'Cualquier duda o consulta, escribinos por Instagram a @alfajorconpapas.',
    }])
    expect(e.conversaciones[0].mensajes[0].content).toBe(RESPUESTA_ALFAJOR)
    expect(e.locks.size).toBe(0)
    expect(e.liberadas()).toBe(1)
  })

  test('el spam no repite la respuesta, incluso tras recrear el servicio', async () => {
    const e = entorno()
    await crearRespuestaAlfajor(e.pool, e.enviar)(consulta)
    const reiniciado = crearRespuestaAlfajor(e.pool, e.enviar)
    for (let i = 0; i < 10; i++) await reiniciado(consulta)
    expect(e.envios).toHaveLength(1)
    expect(e.conversaciones).toHaveLength(1)
  })

  test('otro cliente recibe su respuesta y el mismo cliente puede volver tras 24 horas', async () => {
    const e = entorno()
    const responder = crearRespuestaAlfajor(e.pool, e.enviar)
    await responder(consulta)
    await responder({ ...consulta, telefono: '5493517654321' })
    e.conversaciones[0].fecha -= COOLDOWN_ALFAJOR_MS
    await responder(consulta)
    expect(e.envios).toHaveLength(3)
  })

  test('webhooks simultáneos del mismo cliente sólo envían una vez', async () => {
    const e = entorno()
    let terminar!: () => void
    const espera = new Promise<void>(resolve => { terminar = resolve })
    let enEnvio!: () => void
    const iniciado = new Promise<void>(resolve => { enEnvio = resolve })
    const responder = crearRespuestaAlfajor(e.pool, async (...args) => {
      enEnvio()
      await espera
      return e.enviar(...args)
    })
    const primero = responder(consulta)
    await iniciado
    await Promise.all(Array.from({ length: 10 }, () => responder(consulta)))
    terminar()
    await primero
    expect(e.envios).toHaveLength(1)
    expect(e.locks.size).toBe(0)
    expect(e.liberadas()).toBe(11)
  })

  test('los avisos previos de pedidos no bloquean la primera respuesta', async () => {
    const e = entorno()
    e.conversaciones.push({ telefono: consulta.telefono, fecha: Date.now(), mensajes: [{ role: 'assistant', content: 'Tu pedido fue despachado' }] })
    await crearRespuestaAlfajor(e.pool, e.enviar)(consulta)
    expect(e.envios).toHaveLength(1)
  })

  test('no responde a otro restaurante ni a mensajes de hace más de 24 horas', async () => {
    const e = entorno()
    const responder = crearRespuestaAlfajor(e.pool, e.enviar)
    await responder({ ...consulta, restauranteId: 7 })
    await responder({ ...consulta, timestamp: String(Math.floor((Date.now() - COOLDOWN_ALFAJOR_MS - 1000) / 1000)) })
    expect(e.envios).toHaveLength(0)
    expect(e.liberadas()).toBe(0)
  })

  test('un rechazo permite reintentar y libera la conexión y el lock', async () => {
    const e = entorno()
    await expect(crearRespuestaAlfajor(e.pool, async () => ({ success: false }))(consulta)).rejects.toThrow('No se pudo enviar')
    expect(e.conversaciones).toHaveLength(0)
    expect(e.locks.size).toBe(0)
    expect(e.liberadas()).toBe(1)
    await crearRespuestaAlfajor(e.pool, e.enviar)(consulta)
    expect(e.envios).toHaveLength(1)
  })
})
