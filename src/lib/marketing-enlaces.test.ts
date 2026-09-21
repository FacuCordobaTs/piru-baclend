import { describe, expect, test } from 'bun:test'
import {
  anclajeCompartido,
  anclajePlantillas,
  anclajePropio,
  anclajePublico,
  baseTiendaDe,
  esCarritoPrearmadoValido,
  hashTokenMarketing,
  parseCarritoPrearmado,
  pathBotonPlantilla,
  prepararEnlaceMarketing,
  urlEnlaceReceta,
  urlMicroCampana,
  type RepositorioEnlacesMarketing,
} from './marketing-enlaces'

describe('carrito prearmado versionado', () => {
  test('conserva variantes primarias, secundarias y extras, sin romper el formato legado', () => {
    const v2 = 'v2:[{"p":12,"q":2,"v":31,"s":32,"a":[41,42]}]'
    expect(parseCarritoPrearmado(v2)).toEqual([{
      productoId: 12, cantidad: 2, varianteId: 31, varianteSecundariaId: 32, agregadoIds: [41, 42],
    }])
    expect(parseCarritoPrearmado('12x2-15x1')).toEqual([
      { productoId: 12, cantidad: 2, agregadoIds: [] }, { productoId: 15, cantidad: 1, agregadoIds: [] },
    ])
    expect(esCarritoPrearmadoValido('v2:[{"p":12,"q":1,"a":[41]}]')).toBe(true)
    expect(esCarritoPrearmadoValido('v2:[{"p":12,"q":0}]')).toBe(false)
  })
})

function repositorio(): RepositorioEnlacesMarketing & { enlaces: any[]; cupones: any[]; controles: number[] } {
  const enlaces: any[] = []; const cupones: any[] = []; const controles: number[] = []
  return {
    enlaces, cupones, controles,
    buscarPorIdempotencia: async (restauranteId, clave) => enlaces.find((enlace) => enlace.restauranteId === restauranteId && enlace.idempotenciaClave === clave) ?? null,
    cargarCliente: async (restauranteId, clienteId) => restauranteId === 7 && clienteId === 11
      ? { clienteId, segmento: 'dormido', esVip: false, ultimoCarrito: [{ productoId: 12, cantidad: 2 }], productoFavorito: { productoId: 12, nombre: 'Pizza' } }
      : null,
    buscarCampana: async (restauranteId, id) => restauranteId === 7 && id === 21 ? { id, recetaCodigo: 'recuperar_habito' } : null,
    codigoPertenece: async (restauranteId, id) => restauranteId === 7 && id === 31,
    crearCupon: async (_restauranteId, input) => { const cupon = { id: cupones.length + 40, ...input }; cupones.push(cupon); return cupon },
    sacarClienteDeControl: async (_restauranteId, clienteId) => { controles.push(clienteId) },
    crearEnlace: async (input) => { const enlace = { id: enlaces.length + 1, ...input, activo: true, clienteId: input.clienteId }; enlaces.push(enlace); return enlace },
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return { clienteId: 11, campanaId: 21, incentivoConfirmado: true, idempotenciaClave: 'preparar-enlace-0001', ...overrides } as any
}

describe('prepararEnlaceMarketing', () => {
  test('persiste sólo el hash opaco y prepara el destino de la receta', async () => {
    const repo = repositorio()
    const resultado = await prepararEnlaceMarketing(repo, 7, input(), () => 'token-super-secreto')
    expect(resultado.token).toBe('token-super-secreto')
    expect(repo.enlaces[0]).toMatchObject({ tokenHash: hashTokenMarketing('token-super-secreto'), destinoTipo: 'carrito', carritoRep: '12x2' })
    expect(JSON.stringify(repo.enlaces[0])).not.toContain('token-super-secreto')
    expect(repo.controles).toEqual([11])
  })

  test('tokens distintos conservan hashes globalmente distintos y una expiración explícita', async () => {
    const repo = repositorio()
    const primero = await prepararEnlaceMarketing(repo, 7, input({ idempotenciaClave: 'preparar-enlace-0002', expiraEnHoras: 2 }), () => 'token-a')
    const segundo = await prepararEnlaceMarketing(repo, 7, input({ idempotenciaClave: 'preparar-enlace-0003', expiraEnHoras: 2 }), () => 'token-b')
    expect(primero.enlace.tokenHash).not.toBe(segundo.enlace.tokenHash)
    expect(new Date(primero.enlace.expiraAt!).getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
  })

  test('reintentar la misma clave no crea otro enlace, cupón ni contacto de control', async () => {
    const repo = repositorio()
    await prepararEnlaceMarketing(repo, 7, input({ incentivo: { descuentoPorcentaje: 10, expiraHoras: 48 }, incentivoConfirmado: true }), () => 'token-a')
    const reintento = await prepararEnlaceMarketing(repo, 7, input({ incentivo: { descuentoPorcentaje: 10, expiraHoras: 48 }, incentivoConfirmado: true }), () => 'token-b')
    expect(reintento).toMatchObject({ idempotente: true, token: '' })
    expect(repo.enlaces).toHaveLength(1)
    expect(repo.cupones).toHaveLength(1)
    expect(repo.controles).toEqual([11])
  })

  test('rechaza referencias de otro tenant antes de crear la acción', async () => {
    const repo = repositorio()
    await expect(prepararEnlaceMarketing(repo, 7, input({ campanaId: 99 }), () => 'token-a')).rejects.toMatchObject({ codigo: 'CAMPANA_NO_ENCONTRADA' })
    await expect(prepararEnlaceMarketing(repo, 7, input({ codigoDescuentoId: 99 }), () => 'token-a')).rejects.toMatchObject({ codigo: 'CUPON_NO_ENCONTRADO' })
    expect(repo.enlaces).toHaveLength(0)
  })

  test('no crea un cupón si el incentivo no fue confirmado explícitamente', async () => {
    const repo = repositorio()
    await expect(prepararEnlaceMarketing(repo, 7, input({ incentivoConfirmado: false, incentivo: { descuentoPorcentaje: 10, expiraHoras: 48 } }), () => 'token-a'))
      .rejects.toMatchObject({ codigo: 'INCENTIVO_SIN_CONFIRMAR' })
    expect(repo.cupones).toHaveLength(0)
    expect(repo.enlaces).toHaveLength(0)
  })

  test('reclasifica el control antes de persistir un enlace que el dueño puede usar', async () => {
    const repo = repositorio()
    let controlAntesDeCrear = false
    const crearOriginal = repo.crearEnlace
    repo.crearEnlace = async (datos) => { controlAntesDeCrear = repo.controles.includes(datos.clienteId); return crearOriginal(datos) }
    await prepararEnlaceMarketing(repo, 7, input(), () => 'token-a')
    expect(controlAntesDeCrear).toBe(true)
  })
})

describe('anclaje de los links de campaña', () => {
  test('sin dominio propio, el link público y el del botón son el mismo (compartido)', () => {
    const local = { username: 'pizzeria-demo' }
    expect(urlMicroCampana(anclajePublico(local)!, 'lo-mismo', 'v1.a.b.c'))
      .toBe('https://my.piru.app/pizzeria-demo/c/lo-mismo?tk=v1.a.b.c')
    expect(pathBotonPlantilla(local, 'v1.a.b.c', 'lo-mismo')).toBe('pizzeria-demo/c/lo-mismo?tk=v1.a.b.c')
    expect(baseTiendaDe(local)).toBe('https://my.piru.app/pizzeria-demo/')
  })

  test('con dominio propio y plantillas compartidas: link público propio, path del botón con username', () => {
    // Es el estado de alfajor hasta que existan sus 12 plantillas: el link que se copia
    // va al dominio propio, pero el botón de Meta sigue necesitando el username porque
    // la plantilla compartida tiene https://my.piru.app/ embebida.
    const local = { username: 'alfajor', dominioTienda: 'alfajorconpapas.com', dominioPlantillas: null }
    expect(urlMicroCampana(anclajePublico(local)!, 'reactivacion', 'v1.x.y.z'))
      .toBe('https://alfajorconpapas.com/c/reactivacion?tk=v1.x.y.z')
    expect(pathBotonPlantilla(local, 'v1.x.y.z', 'reactivacion')).toBe('alfajor/c/reactivacion?tk=v1.x.y.z')
    expect(baseTiendaDe(local)).toBe('https://alfajorconpapas.com/')
  })

  test('con plantillas propias, el path del botón pierde el username', () => {
    const local = { username: 'alfajor', dominioTienda: 'alfajorconpapas.com', dominioPlantillas: 'alfajorconpapas.com' }
    expect(pathBotonPlantilla(local, 'v1.x.y.z', 'reactivacion')).toBe('c/reactivacion?tk=v1.x.y.z')
    expect(anclajePlantillas(local)).toEqual(anclajePropio('alfajorconpapas.com'))
  })

  test('los links de receta (token no cifrado) también se anclan y el path conserva su forma', () => {
    const local = { username: 'che-milanesa', dominioTienda: 'che-milanesa.com', dominioPlantillas: null }
    expect(urlEnlaceReceta(anclajePublico(local)!, 'token-opaco', 'lo-mismo'))
      .toBe('https://che-milanesa.com/r/token-opaco')
    expect(pathBotonPlantilla(local, 'token-opaco', 'lo-mismo')).toBe('che-milanesa/r/token-opaco')
  })

  test('sin username ni dominio no hay link público ni path de botón', () => {
    const local = { username: null }
    expect(anclajePublico(local)).toBeNull()
    expect(baseTiendaDe(local)).toBeNull()
    expect(pathBotonPlantilla(local, 'v1.a.b.c')).toBe('')
  })

  test('normaliza el dominio guardado (protocolo, espacios y barras sobrantes)', () => {
    expect(anclajePropio('https://alfajorconpapas.com/')).toEqual({ base: 'https://alfajorconpapas.com/', prefijo: '' })
    expect(anclajePropio(' http://alfajorconpapas.com// ')).toEqual({ base: 'https://alfajorconpapas.com/', prefijo: '' })
  })
})
