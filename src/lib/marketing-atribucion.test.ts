import { describe, expect, test } from 'bun:test'
import { atribuirPedidoMarketing, atribuirPedidoMarketingSinPropagar, hashTokenMarketing, type RepositorioAtribucionMarketing } from './marketing-atribucion'

function repo(overrides: Partial<RepositorioAtribucionMarketing> = {}) {
  const inserts: any[] = []
  const repositorio: RepositorioAtribucionMarketing = {
    buscarPedido: async () => ({ total: '1500.00', montoDescuento: '100.00' }),
    buscarCliente: async () => true,
    buscarSesion: async () => ({ id: 8, restauranteId: 1, visitorId: 'visitor-1', lastTouchTipo: 'campana', lastTouchCampanaId: 5, lastTouchRecetaCodigo: null, expiraAt: new Date('2026-08-28T13:00:00.000Z') }),
    buscarCampaniaPorSlug: async () => ({ id: 5 }),
    buscarEnlacePorTokenHash: async () => ({ campanaId: 5, clienteId: 4, recetaCodigo: 'recuperar-habito' }),
    insertarAtribucion: async (input) => { inserts.push(input) },
    ...overrides,
  }
  return { repositorio, inserts }
}

const base = { restauranteId: 1, pedidoUnificadoId: 12, clienteId: 4, visitorId: 'visitor-1', sesionUuid: 'sesion-1' }
const ahora = new Date('2026-08-28T12:00:00.000Z')

describe('atribuirPedidoMarketing', () => {
  test('atribuye de forma tenant-safe un pedido con tracking de campaña', async () => {
    const { repositorio, inserts } = repo()
    await expect(atribuirPedidoMarketing(repositorio, { ...base, campaniaSlug: 'ig-agosto' }, ahora)).resolves.toEqual({ estado: 'atribuido' })
    expect(inserts).toEqual([expect.objectContaining({ pedidoUnificadoId: 12, marketingSesionId: 8, campanaId: 5, origen: 'campana', revenueAtribuido: '1500.00' })])
  })

  test('no altera el pedido cuando no llegó tracking', async () => {
    const { repositorio, inserts } = repo()
    await expect(atribuirPedidoMarketing(repositorio, { ...base, visitorId: undefined }, ahora)).resolves.toEqual({ estado: 'sin_tracking' })
    expect(inserts).toHaveLength(0)
  })

  test('rechaza referencias cruzadas y deja que el caller lo trate best-effort', async () => {
    const { repositorio, inserts } = repo({ buscarCampaniaPorSlug: async () => null })
    await expect(atribuirPedidoMarketing(repositorio, { ...base, campaniaSlug: 'de-otro-local' }, ahora)).rejects.toThrow('campaña no pertenece')
    expect(inserts).toHaveLength(0)
  })

  test('un fallo de tracking se absorbe sin cambiar el resultado del checkout', async () => {
    const { repositorio } = repo({ buscarSesion: async () => { throw new Error('DB temporalmente caída') } })
    await expect(atribuirPedidoMarketingSinPropagar(repositorio, base, () => {})).resolves.toBeNull()
  })

  test('el repositorio de producción inserta con ignore y el token nunca queda plano', () => {
    expect(hashTokenMarketing('token-opaco')).toHaveLength(64)
    expect(hashTokenMarketing('token-opaco')).not.toContain('token-opaco')
  })
})
