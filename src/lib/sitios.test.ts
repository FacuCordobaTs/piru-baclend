import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { chequearAst } from './sitios-ast'
import { armarCss, construirSitio } from './sitios-build'
import { validarBorrador, resolverRelativo, pathValido, importPermitido, PAQUETES_RUNTIME, PAQUETES_EMBEBIDOS, EXTENSIONES_CODIGO, TIPOS_ASSET } from './sitios-reglas'
import { slugDisponible, SLUGS_REGISTRADOS } from './sitios-slugs'
import { esSitioDePaginas, fijarPublicados, paginasApiPath } from './sitios-publicados'
import { sitiosPuede, marketerPuede, duenioAppMarketingPuede, marketerPuedeSocketAdmin } from './marketer-permisos'
import { PLANTILLA_INICIAL, plantillaInicial } from './sitios-plantilla'
import { generarGuia } from './sitios-guia'
import { urlRetornoPedido } from './marketing-enlaces'
import { normalizarMeta } from './sitios-meta'

describe('reglas del borrador', () => {
  test('acepta código y rechaza rutas, extensiones y tamaños inválidos', () => {
    expect(validarBorrador({ 'page.tsx': 'x', 'components/Hero.tsx': 'y', 'style.css': 'z' }).problemas).toEqual([])
    for (const malo of [{ '../page.tsx': 'x' }, { '/page.tsx': 'x' }, { 'page.js': 'x' }, { 'assets/a.png': 'x' }, { 'a//b.ts': 'x' }, { 'page.tsx': 3 }])
      expect(validarBorrador(malo).problemas.length).toBeGreaterThan(0)
    expect(validarBorrador({ 'page.tsx': 'x'.repeat(1_000_001) }).problemas[0].mensaje).toContain('1 MB')
    expect(validarBorrador([]).problemas.length).toBe(1)
  })

  test('los imports relativos no salen del sitio', () => {
    expect(resolverRelativo('components/a.tsx', '../style.css')).toBe('style.css')
    expect(resolverRelativo('page.tsx', '../../etc/passwd')).toBeNull()
    expect(pathValido('assets/logo.png')).toBe(true)
    expect(pathValido('assets/../x.png')).toBe(false)
    expect(importPermitido('lucide-react')).toBe(true)
    expect(importPermitido('lodash')).toBe(false)
  })

  test('la copia de las reglas del editor coincide con la del backend', () => {
    const editor = new URL('../../../sitios/src/lib/build-rules.ts', import.meta.url)
    if (!existsSync(editor)) return
    const texto = readFileSync(editor, 'utf8')
    for (const p of [...PAQUETES_RUNTIME, ...PAQUETES_EMBEBIDOS, ...EXTENSIONES_CODIGO, ...Object.keys(TIPOS_ASSET)])
      expect(texto).toContain(`'${p}'`)
  })
})

describe('chequeo del AST', () => {
  const errores = (codigo: string, entrada = true) => chequearAst('page.tsx', codigo, { entrada }).map((e) => e.mensaje)

  test('rechaza lo que podría ejecutarse o saltear la CSP', () => {
    const casos = [
      'export default () => <script>alert(1)</script>',
      'export default () => <div dangerouslySetInnerHTML={{ __html: "x" }} />',
      'eval("1"); export default () => null',
      'new Function("x"); export default () => null',
      'Function("x")(); export default () => null',
      'console.log(import.meta.url); export default () => null',
      'process.env.X; export default () => null',
      'Bun.file("x"); export default () => null',
      'globalThis["ev" + "al"]; export default () => null',
      'import x from "./a" with { type: "macro" }; export default () => null',
      'import _ from "lodash"; export default () => null',
      'import fs from "node:fs"; export default () => null',
      'import x from "https://evil.com/x.js"; export default () => null',
      'export default async () => { await import("./x") }',
      'export * from "fs"; export default () => null',
    ]
    for (const codigo of casos) expect(errores(codigo).length).toBeGreaterThan(0)
  })

  test('acepta código normal y propiedades con nombres prohibidos', () => {
    expect(errores('import { useLocal } from "@piru/tienda"\nconst o = { process: 1, eval: 2 }\nexport default function P() { return <p>{o.process}{window.location.href}</p> }')).toEqual([])
  })

  test('page.tsx necesita export default', () => {
    expect(errores('export const P = 1')).toContain('`page.tsx` tiene que tener `export default` del componente de la página')
    expect(errores('export const P = 1', false)).toEqual([])
  })

  test('los errores de sintaxis dicen archivo y línea', () => {
    const [e] = chequearAst('components/a.tsx', 'const a = 1\nconst = 2')
    expect(e.archivo).toBe('components/a.tsx')
    expect(e.linea).toBe(2)
  })
})

describe('build', () => {
  test('compila la plantilla inicial con el runtime como externo y lucide adentro', async () => {
    const r = await construirSitio(PLANTILLA_INICIAL, [])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const imports = new Set(r.js.match(/from"([^"]+)"/g))
    expect([...imports].every((i) => /react|motion\/react|@piru\/tienda/.test(i))).toBe(true)
    expect(r.js).not.toContain('lucide-react')
    expect(r.js.length).toBeLessThan(40_000)
    expect(r.css).toStartWith('@import url("https://fonts.googleapis.com/')
    expect(r.jsHash).toMatch(/^[a-f0-9]{20}$/)
  }, 20_000)

  test('el contenido elegido queda escrito en contenido.ts y el diseño lo importa', () => {
    const borrador = plantillaInicial({
      plantilla: 'moderna',
      marca: { colorPrimario: '#E63A1E', colorSecundario: '#FFC21A', usarColorUnico: false },
      logo: 'https://images.piru.app/tiendas/1/logo.png',
      logoClaro: null,
      frase: 'Smash, cheddar y cero vueltas.',
      cinta: ['Smash burgers'],
    })
    expect(borrador['contenido.ts']).toContain('/* piru:contenido */')
    expect(borrador['contenido.ts']).toContain('"frase": "Smash, cheddar y cero vueltas."')
    expect(borrador['contenido.ts']).toContain('"colorPrimario": "#E63A1E"')
    expect(borrador['page.tsx']).toContain('CONTENIDO')
    expect(borrador['page.tsx']).not.toContain('useContenido')
  })

  test('la plantilla inicial nace de las preferencias y compone las tres plantillas', () => {
    const page = PLANTILLA_INICIAL['page.tsx'] ?? ''
    const css = PLANTILLA_INICIAL['style.css'] ?? ''
    expect(page).toContain('CONTENIDO')
    expect(page).toContain('from "./contenido"')
    expect(page).toContain('pv-${plantilla}')
    for (const plantilla of ['elegante', 'moderna', 'artesanal']) expect(css).toContain(`.pv-${plantilla}`)
  })

  test('reescribe assets en JS y CSS y avisa archivos sin usar', async () => {
    const r = await construirSitio(
      {
        'page.tsx': 'import foto from "./assets/a.png"\nimport "./style.css"\nexport default () => <img src={foto} />',
        'style.css': '.x{background:url("./assets/a.png")}',
        'otro.ts': 'export const x = 1',
      },
      [{ path: 'assets/a.png', sha: 'f'.repeat(64) }],
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.js).toContain(`/_piru/a/${'f'.repeat(64)}.png`)
    expect(r.css).toContain(`url("/_piru/a/${'f'.repeat(64)}.png")`)
    expect(r.assetsUsados).toEqual(['assets/a.png'])
    expect(r.advertencias).toEqual(['otro.ts no se usa desde page.tsx'])
  }, 20_000)

  test('falla con archivo:línea y sin page.tsx', async () => {
    expect(await construirSitio({ 'style.css': '' }, [])).toEqual({ ok: false, errores: ['Falta `page.tsx`'] })
    const r = await construirSitio({ 'page.tsx': 'import X from "./no-existe"\nexport default X' }, [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errores[0]).toContain('no-existe')
  }, 20_000)

  test('el CSS sólo admite @import de Google Fonts o del sitio', () => {
    const { errores } = armarCss(['style.css'], { 'style.css': '@import "https://evil.com/x.css"; .a{background:url(https://evil.com/x.png)}' }, new Map(), new Set())
    expect(errores.length).toBe(2)
  })
})

describe('slugs y orígenes de Páginas', () => {
  test('ni infraestructura ni diseños registrados', () => {
    expect(slugDisponible('bronx')).toEqual({ ok: true })
    for (const s of ['pages', 'paginas', 'sitios', 'checkout', 'admin', 'my', ...SLUGS_REGISTRADOS, 'con_guion', 'a'])
      expect(slugDisponible(s).ok).toBe(false)
  })

  test('el registro de diseños de web coincide con la lista del backend', () => {
    const registro = new URL('../../../web/src/store-sites/registry.ts', import.meta.url)
    if (!existsSync(registro)) return
    const claves = [...readFileSync(registro, 'utf8').matchAll(/^\s{4}([a-z0-9-]+): \{/gm)].map((m) => m[1])
    expect(claves.sort()).toEqual([...SLUGS_REGISTRADOS].sort())
  })

  test('un sitio de Páginas sólo llega a su lista cerrada', () => {
    for (const p of ['/api/public/restaurante/id/42', '/public/restaurante/bronx', '/api/public/marketing/campanas/bronx/promo', '/api/public/marketing/recetas/bronx/tok', '/api/public/marketing/events', '/api/public/carritos', '/api/public/carritos/abcDEF_-'])
      expect(paginasApiPath(p)).toBe(true)
    for (const p of ['/api/mp/process-brick', '/api/public/delivery/create', '/api/public/takeaway/create', '/api/public/sala/create', '/api/public/descuentos/validar', '/api/public/restaurante/42/cliente/3424', '/api/public/restaurante/42/mis-pedidos/3424', '/api/restaurante/profile'])
      expect(paginasApiPath(p)).toBe(false)
    fijarPublicados(['bronx'])
    expect(esSitioDePaginas('bronx')).toBe(true)
    expect(esSitioDePaginas('otra')).toBe(false)
    fijarPublicados([])
  })

  test('la vuelta de Mercado Pago de un sitio de Páginas es my.piru.app', () => {
    expect(urlRetornoPedido('bronx.piru.app', 7, (s) => s === 'bronx')).toBe('https://my.piru.app/pedido/7')
    expect(urlRetornoPedido('burgers10.piru.app', 7, (s) => s === 'bronx')).toBe('https://burgers10.piru.app/pedido/7')
    expect(urlRetornoPedido('pizza.com', 7, () => true)).toBe('https://pizza.com/pedido/7')
    expect(urlRetornoPedido(null, 7)).toBe('https://my.piru.app/pedido/7')
  })
})

describe('permisos de la sesión de Páginas', () => {
  test('sólo /sitios, nunca el pase ni otras rutas', () => {
    expect(sitiosPuede('GET', '/api/sitios')).toBe(true)
    expect(sitiosPuede('PUT', '/api/sitios/3/borrador')).toBe(true)
    expect(sitiosPuede('POST', '/api/sitios/3/publicar')).toBe(true)
    expect(sitiosPuede('GET', '/api/sitios/base')).toBe(true)
    expect(sitiosPuede('POST', '/api/sitios/imagenes')).toBe(true)
    for (const [m, p] of [['POST', '/api/sitios/entrada'], ['GET', '/api/restaurante/profile'], ['GET', '/api/sitios/../restaurante/profile'], ['GET', '/api/sitiosx'], ['DELETE', '/api/clientes/1']])
      expect(sitiosPuede(m, p)).toBe(false)
  })

  test('el marketer, la app de marketing y el socket de pedidos no entran', () => {
    expect(marketerPuede('GET', '/api/sitios')).toBe(false)
    expect(duenioAppMarketingPuede('POST', '/api/sitios/1/publicar')).toBe(false)
    expect(marketerPuedeSocketAdmin({ id: 4, scope: 'restaurante', appSitios: true })).toBe(false)
    expect(marketerPuedeSocketAdmin({ id: 4, scope: 'restaurante' })).toBe(true)
  })

  test('los metadatos sólo aceptan textos cortos, colores y assets de imagen', () => {
    expect(normalizarMeta({ titulo: ' Bronx ', themeColor: '#161310', ogImage: 'assets/og.jpg', icono: 'https://evil.com/x.png', loadingBackground: 'red', otro: 1 })).toEqual({
      titulo: 'Bronx',
      themeColor: '#161310',
      ogImage: 'assets/og.jpg',
    })
  })
})

describe('guía para Claude', () => {
  test('incluye reglas, tipos del SDK, ejemplo y los datos reales', () => {
    const md = generarGuia({
      nombre: 'Bronx',
      username: 'bronx',
      restaurante: { nombre: 'Bronx', colorPrimario: '#EAC133', password: 'clave-ultra-privada', transferenciaAlias: 'x' },
      productos: [{ id: 1, nombre: 'Doble cheddar', precio: '9000', categoria: 'Burgers' }],
      horarios: [],
      assets: ['assets/logo.png'],
      contenido: PLANTILLA_INICIAL['contenido.ts'] ?? '',
    })
    expect(md).toContain('https://bronx.piru.app')
    expect(md).toContain("declare module '@piru/tienda'")
    expect(md).toContain('export default function Page()')
    expect(md).toContain('contenido.ts')
    expect(md).toContain('Doble cheddar')
    expect(md).toContain('assets/logo.png')
    expect(md).not.toContain('clave-ultra-privada')
    expect(md).not.toContain('transferenciaAlias')
  })
})
