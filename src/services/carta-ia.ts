// Backend/src/services/carta-ia.ts
// Extracción automática de la carta de un restaurante a partir de fotos/diseños del menú.
// Usa Claude (visión) con salida estructurada vía tool_use, siguiendo el mismo patrón de
// llamada a la API de Anthropic que services/whatsapp-ia.ts.
//
// Flujo (agent loop = lógica + LLM):
//   1. Las imágenes se dividen en lotes (una sola llamada tolera varias imágenes, pero
//      cartas largas repartidas en muchas fotos se procesan mejor por lotes).
//   2. Cada lote se extrae en paralelo con una llamada de visión → carta parcial.
//   3. Si hubo más de un lote, un paso de consolidación (LLM, solo texto) fusiona las
//      cartas parciales: unifica categorías duplicadas, normaliza nombres de ingredientes
//      y extras, y elimina productos repetidos que aparecían en varias fotos.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
// Modelo con visión de mayor capacidad — la extracción debe ser prolija y completa.
const CARTA_IA_MODEL = 'claude-opus-4-8'
// Cantidad de imágenes por lote de extracción.
const BATCH_SIZE = 4

// ─── Tipos del resultado ────────────────────────────────────────────────────

export interface VarianteExtraida {
  nombre: string
  precio: number
}

export interface ExtraExtraido {
  nombre: string
  precio: number
}

export interface ProductoExtraido {
  nombre: string
  descripcion?: string | null
  // Precio base. Puede ser null si el producto sólo se vende por variantes.
  precio?: number | null
  ingredientes?: string[]
  variantes?: VarianteExtraida[]
  extras?: ExtraExtraido[]
}

export interface CategoriaExtraida {
  nombre: string
  productos: ProductoExtraido[]
}

export interface CartaExtraida {
  categorias: CategoriaExtraida[]
}

// ─── Tool de salida estructurada ────────────────────────────────────────────

const GUARDAR_CARTA_TOOL = {
  name: 'guardar_carta',
  description:
    'Guarda la carta/menú completa extraída de las imágenes, organizada por categorías y productos.',
  input_schema: {
    type: 'object',
    properties: {
      categorias: {
        type: 'array',
        description: 'Las categorías del menú, en el mismo orden en que aparecen.',
        items: {
          type: 'object',
          properties: {
            nombre: {
              type: 'string',
              description:
                'Nombre de la categoría (ej: "Hamburguesas", "Pizzas", "Bebidas"). Si el menú no tiene categorías, usar "General".',
            },
            productos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  nombre: { type: 'string', description: 'Nombre del producto.' },
                  descripcion: {
                    type: ['string', 'null'],
                    description:
                      'Descripción del producto si aparece en la carta (ej: la lista de lo que trae). Null si no hay.',
                  },
                  precio: {
                    type: ['number', 'null'],
                    description:
                      'Precio base como número, sin símbolos ni separadores de miles. Null si el producto sólo tiene precio por variantes.',
                  },
                  ingredientes: {
                    type: 'array',
                    description:
                      'Ingredientes que componen el producto (para poder quitarlos después). Ej: ["lechuga","tomate","cheddar"]. Vacío si no se especifican.',
                    items: { type: 'string' },
                  },
                  variantes: {
                    type: 'array',
                    description:
                      'Variantes del producto: distintas versiones/tamaños, cada una con su propio precio (ej: "Simple" $5000, "Doble" $6500; o "Chica"/"Grande"). Vacío si no tiene.',
                    items: {
                      type: 'object',
                      properties: {
                        nombre: { type: 'string' },
                        precio: { type: 'number' },
                      },
                      required: ['nombre', 'precio'],
                    },
                  },
                  extras: {
                    type: 'array',
                    description:
                      'Agregados opcionales que suman un precio adicional (ej: "Extra cheddar" +$800, "Huevo" +$500). Vacío si no tiene.',
                    items: {
                      type: 'object',
                      properties: {
                        nombre: { type: 'string' },
                        precio: { type: 'number' },
                      },
                      required: ['nombre', 'precio'],
                    },
                  },
                },
                required: ['nombre'],
              },
            },
          },
          required: ['nombre', 'productos'],
        },
      },
    },
    required: ['categorias'],
  },
} as const

const SYSTEM_EXTRACCION = `Sos un asistente experto en digitalizar cartas de restaurantes gastronómicos de Argentina.
Te van a pasar una o varias imágenes del menú de un local: pueden ser fotos de una carta impresa, de una pizarra, o diseños gráficos digitales.

Tu tarea es extraer TODOS los productos que veas y devolverlos con la tool guardar_carta. Reglas:
- Extraé absolutamente todos los productos visibles. No inventes nada que no esté en la imagen.
- Cada producto PUEDE TENER O NO: nombre, precio, descripción, ingredientes, variantes y extras. Completá sólo lo que realmente aparezca.
- Precios: siempre como número, sin "$", sin puntos de miles ni "ARS". Por ejemplo "$7.200" → 7200.
- Variantes: cuando un mismo producto tiene varias versiones con distinto precio (tamaños como Chica/Grande, o Simple/Doble/Triple, o sabores con precios distintos), cargá cada una en "variantes" con su precio. En ese caso, si no hay un precio base único, dejá "precio" en null.
- Extras / agregados: son adicionales opcionales que suman plata (ej: "agregá bacon +$800"). Van en "extras" con su precio.
- Ingredientes: si la descripción del producto enumera lo que lleva (ej: "carne, cheddar, lechuga, tomate"), cargá cada uno en "ingredientes". Si es una descripción libre que no es una lista de ingredientes, ponela en "descripcion".
- Respetá las categorías tal como están agrupadas en la carta. Si no hay categorías claras, agrupá todo en una categoría "General".
- No dupliques productos si aparecen repetidos entre imágenes.
Llamá SIEMPRE a la tool guardar_carta con el resultado.`

const SYSTEM_CONSOLIDACION = `Vas a recibir varias cartas parciales (en JSON) que fueron extraídas de distintas fotos del menú de un mismo restaurante.
Tu tarea es fusionarlas en una única carta coherente y prolija, y devolverla con la tool guardar_carta. Reglas:
- Unificá categorías con el mismo nombre (o equivalentes) en una sola.
- Eliminá productos duplicados que hayan quedado repetidos entre lotes (mismo producto en varias fotos).
- Normalizá nombres de ingredientes y de extras para que sean consistentes en toda la carta (ej: "Cheddar" y "cheddar" → uno solo).
- No inventes ni elimines información real: sólo fusioná y limpiá.
Llamá SIEMPRE a la tool guardar_carta con la carta final.`

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ImagenParseada {
  media_type: string
  data: string
}

function parseDataUrl(dataUrl: string): ImagenParseada | null {
  const m = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/i)
  if (!m) return null
  const mt = m[1].toLowerCase()
  return { media_type: mt === 'image/jpg' ? 'image/jpeg' : mt, data: m[2] }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function llamarClaudeConTool(system: string, content: any[]): Promise<CartaExtraida> {
  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CARTA_IA_MODEL,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content }],
      tools: [GUARDAR_CARTA_TOOL],
      tool_choice: { type: 'tool', name: 'guardar_carta' },
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    console.error('❌ [Carta IA] Error Anthropic API:', errText)
    throw new Error('No se pudo procesar la carta con IA')
  }

  const data = (await response.json()) as any
  const toolUse = data.content?.find((b: any) => b.type === 'tool_use' && b.name === 'guardar_carta')
  if (!toolUse) {
    console.error('❌ [Carta IA] La respuesta no incluyó la tool guardar_carta:', JSON.stringify(data))
    throw new Error('La IA no devolvió una carta válida')
  }

  return normalizarCarta(toolUse.input as CartaExtraida)
}

// Limpia / valida la estructura para que sea segura de consumir.
function normalizarCarta(raw: any): CartaExtraida {
  const categorias: CategoriaExtraida[] = []
  if (!raw || !Array.isArray(raw.categorias)) return { categorias }

  for (const cat of raw.categorias) {
    if (!cat || typeof cat.nombre !== 'string') continue
    const productos: ProductoExtraido[] = []
    for (const p of Array.isArray(cat.productos) ? cat.productos : []) {
      if (!p || typeof p.nombre !== 'string' || !p.nombre.trim()) continue
      const variantes = (Array.isArray(p.variantes) ? p.variantes : [])
        .filter((v: any) => v && typeof v.nombre === 'string' && v.nombre.trim())
        .map((v: any) => ({ nombre: String(v.nombre).trim(), precio: Number(v.precio) || 0 }))
      const extras = (Array.isArray(p.extras) ? p.extras : [])
        .filter((e: any) => e && typeof e.nombre === 'string' && e.nombre.trim())
        .map((e: any) => ({ nombre: String(e.nombre).trim(), precio: Number(e.precio) || 0 }))
      const ingredientes = (Array.isArray(p.ingredientes) ? p.ingredientes : [])
        .filter((i: any) => typeof i === 'string' && i.trim())
        .map((i: string) => i.trim())

      productos.push({
        nombre: p.nombre.trim(),
        descripcion: typeof p.descripcion === 'string' && p.descripcion.trim() ? p.descripcion.trim() : null,
        precio: p.precio == null ? null : Number(p.precio),
        ingredientes,
        variantes,
        extras,
      })
    }
    if (productos.length > 0) categorias.push({ nombre: cat.nombre.trim() || 'General', productos })
  }
  return { categorias }
}

async function extraerBatch(imagenes: ImagenParseada[]): Promise<CartaExtraida> {
  const content: any[] = imagenes.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.media_type, data: img.data },
  }))
  content.push({
    type: 'text',
    text: 'Extraé toda la carta de estas imágenes y guardala con la tool guardar_carta.',
  })
  return llamarClaudeConTool(SYSTEM_EXTRACCION, content)
}

// Fusión local (concatenación) de las cartas parciales. La deduplicación fina la hace el LLM.
function mergeLocal(partials: CartaExtraida[]): CartaExtraida {
  return { categorias: partials.flatMap((p) => p.categorias) }
}

async function consolidar(carta: CartaExtraida): Promise<CartaExtraida> {
  const content = [
    {
      type: 'text',
      text:
        'Estas son las cartas parciales extraídas de distintas fotos del mismo restaurante. ' +
        'Fusionalas en una sola carta prolija y guardala con la tool guardar_carta.\n\n' +
        JSON.stringify(carta),
    },
  ]
  return llamarClaudeConTool(SYSTEM_CONSOLIDACION, content)
}

// ─── API pública ────────────────────────────────────────────────────────────

/**
 * Extrae la carta completa a partir de una o varias imágenes (data URLs base64).
 */
export async function extraerCartaDeImagenes(dataUrls: string[]): Promise<CartaExtraida> {
  const imagenes = dataUrls.map(parseDataUrl).filter((x): x is ImagenParseada => x !== null)
  if (imagenes.length === 0) throw new Error('No se recibieron imágenes válidas')

  const batches = chunk(imagenes, BATCH_SIZE)
  const partials = await Promise.all(batches.map((b) => extraerBatch(b)))

  let carta = mergeLocal(partials)
  // Solo consolidamos con el LLM si hubo más de un lote (si no, ya viene limpio).
  if (batches.length > 1) {
    try {
      carta = await consolidar(carta)
    } catch (err) {
      // Si la consolidación falla, devolvemos la fusión local (mejor algo que nada).
      console.error('⚠️ [Carta IA] Falló la consolidación, devuelvo fusión local:', err)
    }
  }
  return carta
}
