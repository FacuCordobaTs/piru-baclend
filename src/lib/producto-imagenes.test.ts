import { describe, expect, test } from 'bun:test'
import { errorImagenDataUrl, leerImagenesExtra, MAX_IMAGENES_EXTRA, resolverImagenesProducto } from './producto-imagenes'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
let subidas = 0
const guardar = async () => `https://cdn.piru.app/nueva-${++subidas}.png`

describe('leerImagenesExtra', () => {
  test('acepta JSON en string o ya parseado y descarta basura', () => {
    expect(leerImagenesExtra('["a","",3,"b"]')).toEqual(['a', 'b'])
    expect(leerImagenesExtra(['a'])).toEqual(['a'])
    expect(leerImagenesExtra(null)).toEqual([])
    expect(leerImagenesExtra('no-json')).toEqual([])
  })
})

describe('errorImagenDataUrl', () => {
  test('valida tipo y tamaño', () => {
    expect(errorImagenDataUrl(PNG)).toBeNull()
    expect(errorImagenDataUrl('data:image/gif;base64,AAAA')).not.toBeNull()
    expect(errorImagenDataUrl('https://x')).not.toBeNull()
    expect(errorImagenDataUrl(`data:image/jpeg;base64,${'A'.repeat(7_000_000)}`)).not.toBeNull()
  })
})

describe('resolverImagenesProducto', () => {
  const previas = { imagenUrl: 'https://cdn.piru.app/p.png', imagenesExtra: ['https://cdn.piru.app/e1.png', 'https://cdn.piru.app/e2.png'] }

  test('sin campos de imagen no cambia nada', async () => {
    expect(await resolverImagenesProducto({}, previas, guardar))
      .toEqual({ imagenUrl: undefined, imagenesExtra: undefined, huerfanas: [] })
  })

  test('sube las nuevas, conserva las conocidas y marca huérfanas las quitadas', async () => {
    const r = await resolverImagenesProducto({ imagenesExtra: ['https://cdn.piru.app/e2.png', PNG] }, previas, guardar)
    expect(r.imagenesExtra).toEqual(['https://cdn.piru.app/e2.png', expect.stringContaining('nueva-')])
    expect(r.huerfanas).toEqual(['https://cdn.piru.app/e1.png'])
  })

  test('promover una extra a portada no la borra ni la duplica', async () => {
    const r = await resolverImagenesProducto(
      { image: 'https://cdn.piru.app/e1.png', imagenesExtra: ['https://cdn.piru.app/p.png', 'https://cdn.piru.app/e1.png', 'https://cdn.piru.app/e2.png'] },
      previas, guardar,
    )
    expect(r.imagenUrl).toBe('https://cdn.piru.app/e1.png')
    expect(r.imagenesExtra).toEqual(['https://cdn.piru.app/p.png', 'https://cdn.piru.app/e2.png'])
    expect(r.huerfanas).toEqual([])
  })

  test('ignora URLs ajenas y respeta el máximo', async () => {
    const r = await resolverImagenesProducto(
      { image: 'https://evil.example/x.png', imagenesExtra: ['https://evil.example/y.png', ...Array(8).fill(PNG)] },
      { imagenUrl: null, imagenesExtra: [] }, guardar,
    )
    expect(r.imagenUrl).toBeUndefined()
    expect(r.imagenesExtra).toHaveLength(MAX_IMAGENES_EXTRA)
    expect(r.imagenesExtra!.some(u => u.includes('evil'))).toBe(false)
  })
})
