import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { crearMarketingCampanasRoute, crearMarketingContactosRoute, crearMarketingEnvioWhatsappRoute, crearMarketingOportunidadesRoute, crearMarketingRecetasPublicasRoute, crearMarketingRoute, crearMarketingSmartLinksRoute, type DependenciasEnvioWhatsappMarketing, type DependenciasMarketingRoute, type DependenciasRecetasPublicasMarketing, type DependenciasSmartLinksMarketing, type RepositorioCampanasMarketing, type RepositorioContactosMarketing, type RepositorioOportunidadesMarketing } from './marketing'
import type { EventoMarketingInput, ResultadoEventoMarketing } from '../lib/marketing-tracking'
import { hashTokenMarketing } from '../lib/marketing-enlaces'
import type { DatosOportunidadesMarketing, EnlaceOportunidadInput } from '../lib/marketing-oportunidades'

function dependencias(overrides: Partial<DependenciasMarketingRoute> = {}): DependenciasMarketingRoute {
  return {
    referencias: {
      restauranteExiste: async () => true,
      campaniasPertenecen: async () => true,
      productosPertenecen: async () => true,
      pedidosPertenecen: async () => true,
    },
    guardarEventos: async (_restauranteId: number, eventos: EventoMarketingInput[]): Promise<ResultadoEventoMarketing[]> =>
      eventos.map((evento, indice) => ({ eventoUuid: evento.eventoUuid, estado: indice ? 'duplicado' : 'insertado', sesionId: 10 })),
    ...overrides,
  }
}

function app(deps = dependencias()) {
  return new Hono().route('/public', crearMarketingRoute(deps))
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    restauranteId: 7,
    eventos: [{
      eventoUuid: 'evento-1',
      sesionUuid: 'sesion-1',
      visitorId: 'visitor-1',
      tipo: 'session_start',
      ocurridoAt: '2026-08-28T12:00:00.000Z',
    }],
    ...overrides,
  }
}

describe('POST /public/marketing/events', () => {
  test('guarda un batch válido y devuelve un resultado reintentable', async () => {
    const response = await app().request('/public/marketing/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, data: { procesados: 1, insertados: 1, duplicados: 0 } })
  })

  test('acepta resultados duplicados de un reintento sin reinsertar', async () => {
    const response = await app(dependencias({
      guardarEventos: async () => [{ eventoUuid: 'evento-1', estado: 'duplicado', sesionId: 10 }],
    })).request('/public/marketing/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, data: { insertados: 0, duplicados: 1 } })
  })

  test('rechaza referencias de otro restaurante antes de persistir', async () => {
    let persistencias = 0
    const response = await app(dependencias({
      referencias: { restauranteExiste: async () => true, campaniasPertenecen: async () => false, productosPertenecen: async () => true, pedidosPertenecen: async () => true },
      guardarEventos: async () => { persistencias++; return [] },
    })).request('/public/marketing/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload({ eventos: [{ ...payload().eventos[0], touch: { tipo: 'campana', campanaId: 99 } }] })),
    })
    expect(response.status).toBe(400)
    expect(persistencias).toBe(0)
  })

  test('rechaza batches de más de veinte eventos', async () => {
    const evento = payload().eventos[0]
    const response = await app().request('/public/marketing/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload({ eventos: Array.from({ length: 21 }, (_, i) => ({ ...evento, eventoUuid: `evento-${i}` })) })),
    })
    expect(response.status).toBe(400)
  })
})

describe('GET /marketing/oportunidades y recomendación', () => {
  const datos: DatosOportunidadesMarketing = {
    clientes: [{ id: 1, nombre: 'Ana', marketingOptOut: false }, { id: 2, nombre: 'Beto', marketingOptOut: true }],
    pedidos: [
      { id: 1, clienteId: 1, total: 1000, createdAt: new Date('2026-08-20T12:00:00Z') },
      { id: 2, clienteId: 2, total: 2000, createdAt: new Date('2026-08-20T12:00:00Z') },
    ],
    items: [{ pedidoId: 1, productoId: 10, cantidad: 1 }], productos: [{ id: 10, nombre: 'Pizza' }], recuperos: [], contactos: [],
  }
  test('filtra, expone bloqueo y usa solamente las cargas batch del repositorio', async () => {
    let cargasDatos = 0; let cargasEnlaces = 0
    const repo: RepositorioOportunidadesMarketing = {
      cargarDatos: async () => { cargasDatos++; return datos },
      cargarEnlaces: async (): Promise<EnlaceOportunidadInput[]> => { cargasEnlaces++; return [] },
    }
    const app = new Hono().use('*', async (c, next) => { ;(c as any).user = { id: 7 }; await next() })
      .route('/marketing', crearMarketingOportunidadesRoute(repo, [], () => new Date('2026-08-28T15:00:00Z')))
    const respuesta = await app.request('/marketing/oportunidades?receta=segunda_compra')
    expect(respuesta.status).toBe(200)
    expect(await respuesta.json()).toMatchObject({ success: true, data: { total: 2 } })
    expect(cargasDatos).toBe(1); expect(cargasEnlaces).toBe(1)
    const bloqueo = await app.request('/marketing/clientes/2/recomendacion')
    expect(bloqueo.status).toBe(200)
    expect(await bloqueo.json()).toMatchObject({ data: { elegibilidad: { elegible: false, bloqueos: [expect.objectContaining({ motivo: 'opt_out' })] } } })
    expect(cargasDatos).toBe(2); expect(cargasEnlaces).toBe(2)
  })
})

function dependenciasSmartLinks(overrides: Partial<DependenciasSmartLinksMarketing> = {}): DependenciasSmartLinksMarketing & { contextos: any[] } {
  const contextos: any[] = []
  return {
    contextos,
    repositorio: {
      buscarCampanaActiva: async (username, slug) => username === 'pizzeria' && slug === 'ig-agosto'
        ? {
            restauranteId: 7, id: 99, slug, destinoTipo: 'producto', productoId: 10, carritoRep: null,
            codigoDescuentoId: 4, codigoDescuento: 'VOLVE10',
            utmSource: 'instagram', utmMedium: 'social', utmCampaign: 'Agosto', utmTerm: null, utmContent: null,
          }
        : null,
    },
    enriquecerContexto: async (contexto) => { contextos.push(contexto) },
    ...overrides,
  }
}

function appSmartLinks(deps = dependenciasSmartLinks()) {
  return { app: new Hono().route('/public', crearMarketingSmartLinksRoute(deps)), deps }
}

describe('GET /public/marketing/campanas/:username/:slug', () => {
  test('resuelve destino producto sin exponer IDs internos de campaña', async () => {
    const { app } = appSmartLinks()
    const response = await app.request('/public/marketing/campanas/pizzeria/ig-agosto')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      success: true,
      data: { encontrada: true, destino: { tipo: 'producto', productoId: 10 }, contexto: { campaniaSlug: 'ig-agosto' }, beneficio: { codigoDescuentoId: 4, codigo: 'VOLVE10' } },
    })
    expect(JSON.stringify(body)).not.toContain('99')
  })

  test('resuelve tienda y carrito, y degrada configuraciones inválidas a tienda', async () => {
    const base = dependenciasSmartLinks()
    base.repositorio.buscarCampanaActiva = async (_username, slug) => ({
      restauranteId: 7, id: 99, slug, productoId: null,
      destinoTipo: slug === 'carrito' ? 'carrito' : 'producto',
      carritoRep: slug === 'carrito' ? '10x2-15x1' : null,
      utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null,
    })
    const app = new Hono().route('/public', crearMarketingSmartLinksRoute(base))
    expect(await (await app.request('/public/marketing/campanas/pizzeria/carrito')).json()).toMatchObject({ data: { destino: { tipo: 'carrito', carritoRep: '10x2-15x1' } } })
    expect(await (await app.request('/public/marketing/campanas/pizzeria/producto-sin-id')).json()).toMatchObject({ data: { destino: { tipo: 'tienda' } } })
  })

  test('un slug inexistente, inactivo o de otro tenant cae a tienda sin revelar su estado', async () => {
    const { app } = appSmartLinks()
    for (const path of [
      '/public/marketing/campanas/pizzeria/no-existe',
      '/public/marketing/campanas/otro-local/ig-agosto',
    ]) {
      const response = await app.request(path)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true, data: { encontrada: false, destino: { tipo: 'tienda' } } })
    }
  })

  test('inicia el contexto atribuible sólo con IDs completos y no rompe el link si tracking falla', async () => {
    const { app, deps } = appSmartLinks()
    await app.request('/public/marketing/campanas/pizzeria/ig-agosto?visitorId=visitor-1&sesionUuid=sesion-1&eventoUuid=evento-1')
    expect(deps.contextos).toEqual([{ restauranteId: 7, campanaId: 99, visitorId: 'visitor-1', sesionUuid: 'sesion-1', eventoUuid: 'evento-1' }])
    await app.request('/public/marketing/campanas/pizzeria/ig-agosto?visitorId=visitor-2')
    expect(deps.contextos).toHaveLength(1)

    const conFalla = appSmartLinks(dependenciasSmartLinks({ enriquecerContexto: async () => { throw new Error('db caída') } })).app
    const response = await conFalla.request('/public/marketing/campanas/pizzeria/ig-agosto?visitorId=visitor-1&sesionUuid=sesion-1&eventoUuid=evento-2')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, data: { encontrada: true } })
  })
})

function dependenciasRecetasPublicas(overrides: Partial<DependenciasRecetasPublicasMarketing> = {}) {
  const contextos: any[] = []
  const token = 'token-receta-publica-seguro-1234567890'
  let moduloActivo = true
  const enlace = {
    restauranteId: 7, tokenHash: hashTokenMarketing(token), recetaCodigo: 'recuperar_habito',
    destinoTipo: 'carrito' as const, productoId: null, carritoRep: '12x2', clienteId: 11, textoSugerido: 'Dato privado',
    codigoDescuentoId: 8, codigoDescuento: 'ANA10',
  }
  const deps: DependenciasRecetasPublicasMarketing & { contextos: any[]; setModuloActivo: (activo: boolean) => void } = {
    contextos,
    // El estado del módulo se conserva fuera de la consulta: desactivarlo no
    // revoca una acción ya emitida antes de su vencimiento.
    setModuloActivo: (activo) => { moduloActivo = activo },
    repositorio: {
      buscarEnlaceActivo: async (username, hash, ahora) => username === 'pizzeria' && hash === enlace.tokenHash && ahora < new Date('2026-09-01T00:00:00.000Z')
        ? enlace : null,
    },
    enriquecerContexto: async (contexto) => { contextos.push({ ...contexto, moduloActivo }) },
    ahora: () => new Date('2026-08-28T12:00:00.000Z'),
    ...overrides,
  }
  return { deps, token }
}

describe('GET /public/marketing/recetas/:username/:token', () => {
  test('resuelve un token válido sin exponer PII y crea sólo contexto atribuible', async () => {
    const { deps, token } = dependenciasRecetasPublicas()
    const app = new Hono().route('/public', crearMarketingRecetasPublicasRoute(deps))
    const response = await app.request(`/public/marketing/recetas/pizzeria/${token}?visitorId=visitor-1&sesionUuid=sesion-1&eventoUuid=evento-1`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ success: true, data: { encontrada: true, destino: { tipo: 'carrito', carritoRep: '12x2' }, contexto: { recetaCodigo: 'recuperar_habito' }, beneficio: { codigoDescuentoId: 8, codigo: 'ANA10' } } })
    expect(JSON.stringify(body)).not.toContain('clienteId')
    expect(JSON.stringify(body)).not.toContain('Dato privado')
    expect(JSON.stringify(body)).not.toContain('tokenHash')
    expect(deps.contextos).toEqual([{ restauranteId: 7, recetaCodigo: 'recuperar_habito', visitorId: 'visitor-1', sesionUuid: 'sesion-1', eventoUuid: 'evento-1', moduloActivo: true }])
  })

  test('token inválido, vencido o de otro tenant reciben el mismo fallback de tienda', async () => {
    const { deps, token } = dependenciasRecetasPublicas()
    const app = new Hono().route('/public', crearMarketingRecetasPublicasRoute(deps))
    const fallback = { success: true, data: { encontrada: false, destino: { tipo: 'tienda' } } }
    expect(await (await app.request('/public/marketing/recetas/pizzeria/token-invalido-publico-1234567890')).json()).toEqual(fallback)
    expect(await (await app.request(`/public/marketing/recetas/otro-local/${token}`)).json()).toEqual(fallback)
    const vencida = new Hono().route('/public', crearMarketingRecetasPublicasRoute({ ...deps, ahora: () => new Date('2026-09-02T00:00:00.000Z') }))
    expect(await (await vencida.request(`/public/marketing/recetas/pizzeria/${token}`)).json()).toEqual(fallback)
  })

  test('desactivar Crecimiento no rompe un enlace emitido y tracking es best-effort', async () => {
    const { deps, token } = dependenciasRecetasPublicas({ enriquecerContexto: async () => { throw new Error('tracking caído') } })
    deps.setModuloActivo(false)
    const app = new Hono().route('/public', crearMarketingRecetasPublicasRoute(deps))
    const response = await app.request(`/public/marketing/recetas/pizzeria/${token}?visitorId=visitor-1&sesionUuid=sesion-1&eventoUuid=evento-1`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, data: { encontrada: true, destino: { tipo: 'carrito' } } })
  })
})

function repositorioCampanas(): RepositorioCampanasMarketing & { campanas: any[]; atribuidas: Set<number> } {
  const campanas: any[] = []
  const atribuidas = new Set<number>()
  return {
    campanas, atribuidas,
    listar: async (restauranteId) => campanas.filter((campana) => campana.restauranteId === restauranteId),
    buscar: async (restauranteId, id) => campanas.find((campana) => campana.restauranteId === restauranteId && campana.id === id) ?? null,
    slugExiste: async (restauranteId, slug) => campanas.some((campana) => campana.restauranteId === restauranteId && campana.slug === slug),
    productoPertenece: async (restauranteId, id) => restauranteId === 7 && id === 10,
    codigoPertenece: async (restauranteId, id) => restauranteId === 7 && id === 20,
    crear: async (restauranteId, input) => {
      const campana = { id: campanas.length + 1, restauranteId, estado: input.estado ?? 'borrador', ...input }
      campanas.push(campana); return campana
    },
    actualizar: async (restauranteId, id, input) => {
      const campana = campanas.find((item) => item.restauranteId === restauranteId && item.id === id)!
      Object.assign(campana, input); return campana
    },
    desactivar: async (restauranteId, id) => {
      const campana = campanas.find((item) => item.restauranteId === restauranteId && item.id === id)!
      campana.estado = 'inactiva'; return campana
    },
    tieneAtribucion: async (_restauranteId, id) => atribuidas.has(id),
    borrar: async (restauranteId, id) => {
      const indice = campanas.findIndex((item) => item.restauranteId === restauranteId && item.id === id)
      if (indice >= 0) campanas.splice(indice, 1)
    },
  }
}

function appCampanas(repo = repositorioCampanas(), restauranteId = 7) {
  const autenticar = async (c: any, next: any) => { c.user = { id: restauranteId }; await next() }
  return { app: new Hono().route('/marketing', crearMarketingCampanasRoute(repo, [autenticar])), repo }
}

function campanaPayload(overrides: Record<string, unknown> = {}) {
  return {
    nombre: 'Instagram septiembre', slug: 'instagram-septiembre', tipo: 'adquisicion', destinoTipo: 'producto', productoId: 10,
    codigoDescuentoId: 20, utmSource: 'instagram', inversionManual: 1000,
    ...overrides,
  }
}

describe('CRUD de campañas de marketing', () => {
  test('requiere autenticación antes de acceder al CRUD', async () => {
    const repo = repositorioCampanas()
    const bloquear = async (c: any) => c.json({ success: false }, 401)
    const response = await new Hono().route('/marketing', crearMarketingCampanasRoute(repo, [bloquear]))
      .request('/marketing/campanas')
    expect(response.status).toBe(401)
  })

  test('crea campañas con referencias del tenant y rechaza slug duplicado', async () => {
    const { app } = appCampanas()
    const crear = () => app.request('/marketing/campanas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(campanaPayload()) })
    expect((await crear()).status).toBe(201)
    expect((await crear()).status).toBe(409)
  })

  test('rechaza producto o cupón perteneciente a otro restaurante', async () => {
    const { app } = appCampanas()
    const response = await app.request('/marketing/campanas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(campanaPayload({ productoId: 99 })) })
    expect(response.status).toBe(400)
    expect((await response.json()).message).toContain('producto')
  })

  test('mantiene el slug al editar y no permite atravesar tenants', async () => {
    const { app, repo } = appCampanas()
    await app.request('/marketing/campanas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(campanaPayload()) })
    const editar = await app.request('/marketing/campanas/1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Nuevo nombre' }) })
    expect(editar.status).toBe(200)
    expect(repo.campanas[0]).toMatchObject({ nombre: 'Nuevo nombre', slug: 'instagram-septiembre' })
    const { app: otroTenant } = appCampanas(repo, 8)
    expect((await otroTenant.request('/marketing/campanas/1')).status).toBe(404)
  })

  test('borra sin historial y desactiva cuando existe atribución', async () => {
    const { app, repo } = appCampanas()
    for (const slug of ['sin-historial', 'con-historial']) {
      await app.request('/marketing/campanas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(campanaPayload({ slug })) })
    }
    expect((await app.request('/marketing/campanas/1', { method: 'DELETE' })).status).toBe(200)
    repo.atribuidas.add(2)
    const response = await app.request('/marketing/campanas/2', { method: 'DELETE' })
    expect(await response.json()).toMatchObject({ success: true, desactivada: true, data: { estado: 'inactiva' } })
  })
})

function repositorioContactos(optOut = false): RepositorioContactosMarketing & { contactos: any[]; controles: number; walletMovimientos: number } {
  const token = 'token-contacto-seguro-12345678901234567890'
  const contactos: any[] = []
  let controles = 0
  return {
    contactos,
    get controles() { return controles },
    // La ruta no recibe ni llama al wallet: este contador hace explícita esa
    // garantía de contrato para copiar y wa.me.
    walletMovimientos: 0,
    buscarEnlace: async (restauranteId, enlaceId) => restauranteId === 7 && enlaceId === 31 ? {
      id: 31, restauranteId: 7, clienteId: 11, tokenHash: hashTokenMarketing(token),
      textoSugerido: 'Volvé por tus favoritos & disfrutá', telefono: '+54 9 11 5555-1234',
      marketingOptOut: optOut, username: 'pizzeria-demo', activo: true, expiraAt: new Date('2026-09-30T00:00:00.000Z'),
    } : null,
    buscarContactoPorIdempotencia: async (_restauranteId, clave) => contactos.find((contacto) => contacto.idempotenciaClave === clave) ?? null,
    cargarToques: async (_restauranteId, _clienteId, desde) => contactos.filter((contacto) => contacto.createdAt >= desde).map((contacto) => ({ createdAt: contacto.createdAt })),
    sacarClienteDeControl: async () => { controles++ },
    crearContacto: async (input) => {
      const contacto = { id: contactos.length + 1, ...input, createdAt: new Date('2026-08-28T15:00:00.000Z') }
      contactos.push(contacto)
      return contacto
    },
  }
}

function appContactos(repo = repositorioContactos()) {
  const autenticar = async (c: any, next: any) => { c.user = { id: 7 }; await next() }
  return { app: new Hono().route('/marketing', crearMarketingContactosRoute(repo, [autenticar], () => new Date('2026-08-28T15:00:00.000Z'))), repo }
}

function contactoPayload(overrides: Record<string, unknown> = {}) {
  return { token: 'token-contacto-seguro-12345678901234567890', idempotenciaClave: 'contacto-idempotente-001', ...overrides }
}

describe('Canales copiar y wa.me de enlaces de marketing', () => {
  test('copiar prepara una acción idempotente sin tocar el wallet ni afirmar entrega', async () => {
    const { app, repo } = appContactos()
    const request = () => app.request('/marketing/enlaces/31/copiar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(contactoPayload()) })
    const primera = await request()
    expect(primera.status).toBe(201)
    expect(await primera.json()).toMatchObject({ success: true, data: { contacto: { canal: 'copiado', estado: 'preparado' }, entregado: false, idempotente: false, url: 'https://my.piru.app/pizzeria-demo/r/token-contacto-seguro-12345678901234567890' } })
    const reintento = await request()
    expect(reintento.status).toBe(200)
    expect(await reintento.json()).toMatchObject({ success: true, data: { idempotente: true, entregado: false } })
    expect(repo.contactos).toHaveLength(1)
    expect(repo.walletMovimientos).toBe(0)
    expect(repo.controles).toBe(1)
  })

  test('wa.me abre el composer con texto y URL escapados, pero queda como abierto y no enviado', async () => {
    const { app, repo } = appContactos()
    const response = await app.request('/marketing/enlaces/31/wa-me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(contactoPayload({ idempotenciaClave: 'contacto-wa-me-001' })) })
    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body).toMatchObject({ success: true, data: { contacto: { canal: 'wa_me', estado: 'abierto' }, entregado: false } })
    expect(body.data.waMeUrl).toBe('https://wa.me/5491155551234?text=Volv%C3%A9%20por%20tus%20favoritos%20%26%20disfrut%C3%A1%0A%0Ahttps%3A%2F%2Fmy.piru.app%2Fpizzeria-demo%2Fr%2Ftoken-contacto-seguro-12345678901234567890')
    expect(repo.walletMovimientos).toBe(0)
  })

  test('bloquea opt-out antes de facilitar el contacto', async () => {
    const { app, repo } = appContactos(repositorioContactos(true))
    const response = await app.request('/marketing/enlaces/31/wa-me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(contactoPayload({ idempotenciaClave: 'contacto-optout-001' })) })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ success: false, code: 'opt_out' })
    expect(repo.contactos).toHaveLength(0)
    expect(repo.controles).toBe(0)
  })
})

function dependenciasEnvio(overrides: Partial<DependenciasEnvioWhatsappMarketing> = {}) {
  const token = 'token-envio-seguro-123456789012345678901'
  const contactos: any[] = []
  const movimientos = { reservas: 0, confirmaciones: 0, compensaciones: 0, envios: 0 }
  const repo: any = {
    buscarEnlace: async (restauranteId: number, enlaceId: number) => restauranteId === 7 && enlaceId === 41 ? {
      id: 41, restauranteId: 7, clienteId: 11, tokenHash: hashTokenMarketing(token), textoSugerido: 'Volvé por tus favoritos',
      telefono: '5491155551234', marketingOptOut: false, username: 'pizzeria-demo', activo: true,
      expiraAt: new Date('2026-09-30T00:00:00.000Z'), clienteNombre: 'Ana', restauranteNombre: 'Pizzería Demo',
      creds: { phoneId: 'phone-1', token: 'secret' }, usaCredencialesPlataforma: false,
    } : null,
    buscarContactoPorIdempotencia: async (_restauranteId: number, clave: string) => contactos.find((contacto) => contacto.idempotenciaClave === clave) ?? null,
    cargarToques: async () => contactos.filter((contacto) => ['reservado', 'enviado'].includes(contacto.estado)).map((contacto) => ({ createdAt: contacto.createdAt })),
    sacarClienteDeControl: async () => {},
    crearContacto: async (input: any) => { const contacto = { id: contactos.length + 1, ...input, createdAt: new Date('2026-08-28T15:00:00.000Z') }; contactos.push(contacto); return contacto },
    actualizarContacto: async (_restauranteId: number, id: number, input: any) => { Object.assign(contactos.find((contacto) => contacto.id === id), input) },
  }
  const deps: DependenciasEnvioWhatsappMarketing & { contactos: any[]; movimientos: typeof movimientos } = {
    repositorio: repo, walletDb: {}, contactos, movimientos,
    reservar: async () => { movimientos.reservas++; return { estado: 'reservada', idempotente: false, saldoMarketingDisponible: 0 } },
    confirmar: async () => { movimientos.confirmaciones++; return { estado: 'confirmada', idempotente: false, saldoMarketingDisponible: 0 } },
    compensar: async () => { movimientos.compensaciones++; return { estado: 'compensada', idempotente: false, saldoMarketingDisponible: 1 } },
    enviar: async () => { movimientos.envios++; return { success: true, id: 'wamid.1' } },
    ahora: () => new Date('2026-08-28T15:00:00.000Z'),
    ...overrides,
  }
  return { deps, token }
}

function appEnvio(deps: DependenciasEnvioWhatsappMarketing) {
  const autenticar = async (c: any, next: any) => { c.user = { id: 7 }; await next() }
  return new Hono().route('/marketing', crearMarketingEnvioWhatsappRoute(deps, [autenticar]))
}

describe('POST /marketing/enlaces/:id/enviar-whatsapp', () => {
  test('reserva, envía y confirma exactamente un crédito marketing', async () => {
    const { deps, token } = dependenciasEnvio()
    const response = await appEnvio(deps).request('/marketing/enlaces/41/enviar-whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, idempotenciaClave: 'enviar-001' }) })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ success: true, data: { entregado: true, contacto: { estado: 'enviado', proveedorMessageId: 'wamid.1' } } })
    expect(deps.movimientos).toMatchObject({ reservas: 1, confirmaciones: 1, compensaciones: 0, envios: 1 })
    expect(deps.contactos[0]).toMatchObject({ estado: 'enviado', proveedor: 'whatsapp_cloud_api', costoMensajes: '1.00' })
  })

  test('un fallo o timeout compensa y el reintento no duplica el envío', async () => {
    const { deps, token } = dependenciasEnvio({ enviar: async () => ({ success: false, error: new Error('timeout') }) })
    const app = appEnvio(deps)
    const request = () => app.request('/marketing/enlaces/41/enviar-whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, idempotenciaClave: 'timeout-001' }) })
    expect((await request()).status).toBe(502)
    expect((await request()).status).toBe(409)
    expect(deps.movimientos).toMatchObject({ reservas: 1, confirmaciones: 0, compensaciones: 1, envios: 0 })
    expect(deps.contactos[0].estado).toBe('revertido')
  })

  test('saldo insuficiente no llama al proveedor ni deja débito', async () => {
    const { deps, token } = dependenciasEnvio({ reservar: async () => ({ estado: 'sin_saldo', idempotente: false, saldoMarketingDisponible: 0 }) })
    const response = await appEnvio(deps).request('/marketing/enlaces/41/enviar-whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, idempotenciaClave: 'saldo-001' }) })
    expect(response.status).toBe(409)
    expect(deps.movimientos).toMatchObject({ envios: 0, confirmaciones: 0, compensaciones: 0 })
    expect(deps.contactos[0].estado).toBe('fallido')
  })

  test('respeta opt-out y el doble click posterior al éxito es idempotente', async () => {
    const { deps, token } = dependenciasEnvio()
    const original = deps.repositorio.buscarEnlace
    deps.repositorio.buscarEnlace = async (restauranteId, enlaceId) => ({ ...(await original(restauranteId, enlaceId))!, marketingOptOut: true })
    const bloqueado = await appEnvio(deps).request('/marketing/enlaces/41/enviar-whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, idempotenciaClave: 'baja-001' }) })
    expect(bloqueado.status).toBe(409)
    expect(deps.movimientos.envios).toBe(0)

    const listo = dependenciasEnvio()
    const app = appEnvio(listo.deps)
    const request = () => app.request('/marketing/enlaces/41/enviar-whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: listo.token, idempotenciaClave: 'doble-001' }) })
    expect((await request()).status).toBe(201)
    expect((await request()).status).toBe(200)
    // El retry vuelve a confirmar el ledger de forma idempotente (por si el
    // proceso anterior cayó entre proveedor y confirmación), pero no reserva
    // ni envía otra vez.
    expect(listo.deps.movimientos).toMatchObject({ reservas: 1, confirmaciones: 2, envios: 1 })
  })
})
