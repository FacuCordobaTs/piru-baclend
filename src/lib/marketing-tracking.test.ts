import { describe, expect, test } from 'bun:test'
import {
  DURACION_SESION_MARKETING_MS,
  ErrorMarketingTracking,
  MAX_EVENTOS_MARKETING_POR_BATCH,
  calcularExpiracionSesion,
  normalizarUtms,
  procesarBatchEventosMarketing,
  type CambiosSesionMarketing,
  type EventoMarketingInput,
  type EventoMarketingValidado,
  type NuevaSesionMarketing,
  type RepositorioMarketingTracking,
  type SesionMarketingPersistida,
} from './marketing-tracking'

class RepositorioEnMemoria implements RepositorioMarketingTracking {
  sesiones: SesionMarketingPersistida[] = []
  eventos: Array<{ restauranteId: number; sesionId: number; evento: EventoMarketingValidado }> = []
  private siguienteSesionId = 1

  async buscarSesion(restauranteId: number, sesionUuid: string) {
    return this.sesiones.find((s) => s.restauranteId === restauranteId && s.sesionUuid === sesionUuid) ?? null
  }

  async crearOEncontrarSesion(sesion: NuevaSesionMarketing) {
    const existente = await this.buscarSesion(sesion.restauranteId, sesion.sesionUuid)
    if (existente) return existente
    const creada = { ...sesion, id: this.siguienteSesionId++ }
    this.sesiones.push(creada)
    return creada
  }

  async buscarEvento(restauranteId: number, eventoUuid: string) {
    const existente = this.eventos.find(
      (e) => e.restauranteId === restauranteId && e.evento.eventoUuid === eventoUuid,
    )
    return existente ? { sesionId: existente.sesionId } : null
  }

  async insertarEvento(restauranteId: number, sesionId: number, evento: EventoMarketingValidado) {
    if (await this.buscarEvento(restauranteId, evento.eventoUuid)) return false
    this.eventos.push({ restauranteId, sesionId, evento })
    return true
  }

  async actualizarSesionSiEsMasReciente(
    restauranteId: number,
    sesionId: number,
    cambios: CambiosSesionMarketing,
  ) {
    const sesion = this.sesiones.find((s) => s.restauranteId === restauranteId && s.id === sesionId)
    if (sesion && cambios.lastTouchAt >= sesion.lastTouchAt) Object.assign(sesion, cambios)
  }
}

const BASE = new Date('2026-08-28T12:00:00.000Z')

function evento(overrides: Partial<EventoMarketingInput> = {}): EventoMarketingInput {
  return {
    eventoUuid: 'evento-1',
    sesionUuid: 'sesion-1',
    visitorId: 'visitor-1',
    tipo: 'session_start',
    ocurridoAt: BASE,
    ...overrides,
  }
}

describe('marketing tracking', () => {
  test('normaliza UTMs de query/camel, vacíos, Unicode y límites', () => {
    expect(normalizarUtms({
      utm_source: '  Meta\tAds  ',
      utmMedium: ' PAID SOCIAL ',
      utm_campaign: '  Invierno  VIP ',
      utm_term: '',
      utm_content: 123,
    })).toEqual({
      utmSource: 'meta ads',
      utmMedium: 'paid social',
      utmCampaign: 'Invierno VIP',
      utmTerm: null,
      utmContent: null,
    })
    expect(normalizarUtms({ utmSource: 'Ａ'.repeat(300) }).utmSource).toHaveLength(255)
  })

  test('mantiene first touch y usa como last touch el último origen atribuible', async () => {
    const repo = new RepositorioEnMemoria()
    await procesarBatchEventosMarketing(repo, 7, [
      evento({ touch: { tipo: 'campana', campanaId: 12 } }),
      evento({ eventoUuid: 'evento-2', ocurridoAt: new Date(BASE.getTime() + 5_000) }),
      evento({
        eventoUuid: 'evento-3',
        ocurridoAt: new Date(BASE.getTime() + 10_000),
        touch: { tipo: 'receta', recetaCodigo: 'volver_a_tiempo' },
      }),
    ])

    expect(repo.sesiones[0]).toMatchObject({
      firstTouchTipo: 'campana',
      firstTouchCampanaId: 12,
      lastTouchTipo: 'receta',
      lastTouchCampanaId: null,
      lastTouchRecetaCodigo: 'volver_a_tiempo',
      lastTouchAt: new Date(BASE.getTime() + 10_000),
    })
    expect(repo.sesiones[0].expiraAt).toEqual(new Date(BASE.getTime() + 10_000 + DURACION_SESION_MARKETING_MS))
  })

  test('acepta actividad justo en el límite y rechaza la posterior a 30 minutos', async () => {
    const repo = new RepositorioEnMemoria()
    await procesarBatchEventosMarketing(repo, 1, [evento()])
    const limite = calcularExpiracionSesion(BASE)
    await procesarBatchEventosMarketing(repo, 1, [evento({ eventoUuid: 'limite', ocurridoAt: limite })])

    await expect(procesarBatchEventosMarketing(repo, 1, [evento({
      eventoUuid: 'expirado',
      ocurridoAt: new Date(limite.getTime() + DURACION_SESION_MARKETING_MS + 1),
    })])).rejects.toMatchObject({ codigo: 'SESION_EXPIRADA' })
  })

  test('aísla sesiones y evento_uuid por restaurante', async () => {
    const repo = new RepositorioEnMemoria()
    const primero = await procesarBatchEventosMarketing(repo, 1, [evento()])
    const segundo = await procesarBatchEventosMarketing(repo, 2, [evento()])

    expect(primero[0].estado).toBe('insertado')
    expect(segundo[0].estado).toBe('insertado')
    expect(repo.sesiones.map((s) => s.restauranteId)).toEqual([1, 2])
    expect(repo.eventos).toHaveLength(2)
  })

  test('un reintento del mismo evento_uuid es idempotente', async () => {
    const repo = new RepositorioEnMemoria()
    const primera = await procesarBatchEventosMarketing(repo, 1, [evento()])
    const repetida = await procesarBatchEventosMarketing(repo, 1, [evento()])

    expect(primera[0].estado).toBe('insertado')
    expect(repetida[0].estado).toBe('duplicado')
    expect(repo.eventos).toHaveLength(1)
  })

  test('rechaza batches vacíos, mayores a 20 e inválidos antes de escribir', async () => {
    const repo = new RepositorioEnMemoria()
    await expect(procesarBatchEventosMarketing(repo, 1, [])).rejects.toBeInstanceOf(ErrorMarketingTracking)
    await expect(procesarBatchEventosMarketing(
      repo,
      1,
      Array.from({ length: MAX_EVENTOS_MARKETING_POR_BATCH + 1 }, (_, i) => evento({ eventoUuid: `e-${i}` })),
    )).rejects.toMatchObject({ codigo: 'BATCH_INVALIDO' })
    await expect(procesarBatchEventosMarketing(repo, 1, [
      evento(),
      evento({ eventoUuid: 'e-2', cantidad: 0 }),
    ])).rejects.toMatchObject({ codigo: 'EVENTO_INVALIDO', indiceEvento: 1 })
    expect(repo.eventos).toHaveLength(0)
  })

  test('no permite reutilizar una sesión con otro visitor', async () => {
    const repo = new RepositorioEnMemoria()
    await procesarBatchEventosMarketing(repo, 1, [evento()])
    await expect(procesarBatchEventosMarketing(repo, 1, [evento({
      eventoUuid: 'evento-otro-visitor',
      visitorId: 'visitor-2',
    })])).rejects.toMatchObject({ codigo: 'VISITOR_NO_COINCIDE' })
    expect(repo.eventos).toHaveLength(1)
  })
})
