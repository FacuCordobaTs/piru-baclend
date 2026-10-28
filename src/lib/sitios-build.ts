import { createHash } from 'node:crypto'
import { parse } from '@babel/parser'
import { chequearAst, formatearErrorAst } from './sitios-ast'
import {
  LIMITES,
  encontrarArchivo,
  esImportRelativo,
  extension,
  resolverRelativo,
  type Borrador,
} from './sitios-reglas'

/**
 * Build de un sitio de Páginas (docs/PAGINAS_PROPIAS.md, sección 12, pasos 2 a 4).
 *
 * 1. Chequeo del AST de cada archivo (sin ejecutar nada).
 * 2. CSS: se junta en el orden de import, con `@import` de Google Fonts arriba y los `url()` de
 *    assets reescritos a `/_piru/a/<sha>.<ext>`.
 * 3. JS: `Bun.build` en un subproceso sin variables de entorno, con timeout.
 * 4. Límites de salida (gzip).
 *
 * El resultado no sube nada: `sitios-publicar.ts` decide qué hacer con él.
 */

export type AssetBuild = { path: string; sha: string }

export type ResultadoBuild =
  | {
      ok: true
      js: string
      css: string | null
      jsHash: string
      cssHash: string | null
      /** Assets que el código referencia (los que hay que tener en R2). */
      assetsUsados: string[]
      advertencias: string[]
    }
  | { ok: false; errores: string[] }

export const urlAsset = (asset: AssetBuild) => `/_piru/a/${asset.sha}${extension(asset.path)}`

export const hashContenido = (contenido: string | Uint8Array) =>
  createHash('sha256').update(contenido).digest('hex')

type Grafo = {
  orden: string[]
  css: string[]
  assets: Set<string>
  errores: string[]
  /** Íconos importados de `lucide-react`; `null` si algún import es `* as` o default (todo el paquete). */
  lucide: Set<string> | null
}

/** Recorre los imports desde `page.tsx` en orden: así sale el orden del CSS y los assets usados. */
function recorrerImports(borrador: Borrador, assets: Map<string, AssetBuild>): Grafo {
  const visitados = new Set<string>()
  const grafo: Grafo = { orden: [], css: [], assets: new Set(), errores: [], lucide: new Set() }
  const existe = (p: string) => Object.hasOwn(borrador, p) || assets.has(p)

  const visitar = (archivo: string) => {
    if (visitados.has(archivo)) return
    visitados.add(archivo)
    if (assets.has(archivo)) {
      grafo.assets.add(archivo)
      return
    }
    if (archivo.endsWith('.css')) {
      grafo.css.push(archivo)
      return
    }
    grafo.orden.push(archivo)
    type Especificador = { type: string; imported?: { name?: string; value?: string }; local?: { name?: string } }
    let ast: { program: { body: Array<{ type: string; source?: { value?: unknown } | null; specifiers?: Especificador[] }> } }
    try {
      ast = parse(borrador[archivo], {
        sourceType: 'module',
        plugins: archivo.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
      }) as never
    } catch {
      return // el chequeo de AST ya reporta el error de sintaxis
    }
    for (const sentencia of ast.program.body) {
      const fuente = sentencia.source?.value
      if (fuente === 'lucide-react') {
        for (const e of sentencia.specifiers ?? []) {
          const nombre = e.type === 'ImportSpecifier' ? (e.imported?.name ?? e.imported?.value) : e.type === 'ExportSpecifier' ? e.local?.name : undefined
          if (nombre) grafo.lucide?.add(nombre)
          else grafo.lucide = null
        }
        if (sentencia.type === 'ExportAllDeclaration') grafo.lucide = null
        continue
      }
      if (typeof fuente !== 'string' || !esImportRelativo(fuente)) continue
      if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(sentencia.type)) continue
      const destino = resolverRelativo(archivo, fuente)
      const encontrado = destino === null ? null : encontrarArchivo(destino, existe)
      if (!encontrado) {
        grafo.errores.push(`${archivo}: no existe "${fuente}"`)
        continue
      }
      visitar(encontrado)
    }
  }
  visitar('page.tsx')
  return grafo
}

const FUENTE_EXTERNA = /^https:\/\/fonts\.googleapis\.com\//

/** Junta el CSS en orden, resuelve `@import` locales y reescribe `url()` a los assets. */
export function armarCss(
  archivos: string[],
  borrador: Borrador,
  assets: Map<string, AssetBuild>,
  usados: Set<string>,
): { css: string; errores: string[] } {
  const errores: string[] = []
  const importsExternos: string[] = []
  const incluidos = new Set<string>()
  const existe = (p: string) => Object.hasOwn(borrador, p) || assets.has(p)

  const procesar = (archivo: string): string => {
    if (incluidos.has(archivo)) return ''
    incluidos.add(archivo)
    let css = borrador[archivo] ?? ''
    css = css.replace(/\/\*[\s\S]*?\*\//g, '')
    css = css.replace(/@import\s+(?:url\()?\s*(['"]?)([^'")\s]+)\1\s*\)?([^;]*);/g, (_m, _q, destino: string, resto: string) => {
      if (FUENTE_EXTERNA.test(destino)) {
        importsExternos.push(`@import url("${destino}")${resto};`)
        return ''
      }
      if (!esImportRelativo(destino)) {
        errores.push(`${archivo}: @import no permitido "${destino}". Sólo Google Fonts o CSS del sitio`)
        return ''
      }
      const ruta = resolverRelativo(archivo, destino)
      if (!ruta || !Object.hasOwn(borrador, ruta)) {
        errores.push(`${archivo}: no existe "${destino}"`)
        return ''
      }
      return procesar(ruta)
    })
    css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (original, _q, destino: string) => {
      if (/^(data:|#)/.test(destino)) return original
      if (!esImportRelativo(destino)) {
        if (/^https?:/i.test(destino) && !/^https:\/\/fonts\.gstatic\.com\//.test(destino))
          errores.push(`${archivo}: "${destino}" es externo; subilo como asset`)
        return original
      }
      const ruta = resolverRelativo(archivo, destino)
      const asset = ruta && existe(ruta) ? assets.get(ruta) : undefined
      if (!asset) {
        errores.push(`${archivo}: no existe "${destino}"`)
        return original
      }
      usados.add(asset.path)
      return `url("${urlAsset(asset)}")`
    })
    return `/* ${archivo} */\n${css.trim()}\n`
  }

  const cuerpo = archivos.map(procesar).join('\n')
  return { css: [...new Set(importsExternos), cuerpo].filter(Boolean).join('\n'), errores }
}

export async function construirSitio(
  borrador: Borrador,
  assetsSitio: AssetBuild[],
  opciones: { timeoutMs?: number } = {},
): Promise<ResultadoBuild> {
  if (!Object.hasOwn(borrador, 'page.tsx')) return { ok: false, errores: ['Falta `page.tsx`'] }

  const errores: string[] = []
  for (const [archivo, codigo] of Object.entries(borrador)) {
    if (archivo.endsWith('.css')) continue
    errores.push(...chequearAst(archivo, codigo, { entrada: archivo === 'page.tsx' }).map(formatearErrorAst))
  }
  if (errores.length) return { ok: false, errores }

  const assets = new Map(assetsSitio.map((a) => [a.path, a]))
  const grafo = recorrerImports(borrador, assets)
  if (grafo.errores.length) return { ok: false, errores: grafo.errores }

  const usados = new Set(grafo.assets)
  const { css, errores: erroresCss } = armarCss(grafo.css, borrador, assets, usados)
  if (erroresCss.length) return { ok: false, errores: erroresCss }

  // Sólo viajan al subproceso los archivos alcanzables desde page.tsx; el CSS va vacío porque ya
  // está armado (el import sólo tiene que resolver).
  const archivos = Object.fromEntries([
    ...grafo.orden.map((p) => [p, borrador[p]]),
    ...grafo.css.map((p) => [p, '']),
  ])
  const urls = Object.fromEntries([...grafo.assets].map((p) => [p, urlAsset(assets.get(p)!)]))

  const proceso = Bun.spawn({
    cmd: [process.execPath, `${import.meta.dir}/sitios-build-worker.ts`],
    stdin: new Blob([JSON.stringify({ archivos, assets: urls, lucide: grafo.lucide ? [...grafo.lucide] : null })]),
    cwd: `${import.meta.dir}/../..`,
    stdout: 'pipe',
    stderr: 'pipe',
    // Sin variables del backend: el build nunca ve JWT_SECRET, credenciales de R2 ni de la base.
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'production' },
    timeout: opciones.timeoutMs ?? 10_000,
    killSignal: 'SIGKILL',
  })
  const [salida, codigo] = await Promise.all([new Response(proceso.stdout).text(), proceso.exited])
  let resultado: { ok: boolean; js?: string; errores?: string[] }
  try {
    resultado = JSON.parse(salida)
  } catch {
    const stderr = await new Response(proceso.stderr).text().catch(() => '')
    return {
      ok: false,
      errores: [
        proceso.signalCode === 'SIGKILL' || codigo === null
          ? 'El build tardó demasiado y se cortó'
          : `El build falló${stderr ? `: ${stderr.slice(0, 500)}` : ''}`,
      ],
    }
  }
  if (!resultado.ok || typeof resultado.js !== 'string') return { ok: false, errores: resultado.errores ?? ['El build falló'] }

  const js = resultado.js
  const advertencias: string[] = []
  const jsGzip = Bun.gzipSync(Buffer.from(js)).byteLength
  if (jsGzip > LIMITES.jsGzipBytes)
    return { ok: false, errores: [`El JavaScript pesa ${Math.round(jsGzip / 1000)} KB comprimido (máximo ${LIMITES.jsGzipBytes / 1000} KB)`] }
  const cssFinal = css.trim() ? css : null
  if (cssFinal) {
    const cssGzip = Bun.gzipSync(Buffer.from(cssFinal)).byteLength
    if (cssGzip > LIMITES.cssGzipBytes)
      return { ok: false, errores: [`El CSS pesa ${Math.round(cssGzip / 1000)} KB comprimido (máximo ${LIMITES.cssGzipBytes / 1000} KB)`] }
  }
  for (const path of Object.keys(borrador))
    if (!grafo.orden.includes(path) && !grafo.css.includes(path)) advertencias.push(`${path} no se usa desde page.tsx`)

  return {
    ok: true,
    js,
    css: cssFinal,
    jsHash: hashContenido(js).slice(0, 20),
    cssHash: cssFinal ? hashContenido(cssFinal).slice(0, 20) : null,
    assetsUsados: [...usados],
    advertencias,
  }
}
