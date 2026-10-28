/**
 * Subproceso del build de un sitio de Páginas. Lo lanza `sitios-build.ts` sin variables de entorno
 * y con timeout; lee la entrada por stdin y escribe el resultado en stdout. No toca la red ni el
 * disco: los archivos del sitio se resuelven desde memoria con un plugin.
 *
 * Entrada: { archivos: { path: código }, assets: { path: url } }. Corre con cwd en la raíz del
 * backend para que `lucide-react` se resuelva desde su `node_modules`.
 * Salida:  { ok: true, js } | { ok: false, errores: string[] }
 */
import type { BunPlugin } from 'bun'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

type Entrada = {
  archivos: Record<string, string>
  assets: Record<string, string>
  /** Íconos de lucide que usa el sitio, o `null` para el paquete entero. */
  lucide?: string[] | null
}

/**
 * `lucide-react` armado sólo con los íconos usados: cada uno se importa desde su archivo
 * (`dist/esm/icons/<icono>.js`). No depende de que Bun respete `sideEffects` (las versiones
 * anteriores a 1.3 metían los ~1.600 íconos).
 */
function lucideReducido(nombres: string[]): string {
  const paquete = Bun.resolveSync('lucide-react/package.json', process.cwd())
  const base = path.dirname(paquete)
  const entrada = path.join(base, (JSON.parse(readFileSync(paquete, 'utf8')) as { module: string }).module)
  const mapa = new Map<string, { origen: string; archivo: string }>()
  for (const [, lista, archivo] of readFileSync(entrada, 'utf8').matchAll(/export \{([^}]+)\} from '(\.\/[^']+)'/g))
    for (const parte of lista.split(','))
      {
        const [origen, alias] = parte.trim().split(/\s+as\s+/)
        if (origen) mapa.set(alias ?? origen, { origen, archivo: path.join(path.dirname(entrada), archivo) })
      }
  return nombres
    .map((n) => {
      const m = mapa.get(n)
      return m ? `export { ${m.origen} as ${n} } from ${JSON.stringify(m.archivo)}` : `export { ${n} } from ${JSON.stringify(entrada)}`
    })
    .join('\n')
}

const RUNTIME = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'motion/react', 'react-router', '@piru/tienda'])

function resolverRelativo(desde: string, especificador: string): string | null {
  const partes = desde.split('/').slice(0, -1)
  for (const parte of especificador.split('/')) {
    if (parte === '.' || parte === '') continue
    if (parte === '..') {
      if (!partes.length) return null
      partes.pop()
    } else partes.push(parte)
  }
  return partes.join('/')
}

async function main() {
  const entrada = JSON.parse(await Bun.stdin.text()) as Entrada
  const existe = (p: string) => Object.hasOwn(entrada.archivos, p)
  const encontrar = (p: string) => {
    if (existe(p) || Object.hasOwn(entrada.assets, p)) return p
    for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) if (existe(p + ext)) return p + ext
    return null
  }

  // Algunas versiones de Bun exigen que la entrada exista en disco antes de llamar a los plugins:
  // el borrador se escribe en una carpeta temporal y se borra al terminar. Los imports igual se
  // resuelven desde memoria con el plugin.
  const temporal = mkdtempSync(path.join(tmpdir(), 'piru-sitio-'))
  for (const [archivo, codigo] of Object.entries(entrada.archivos)) {
    const destino = path.join(temporal, archivo)
    mkdirSync(path.dirname(destino), { recursive: true })
    writeFileSync(destino, codigo)
  }
  // El build corre dentro de esa carpeta, con su propio tsconfig de React (el del backend usa
  // `hono/jsx` y Bun anterior a 1.3 ignora la opción `jsx` de `Bun.build`) y los `node_modules` del
  // backend enlazados para resolver `lucide-react`.
  writeFileSync(
    path.join(temporal, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'react' } }),
  )
  symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(temporal, 'node_modules'), 'dir')
  process.chdir(temporal)
  /** Path del sitio (`components/a.tsx`) aunque el importador venga como ruta absoluta del disco. */
  const delSitio = (p: string) => (p.startsWith(temporal + path.sep) ? p.slice(temporal.length + 1) : p)

  const plugin: BunPlugin = {
    name: 'sitio-piru',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (String(args.kind).startsWith('entry-point')) return { path: 'page.tsx', namespace: 'sitio' }
        // Bun informa el namespace del importador como `file`: se distingue por el path.
        const importador = delSitio(args.importer)
        const desdeSitio = existe(importador)
        if (RUNTIME.has(args.path)) return { path: args.path, external: true }
        if (!desdeSitio) return undefined // imports internos de lucide-react
        // Resolución por defecto (cwd = raíz del backend): devolver la ruta desde el plugin hace que
        // Bun ignore `sideEffects: false` y meta todos los íconos.
        if (args.path === 'lucide-react') return entrada.lucide ? { path: 'lucide-react', namespace: 'lucide' } : undefined
        if (args.path.startsWith('./') || args.path.startsWith('../')) {
          const destino = resolverRelativo(importador, args.path)
          const archivo = destino === null ? null : encontrar(destino)
          if (!archivo) throw new Error(`${importador}: no existe "${args.path}"`)
          if (Object.hasOwn(entrada.assets, archivo)) return { path: archivo, namespace: 'sitio-asset' }
          if (archivo.endsWith('.css')) return { path: archivo, namespace: 'sitio-css' }
          return { path: archivo, namespace: 'sitio' }
        }
        throw new Error(`${importador}: import no permitido "${args.path}"`)
      })
      build.onLoad({ filter: /.*/, namespace: 'sitio' }, (args) => ({
        contents: entrada.archivos[args.path],
        loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
      }))
      build.onLoad({ filter: /.*/, namespace: 'lucide' }, () => ({ contents: lucideReducido(entrada.lucide ?? []), loader: 'js' }))
      build.onLoad({ filter: /.*/, namespace: 'sitio-asset' }, (args) => ({
        contents: `export default ${JSON.stringify(entrada.assets[args.path])}`,
        loader: 'js',
      }))
      // El CSS lo junta el proceso padre en orden de import; acá sólo se descarta el import.
      build.onLoad({ filter: /.*/, namespace: 'sitio-css' }, () => ({ contents: 'export {}', loader: 'js' }))
    },
  }

  try {
    const resultado = await Bun.build({
      entrypoints: [path.join(temporal, 'page.tsx')],
      plugins: [plugin],
      target: 'browser',
      format: 'esm',
      minify: true,
      splitting: false,
      sourcemap: 'none',
      // El tsconfig del backend usa `hono/jsx`: el sitio es React.
      ...({ jsx: { runtime: 'automatic', importSource: 'react' } } as object),
      define: { 'process.env.NODE_ENV': '"production"' },
      throw: false,
    })
    if (!resultado.success) {
      const errores = resultado.logs.map((log) => {
        const pos = log.position
        return pos ? `${delSitio(pos.file.replace(/^sitio:/, ''))}:${pos.line}:${pos.column + 1} ${log.message}` : log.message
      })
      process.stdout.write(JSON.stringify({ ok: false, errores }))
      return
    }
    const salida = resultado.outputs.find((o) => o.kind === 'entry-point')
    process.stdout.write(JSON.stringify({ ok: true, js: salida ? await salida.text() : '' }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, errores: [String((e as Error)?.message ?? e)] }))
  } finally {
    rmSync(temporal, { recursive: true, force: true })
  }
}

void main()
