import { strFromU8, unzipSync } from 'fflate'
import { z } from 'zod'
import { cartaJsonSchema, INSTRUCTIVO_CARTA_JSON, negocioCartaJsonSchema } from './carta-json'
import { esAsset, esCodigo, LIMITES, pathValido } from './sitios-reglas'

/**
 * Tiendas demo que arma el servidor de prospección (`/api/prospeccion/*`).
 *
 * El JSON de la tienda cubre lo que pide el onboarding del admin (`pages/Onboarding.tsx`): negocio,
 * colores, horarios, entrega, pagos y carta. Todo lo que no viene toma el mismo valor por defecto
 * que el onboarding, así una tienda mínima (nombre + carta) queda completa.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Usá HH:MM (ej: 19:00)')
const hex = z.string().regex(/^#[0-9a-f]{6}$/i, 'Usá #RRGGBB (ej: #FF7A00)')

export const COLORES_POR_DEFECTO = { primario: '#FF7A00', secundario: '#FFFFFF', unico: true } as const
export const HORARIOS_POR_DEFECTO = [{ apertura: '19:00', cierre: '23:30' }]
export const ENTREGA_POR_DEFECTO = { delivery: true, retiro: true, precioEnvio: 0, radioMetros: 2500 } as const
export const PAGOS_POR_DEFECTO = { efectivo: true, transferencia: true } as const

export const tiendaProspectoSchema = z.object({
  /** Datos del local. Sólo `nombre` es obligatorio. `username` es el subdominio que propone el LLM. */
  negocio: negocioCartaJsonSchema.extend({
    nombre: z.string().trim().min(1, 'El negocio necesita un nombre').max(255),
    username: z.string().trim().max(60).optional(),
  }),
  colores: z
    .object({
      primario: hex.default(COLORES_POR_DEFECTO.primario),
      secundario: hex.default(COLORES_POR_DEFECTO.secundario),
      unico: z.boolean().default(COLORES_POR_DEFECTO.unico),
    })
    .default({ ...COLORES_POR_DEFECTO }),
  /** Turnos de atención; se repiten todos los días, como en el onboarding. */
  horarios: z
    .array(z.object({ apertura: hhmm, cierre: hhmm }))
    .min(1)
    .max(3)
    .default(HORARIOS_POR_DEFECTO),
  entrega: z
    .object({
      delivery: z.boolean().default(ENTREGA_POR_DEFECTO.delivery),
      retiro: z.boolean().default(ENTREGA_POR_DEFECTO.retiro),
      precioEnvio: z.number().finite().min(0).default(ENTREGA_POR_DEFECTO.precioEnvio),
      radioMetros: z.number().int().min(300).max(30_000).default(ENTREGA_POR_DEFECTO.radioMetros),
    })
    .default({ ...ENTREGA_POR_DEFECTO }),
  pagos: z
    .object({
      efectivo: z.boolean().default(PAGOS_POR_DEFECTO.efectivo),
      transferencia: z.boolean().default(PAGOS_POR_DEFECTO.transferencia),
      alias: z.string().trim().max(60).optional(),
    })
    .default({ ...PAGOS_POR_DEFECTO }),
  carta: cartaJsonSchema,
})

export type TiendaProspecto = z.output<typeof tiendaProspectoSchema>

export const crearTiendaSchema = z.object({
  /** Clave idempotente (por ejemplo el id del prospecto): reintentar con la misma no duplica la tienda. */
  prospectoRef: z.string().trim().min(1).max(64).regex(/^[\w.:-]+$/, 'Sólo letras, números y . : _ -'),
  tienda: tiendaProspectoSchema,
})

export function erroresDeZod(error: z.ZodError): string[] {
  return error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
}

// ─── Username ───────────────────────────────────────────────────────────────

/** Subdominio válido a partir de lo que propone el LLM o, si no sirve, del nombre del negocio. */
export function usernameBase(propuesto: string | undefined, nombre: string): string {
  const limpiar = (v: string) =>
    v
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '')
  for (const candidato of [propuesto ?? '', nombre]) {
    const slug = limpiar(candidato)
    if (slug.length >= 3) return slug
  }
  return 'tienda'
}

/** `base`, `base-2`, `base-3`… hasta `max` intentos. */
export function* candidatosUsername(base: string, max = 20): Generator<string> {
  yield base
  for (let n = 2; n <= max; n++) yield `${base}-${n}`
}

// ─── Zona de delivery ───────────────────────────────────────────────────────

/** Círculo como polígono, para guardar el radio de reparto como zona (igual que el onboarding). */
export function circuloAPoligono(centro: { lat: number; lng: number }, radioMetros: number, puntos = 36) {
  const R = 6378137
  return Array.from({ length: puntos }, (_, i) => {
    const angulo = (i / puntos) * 2 * Math.PI
    const dLat = ((radioMetros * Math.sin(angulo)) / R) * (180 / Math.PI)
    const dLng = ((radioMetros * Math.cos(angulo)) / (R * Math.cos((centro.lat * Math.PI) / 180))) * (180 / Math.PI)
    return { lat: centro.lat + dLat, lng: centro.lng + dLng }
  })
}

// ─── .zip del diseño ────────────────────────────────────────────────────────

export const ZIP_MAX_BYTES = 20_000_000
const ZIP_MAX_DESCOMPRIMIDO = 40_000_000

export type DisenoZip = {
  codigo: Record<string, string>
  assets: { path: string; bytes: Uint8Array }[]
  ignorados: string[]
}

/**
 * Lee el `.zip` que devuelve Claude con las mismas reglas que el editor de Páginas
 * (`sitios/src/pages/Editor.tsx`): se quita la carpeta raíz, el código va al borrador y las
 * imágenes/fuentes a `assets/`. Lanza `Error` con un mensaje para el LLM si no sirve.
 */
export function leerDisenoZip(bytes: Uint8Array): DisenoZip {
  if (bytes.byteLength > ZIP_MAX_BYTES) throw new Error(`El .zip supera ${ZIP_MAX_BYTES / 1_000_000} MB`)
  let declarado = 0
  let entradas: Record<string, Uint8Array>
  try {
    entradas = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith('/') || f.name.startsWith('__MACOSX/')) return false
        // Declarado en el encabezado; fflate no descomprime más de lo que reserva.
        declarado += f.originalSize
        if (declarado > ZIP_MAX_DESCOMPRIMIDO) throw new Error('El .zip descomprimido es demasiado grande')
        return true
      },
    })
  } catch (e) {
    throw new Error(e instanceof Error && e.message.includes('grande') ? e.message : 'El archivo no es un .zip válido')
  }

  const nombres = Object.keys(entradas)
  const raiz = nombres.length > 0 && nombres.every((n) => n.includes('/')) ? `${nombres[0]!.split('/')[0]}/` : ''
  const resultado: DisenoZip = { codigo: {}, assets: [], ignorados: [] }
  for (const nombre of nombres) {
    const path = raiz && nombre.startsWith(raiz) ? nombre.slice(raiz.length) : nombre
    const contenido = entradas[nombre]!
    if (!pathValido(path)) resultado.ignorados.push(`${nombre} (ruta inválida)`)
    else if (esCodigo(path)) resultado.codigo[path] = strFromU8(contenido)
    else if (esAsset(path)) {
      if (contenido.byteLength > LIMITES.assetBytes) resultado.ignorados.push(`${path} (supera 8 MB)`)
      else resultado.assets.push({ path, bytes: contenido })
    } else resultado.ignorados.push(path)
  }
  if (!resultado.codigo['page.tsx']) throw new Error('El .zip no tiene page.tsx en la raíz')
  return resultado
}

// ─── Instructivo para el LLM ────────────────────────────────────────────────

export const TIENDA_JSON_EJEMPLO = {
  negocio: {
    nombre: 'Lo de Pepe',
    username: 'lodepepe',
    telefono: '5493511234567',
    direccion: 'Av. Colón 1234, Córdoba',
    logoUrl: 'https://ejemplo.com/logo.png',
  },
  colores: { primario: '#C0392B', secundario: '#FFFFFF', unico: true },
  horarios: [{ apertura: '12:00', cierre: '15:00' }, { apertura: '20:00', cierre: '23:30' }],
  entrega: { delivery: true, retiro: true, precioEnvio: 1500, radioMetros: 3000 },
  pagos: { efectivo: true, transferencia: true, alias: 'lodepepe.mp' },
  carta: {
    categorias: [
      {
        nombre: 'Hamburguesas',
        productos: [{ nombre: 'Clásica', descripcion: 'Carne, cheddar y lechuga', precio: 7200, imagenUrl: 'https://ejemplo.com/clasica.jpg' }],
      },
    ],
  },
}

export const INSTRUCTIVO_TIENDA_JSON = `# Instructivo para que una IA arme la tienda de un local en JSON

Armá **un único objeto JSON** (sin comentarios ni texto alrededor) con los datos del local. Sólo \`negocio.nombre\` y \`carta\` son obligatorios: lo que falte toma el valor por defecto indicado.

| Campo | Qué es | Por defecto |
|---|---|---|
| \`negocio.nombre\` | Nombre del local | — (obligatorio) |
| \`negocio.username\` | Subdominio que proponés: \`<username>.piru.app\`. Minúsculas, números y guiones, 3 a 40 caracteres. Si está ocupado, se le agrega un número | derivado del nombre |
| \`negocio.telefono\` | WhatsApp del local con código de área (ej. 5493511234567) | sin WhatsApp |
| \`negocio.direccion\`, \`negocio.lat\`, \`negocio.lng\` | Dirección y coordenadas. Con dirección y sin coordenadas, se geolocaliza sola | sin dirección |
| \`negocio.logoUrl\` | URL directa a una imagen del logo (se copia a Piru) | sin logo |
| \`colores.primario\`, \`colores.secundario\` | \`#RRGGBB\` de la marca | \`#FF7A00\` y \`#FFFFFF\` |
| \`colores.unico\` | \`true\` si la marca usa un solo color | \`true\` |
| \`horarios\` | Hasta 3 turnos \`{ "apertura": "HH:MM", "cierre": "HH:MM" }\`, todos los días | 19:00–23:30 |
| \`entrega.delivery\` / \`entrega.retiro\` | Si hace envíos / retiro en el local | \`true\` / \`true\` |
| \`entrega.precioEnvio\` | Costo de envío en pesos | \`0\` |
| \`entrega.radioMetros\` | Radio de reparto en metros (300 a 30000); necesita dirección | \`2500\` |
| \`pagos.efectivo\` / \`pagos.transferencia\` | Medios de pago aceptados | \`true\` / \`true\` |
| \`pagos.alias\` | Alias o CBU para transferencias | vacío |
| \`carta\` | La carta, con el formato de más abajo | — (obligatorio) |

Ejemplo:

\`\`\`json
${JSON.stringify(TIENDA_JSON_EJEMPLO, null, 2)}
\`\`\`

No inventes datos: si algo no está en la fuente, omitilo. El campo \`carta\` sigue este instructivo (en el JSON de la tienda va dentro de \`carta\`, y **no** se repite \`negocio\` ahí adentro):

---

${INSTRUCTIVO_CARTA_JSON}
`
