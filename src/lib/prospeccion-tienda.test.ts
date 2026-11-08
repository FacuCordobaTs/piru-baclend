import { describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import {
  candidatosUsername,
  circuloAPoligono,
  crearTiendaSchema,
  erroresDeZod,
  leerDisenoZip,
  TIENDA_JSON_EJEMPLO,
  usernameBase,
} from './prospeccion-tienda'

const carta = { categorias: [{ nombre: 'Pizzas', productos: [{ nombre: 'Muzza', precio: 5000 }] }] }

describe('JSON de la tienda', () => {
  test('con sólo nombre y carta, el resto toma los valores del onboarding', () => {
    const r = crearTiendaSchema.parse({ prospectoRef: 'p-1', tienda: { negocio: { nombre: 'Lo de Pepe' }, carta } })
    expect(r.tienda.colores).toEqual({ primario: '#FF7A00', secundario: '#FFFFFF', unico: true })
    expect(r.tienda.horarios).toEqual([{ apertura: '19:00', cierre: '23:30' }])
    expect(r.tienda.entrega).toEqual({ delivery: true, retiro: true, precioEnvio: 0, radioMetros: 2500 })
    expect(r.tienda.pagos).toMatchObject({ efectivo: true, transferencia: true })
  })

  test('el ejemplo del instructivo es válido', () => {
    expect(crearTiendaSchema.safeParse({ prospectoRef: 'ej', tienda: TIENDA_JSON_EJEMPLO }).success).toBe(true)
  })

  test('los errores dicen la ruta del campo para reintentar con el LLM', () => {
    const r = crearTiendaSchema.safeParse({
      prospectoRef: 'p 1',
      tienda: { negocio: { nombre: 'X' }, colores: { primario: 'rojo' }, horarios: [{ apertura: '7pm', cierre: '23:00' }], carta },
    })
    expect(r.success).toBe(false)
    const errores = erroresDeZod(r.error!).join('\n')
    expect(errores).toContain('tienda.colores.primario')
    expect(errores).toContain('tienda.horarios.0.apertura')
    expect(errores).toContain('prospectoRef')
  })

  test('una carta vacía se rechaza', () => {
    expect(crearTiendaSchema.safeParse({ prospectoRef: 'p', tienda: { negocio: { nombre: 'X' }, carta: { categorias: [] } } }).success).toBe(false)
  })
})

describe('username', () => {
  test('usa lo que propone el LLM, normalizado', () => {
    expect(usernameBase('Lo de Pepé!', 'otro')).toBe('lo-de-pepe')
  })
  test('si lo propuesto no sirve, sale del nombre', () => {
    expect(usernameBase('x', 'Panadería Ñandú')).toBe('panaderia-nandu')
    expect(usernameBase(undefined, '!!')).toBe('tienda')
  })
  test('agrega sufijos numéricos', () => {
    expect([...candidatosUsername('pepe', 3)]).toEqual(['pepe', 'pepe-2', 'pepe-3'])
  })
})

describe('zona de reparto', () => {
  test('el círculo tiene 36 puntos a ~el radio del centro', () => {
    const p = circuloAPoligono({ lat: -31.4, lng: -64.18 }, 2500)
    expect(p).toHaveLength(36)
    const dLat = Math.abs(p[9]!.lat - -31.4) * 111_320
    expect(dLat).toBeGreaterThan(2400)
    expect(dLat).toBeLessThan(2600)
  })
})

describe('.zip del diseño', () => {
  const zip = (archivos: Record<string, string | Uint8Array>) =>
    zipSync(Object.fromEntries(Object.entries(archivos).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])))

  test('separa código y assets', () => {
    const r = leerDisenoZip(zip({ 'page.tsx': 'export default 1', 'style.css': 'a{}', 'assets/logo.png': new Uint8Array([1, 2]), 'LEEME.txt': 'x' }))
    expect(Object.keys(r.codigo).sort()).toEqual(['page.tsx', 'style.css'])
    expect(r.assets.map((a) => a.path)).toEqual(['assets/logo.png'])
    expect(r.ignorados).toEqual(['LEEME.txt'])
  })
  test('quita la carpeta raíz y __MACOSX', () => {
    const r = leerDisenoZip(zip({ 'mi-sitio/page.tsx': 'x', 'mi-sitio/secciones/A.tsx': 'y', '__MACOSX/mi-sitio/._page.tsx': 'z' }))
    expect(Object.keys(r.codigo).sort()).toEqual(['page.tsx', 'secciones/A.tsx'])
  })
  test('sin page.tsx o con basura, explica el problema', () => {
    expect(() => leerDisenoZip(zip({ 'style.css': 'a{}' }))).toThrow('page.tsx')
    expect(() => leerDisenoZip(new Uint8Array([1, 2, 3]))).toThrow('.zip válido')
  })
  test('ignora rutas con ..', () => {
    const r = leerDisenoZip(zip({ 'page.tsx': 'x', '../fuera.tsx': 'y' }))
    expect(Object.keys(r.codigo)).toEqual(['page.tsx'])
    expect(r.ignorados[0]).toContain('ruta inválida')
  })
})
