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

type Entrada = {
  archivos: Record<string, string>
  assets: Record<string, string>
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

  const plugin: BunPlugin = {
    name: 'sitio-piru',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (String(args.kind).startsWith('entry-point')) return { path: args.path, namespace: 'sitio' }
        // Bun informa el namespace del importador como `file`: se distingue por el path.
        const desdeSitio = existe(args.importer)
        if (RUNTIME.has(args.path)) return { path: args.path, external: true }
        if (!desdeSitio) return undefined // imports internos de lucide-react
        // Resolución por defecto (cwd = raíz del backend): devolver la ruta desde el plugin hace que
        // Bun ignore `sideEffects: false` y meta todos los íconos.
        if (args.path === 'lucide-react') return undefined
        if (args.path.startsWith('./') || args.path.startsWith('../')) {
          const destino = resolverRelativo(args.importer, args.path)
          const archivo = destino === null ? null : encontrar(destino)
          if (!archivo) throw new Error(`${args.importer}: no existe "${args.path}"`)
          if (Object.hasOwn(entrada.assets, archivo)) return { path: archivo, namespace: 'sitio-asset' }
          if (archivo.endsWith('.css')) return { path: archivo, namespace: 'sitio-css' }
          return { path: archivo, namespace: 'sitio' }
        }
        throw new Error(`${args.importer}: import no permitido "${args.path}"`)
      })
      build.onLoad({ filter: /.*/, namespace: 'sitio' }, (args) => ({
        contents: entrada.archivos[args.path],
        loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
      }))
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
      entrypoints: ['page.tsx'],
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
        return pos ? `${pos.file.replace(/^sitio:/, '')}:${pos.line}:${pos.column + 1} ${log.message}` : log.message
      })
      process.stdout.write(JSON.stringify({ ok: false, errores }))
      return
    }
    const salida = resultado.outputs.find((o) => o.kind === 'entry-point')
    process.stdout.write(JSON.stringify({ ok: true, js: salida ? await salida.text() : '' }))
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, errores: [String((e as Error)?.message ?? e)] }))
  }
}

void main()
