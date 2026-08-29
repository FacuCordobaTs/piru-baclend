import { describe, expect, test } from 'bun:test'
import {
  hashTokenMarketing,
  prepararEnlaceMarketing,
  type RepositorioEnlacesMarketing,
} from './marketing-enlaces'

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
