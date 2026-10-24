import { describe, expect, test } from 'bun:test'
import { actualizarTienda, ImagenTiendaInvalida, normalizarTienda } from './tienda-config'

const foto = `data:image/png;base64,${Buffer.from('foto').toString('base64')}`

describe('configuración opcional de la tienda', () => {
  test('un local nuevo no necesita datos; ignora claves y valores inválidos', () => {
    for (const v of [undefined, null, {}, [], 42, '{', { plantilla: ['moderna'] }, { plantilla: 'otra', colores: { fondo: 'red' }, secreto: 'no' }]) expect(normalizarTienda(v)).toBeNull()
    expect(normalizarTienda({ frase: '  Nuestra cocina  ' })).toEqual({ frase: 'Nuestra cocina' })
  })
  test('acepta JSON y todos los campos sin convertir los colores de marca en paleta', () => {
    const config = {
      plantilla: 'moderna', colores: { fondo: '#fff', texto: '#123456', acento: '#fed', superficie: '#eeeeee' },
      fuentes: { titulos: 'DM Sans', cuerpo: 'Nunito Sans', cssUrl: 'https://fonts.test/estilos.css', pesoTitulos: 800 },
      frase: 'Hecho en casa', bajada: 'Cocina de estación', portadaUrl: '/portada.jpg', galeria: ['https://img.test/1.jpg', '/foto.jpg'], cinta: ['Ingredientes locales'],
      historia: { titulo: 'Desde 1980', texto: 'Primera línea.\nSegunda línea.' }, instagram: 'local', whatsapp: '5491112345678',
    }
    expect(normalizarTienda(JSON.stringify(config))).toEqual(config)
    expect(normalizarTienda({ plantilla: 'elegante' })).toEqual({ plantilla: 'elegante' })
  })
  test('limita textos y fotos, descarta URLs y familias inseguras', () => {
    const t = normalizarTienda({ frase: 'x'.repeat(100), bajada: 'x'.repeat(230), historia: { titulo: 'x'.repeat(90), texto: 'x'.repeat(1300) },
      portadaUrl: 'javascript:alert(1)', galeria: ['//host/foto', ...Array(10).fill('https://img.test/a')], cinta: Array(12).fill('x'.repeat(50)),
      fuentes: { titulos: "X'; color:red", pesoTitulos: 999, cssUrl: 'http://font.test' }, instagram: '@casa', whatsapp: '+54 9 11 1234-5678' })!
    expect(t.frase?.length).toBe(90); expect(t.bajada?.length).toBe(220)
    expect(t.historia?.titulo?.length).toBe(80); expect(t.historia?.texto?.length).toBe(1200)
    expect(t.portadaUrl).toBeUndefined(); expect(t.galeria).toHaveLength(8)
    expect(t.cinta).toHaveLength(10); expect(t.cinta?.[0].length).toBe(40)
    expect(t.fuentes).toBeUndefined(); expect(t.instagram).toBe('casa'); expect(t.whatsapp).toBe('5491112345678')
  })
})

describe('fotos y persistencia', () => {
  test('sube una sola vez una imagen repetida, conserva el orden y borra después del commit', async () => {
    const eventos: string[] = []
    const result = await actualizarTienda({ portadaUrl: foto, galeria: ['/conservar.jpg', foto] }, { portadaUrl: '/quitar.jpg', galeria: ['/conservar.jpg'] }, {
      guardar: async () => { eventos.push('subir'); return 'https://r2.test/tiendas/7/nueva.png' }, borrar: async url => { eventos.push(`borrar:${url}`) },
    }, async config => { eventos.push('commit'); expect(JSON.stringify(config)).not.toContain('data:') })
    expect(result?.galeria).toEqual(['/conservar.jpg', 'https://r2.test/tiendas/7/nueva.png'])
    expect(eventos).toEqual(['subir', 'commit', 'borrar:/quitar.jpg'])
  })
  test('si falla DB conserva las anteriores y limpia sólo las nuevas', async () => {
    const borradas: string[] = []
    await expect(actualizarTienda({ portadaUrl: foto }, { portadaUrl: '/anterior.jpg' }, {
      guardar: async () => 'https://r2.test/nueva.png', borrar: async url => { borradas.push(url) },
    }, async () => { throw new Error('DB no disponible') })).rejects.toThrow('DB no disponible')
    expect(borradas).toEqual(['https://r2.test/nueva.png'])
  })
  test('valida todas las imágenes antes de subir o modificar la base', async () => {
    let llamadas = 0
    await expect(actualizarTienda({ portadaUrl: foto, galeria: ['data:image/svg+xml;base64,AAAA'] }, {}, {
      guardar: async () => { llamadas++; return '/nueva' }, borrar: async () => { llamadas++ },
    }, async () => { llamadas++ })).rejects.toBeInstanceOf(ImagenTiendaInvalida)
    expect(llamadas).toBe(0)
  })
  test('eliminar toda la personalización guarda NULL y retira las fotos', async () => {
    const borradas: string[] = []
    await actualizarTienda(null, { portadaUrl: '/vieja.jpg' }, { guardar: async () => '', borrar: async url => { borradas.push(url) } }, async config => { expect(config).toBeNull() })
    expect(borradas).toEqual(['/vieja.jpg'])
  })
})
