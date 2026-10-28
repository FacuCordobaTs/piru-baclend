import { parse } from '@babel/parser'
import { esImportRelativo, importPermitido } from './sitios-reglas'

/**
 * Chequeo estático del código de un sitio antes de compilarlo (docs/PAGINAS_PROPIAS.md, 10.4).
 *
 * No ejecuta nada: parsea con Babel y recorre el árbol. Rechaza lo que la CSP del sitio igual
 * bloquearía (`<script>`, `eval`, `new Function`) y lo que podría ejecutarse durante el build
 * (imports con atributos, que en Bun habilitan macros). También rechaza imports fuera del runtime y
 * `import()` dinámico: el sitio se compila en un solo bundle.
 */

export type ErrorAst = { archivo: string; linea: number; columna: number; mensaje: string }

const IDENTIFICADORES_PROHIBIDOS = new Set(['eval', 'process', 'Bun', 'require', 'Deno', 'globalThis'])

type Nodo = { type: string; loc?: { start: { line: number; column: number } } | null; [k: string]: unknown }

export function chequearAst(archivo: string, codigo: string, opciones: { entrada?: boolean } = {}): ErrorAst[] {
  const errores: ErrorAst[] = []
  const error = (nodo: Nodo | null | undefined, mensaje: string) =>
    errores.push({
      archivo,
      linea: nodo?.loc?.start.line ?? 1,
      columna: (nodo?.loc?.start.column ?? 0) + 1,
      mensaje,
    })

  let ast: Nodo
  try {
    ast = parse(codigo, {
      sourceType: 'module',
      sourceFilename: archivo,
      plugins: archivo.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
      errorRecovery: false,
    }) as unknown as Nodo
  } catch (e) {
    const err = e as { message?: string; loc?: { line: number; column: number } }
    errores.push({
      archivo,
      linea: err.loc?.line ?? 1,
      columna: (err.loc?.column ?? 0) + 1,
      mensaje: `Error de sintaxis: ${(err.message ?? '').replace(/\s*\(\d+:\d+\)$/, '')}`,
    })
    return errores
  }

  let exportDefault = false

  const chequearFuente = (nodo: Nodo, fuente: unknown, atributos: unknown) => {
    if (Array.isArray(atributos) && atributos.length > 0)
      error(nodo, 'No se admiten imports con atributos (`with { … }`)')
    const especificador = (fuente as { value?: unknown } | null)?.value
    if (typeof especificador !== 'string') return
    if (esImportRelativo(especificador)) return
    if (!importPermitido(especificador))
      error(
        nodo,
        `Import no permitido: "${especificador}". Sólo archivos del sitio (./…) y react, react-dom, motion/react, react-router, @piru/tienda y lucide-react`,
      )
  }

  const visitar = (nodo: Nodo, padre: Nodo | null, clavePadre: string | null) => {
    switch (nodo.type) {
      case 'ImportDeclaration':
        chequearFuente(nodo, nodo.source, nodo.attributes ?? nodo.assertions)
        break
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (nodo.source) chequearFuente(nodo, nodo.source, nodo.attributes ?? nodo.assertions)
        break
      case 'ExportDefaultDeclaration':
        exportDefault = true
        break
      case 'ImportExpression':
        error(nodo, 'No se admite `import()` dinámico: el sitio se compila en un solo archivo')
        break
      case 'CallExpression': {
        const callee = nodo.callee as Nodo
        if (callee?.type === 'Import') error(nodo, 'No se admite `import()` dinámico: el sitio se compila en un solo archivo')
        if (callee?.type === 'Identifier' && callee.name === 'Function') error(nodo, 'No se admite `Function(…)`')
        break
      }
      case 'NewExpression': {
        const callee = nodo.callee as Nodo
        if (callee?.type === 'Identifier' && callee.name === 'Function') error(nodo, 'No se admite `new Function`')
        break
      }
      case 'MetaProperty': {
        const meta = nodo.meta as Nodo
        if (meta?.name === 'import') error(nodo, 'No se admite `import.meta`')
        break
      }
      case 'Identifier': {
        const nombre = nodo.name as string
        if (!IDENTIFICADORES_PROHIBIDOS.has(nombre)) break
        // `obj.process` o `{ process: 1 }` no son referencias al global.
        const esPropiedad =
          padre &&
          (((padre.type === 'MemberExpression' || padre.type === 'OptionalMemberExpression') &&
            clavePadre === 'property' &&
            !padre.computed) ||
            ((padre.type === 'ObjectProperty' || padre.type === 'ObjectMethod' || padre.type === 'ClassProperty' || padre.type === 'ClassMethod') &&
              clavePadre === 'key' &&
              !padre.computed) ||
            padre.type === 'TSPropertySignature' ||
            padre.type === 'TSQualifiedName')
        if (!esPropiedad) error(nodo, `No se admite \`${nombre}\``)
        break
      }
      case 'JSXOpeningElement': {
        const nombre = nodo.name as Nodo
        if (nombre?.type === 'JSXIdentifier' && String(nombre.name).toLowerCase() === 'script')
          error(nodo, 'No se admite `<script>` en el JSX')
        break
      }
      case 'JSXAttribute': {
        const nombre = nodo.name as Nodo
        if (nombre?.type === 'JSXIdentifier' && nombre.name === 'dangerouslySetInnerHTML')
          error(nodo, 'No se admite `dangerouslySetInnerHTML`')
        break
      }
    }
    for (const [clave, valor] of Object.entries(nodo)) {
      if (clave === 'loc' || clave === 'start' || clave === 'end' || clave === 'extra' || clave === 'comments' || clave === 'leadingComments' || clave === 'trailingComments' || clave === 'innerComments')
        continue
      if (Array.isArray(valor)) {
        for (const hijo of valor) if (hijo && typeof hijo === 'object' && typeof hijo.type === 'string') visitar(hijo, nodo, clave)
      } else if (valor && typeof valor === 'object' && typeof (valor as Nodo).type === 'string') {
        visitar(valor as Nodo, nodo, clave)
      }
    }
  }

  visitar(ast, null, null)
  if (opciones.entrada && !exportDefault)
    error(null, '`page.tsx` tiene que tener `export default` del componente de la página')
  return errores
}

/** Formato `archivo:línea:columna mensaje`, el mismo que muestra la consola del editor. */
export function formatearErrorAst(e: ErrorAst): string {
  return `${e.archivo}:${e.linea}:${e.columna} ${e.mensaje}`
}
