import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

// Las rutas que orquesta (producto, ropa) exigen las variables de R2 al importarse; acá no se usan.
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME']) process.env[k] ||= 'prueba'
process.env.R2_PUBLIC_URL ||= 'https://r2.prueba'
const { prospeccionRoute } = await import('./prospeccion')

const CLAVE = 'clave-de-prueba-con-mas-de-24-caracteres'
const previa = process.env.PROSPECCION_API_KEY
afterAll(() => {
  if (previa === undefined) delete process.env.PROSPECCION_API_KEY
  else process.env.PROSPECCION_API_KEY = previa
})

describe('API key de prospección', () => {
  beforeAll(() => {
    delete process.env.PROSPECCION_API_KEY
  })

  test('sin clave configurada el canal está apagado', async () => {
    const res = await prospeccionRoute.request('/instructivo.md', { headers: { Authorization: `Bearer ${CLAVE}` } })
    expect(res.status).toBe(503)
  })

  test('con clave: rechaza una incorrecta o ausente y entrega el instructivo con la correcta', async () => {
    process.env.PROSPECCION_API_KEY = CLAVE
    expect((await prospeccionRoute.request('/instructivo.md')).status).toBe(401)
    expect((await prospeccionRoute.request('/instructivo.md', { headers: { Authorization: 'Bearer otra' } })).status).toBe(401)
    const ok = await prospeccionRoute.request('/instructivo.md', { headers: { Authorization: `Bearer ${CLAVE}` } })
    expect(ok.status).toBe(200)
    const texto = await ok.text()
    expect(texto).toContain('negocio.nombre')
    expect(texto).toContain('Instructivo para que una IA arme la carta')
  })

  test('el JSON inválido vuelve con errores y sin tocar la base', async () => {
    process.env.PROSPECCION_API_KEY = CLAVE
    const res = await prospeccionRoute.request('/tienda-desde-json', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CLAVE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prospectoRef: 'p1', tienda: { negocio: {}, carta: { categorias: [] } } }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).errores.length).toBeGreaterThan(0)
  })
})
