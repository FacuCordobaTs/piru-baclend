import { z } from 'zod'

// ─── Contrato de la carta en JSON ───────────────────────────────────────────
// Es el mismo que usa la extracción con IA, pero pensado para que lo genere un
// LLM (o una persona) y se pueda importar desde el onboarding. El instructivo
// descargable y la validación viven juntos para que nunca se desincronicen.

export const INSTRUCTIVO_CARTA_JSON_VERSION = '1.0'
export const INSTRUCTIVO_CARTA_JSON_ARCHIVO = 'carta-json-piru.md'

const precioImportado = z.union([
  z.number().finite().min(0, 'El precio no puede ser negativo'),
  z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d{1,2})?$/, 'Usá un número sin "$" ni separadores de miles (ej: 7200 o 7200.50)')
    .transform(Number),
])

export const opcionCartaJsonSchema = z.object({
  nombre: z.string().trim().min(1, 'Cada opción necesita un nombre').max(255),
  precio: precioImportado,
})

export const productoCartaJsonSchema = z.object({
  nombre: z.string().trim().min(1, 'Cada producto necesita un nombre').max(255),
  descripcion: z.string().trim().max(255, 'La descripción no puede superar los 255 caracteres').nullish(),
  precio: precioImportado.nullish(),
  ingredientes: z.array(z.string().trim().min(1, 'Un ingrediente no puede estar vacío')).max(100).optional(),
  variantes: z.array(opcionCartaJsonSchema).max(100).optional(),
  extras: z.array(opcionCartaJsonSchema).max(100).optional(),
  variantesSecundarias: z.array(opcionCartaJsonSchema).max(100).optional(),
  extrasSecundarios: z.array(opcionCartaJsonSchema).max(100).optional(),
  tituloVariantesPrimarias: z.string().trim().min(1, 'El título no puede estar vacío').max(120).optional(),
  tituloVariantesSecundarias: z.string().trim().min(1, 'El título no puede estar vacío').max(120).optional(),
  tituloExtrasPrimarios: z.string().trim().min(1, 'El título no puede estar vacío').max(120).optional(),
  tituloExtrasSecundarios: z.string().trim().min(1, 'El título no puede estar vacío').max(120).optional(),
  permiteNota: z.boolean().optional(),
  tituloNota: z.string().trim().min(1, 'El título no puede estar vacío').max(120).optional(),
})

export const categoriaCartaJsonSchema = z.object({
  nombre: z.string().trim().min(1, 'Cada categoría necesita un nombre').max(255),
  esBebida: z.boolean().optional(),
  productos: z.array(productoCartaJsonSchema).min(1, 'Cada categoría necesita al menos un producto').max(500),
})

export const cartaJsonSchema = z
  .object({
    categorias: z.array(categoriaCartaJsonSchema).min(1, 'La carta necesita al menos una categoría').max(100),
  })
  .superRefine((carta, ctx) => {
    let totalProductos = 0
    carta.categorias.forEach((categoria, categoriaIdx) => {
      categoria.productos.forEach((producto, productoIdx) => {
        totalProductos++
        if (producto.variantesSecundarias?.length && !producto.variantes?.length) {
          ctx.addIssue({
            code: 'custom',
            path: ['categorias', categoriaIdx, 'productos', productoIdx, 'variantesSecundarias'],
            message: 'La segunda elección necesita variantes principales',
          })
        }
      })
    })
    if (totalProductos > 2000) {
      ctx.addIssue({
        code: 'custom',
        path: ['categorias'],
        message: 'La carta supera los 2000 productos; dividila en partes más chicas',
      })
    }
  })

export type CartaJson = z.infer<typeof cartaJsonSchema>
export type ProductoCartaJson = z.infer<typeof productoCartaJsonSchema>

const clave = (texto: string) => texto.trim().toLowerCase()

function opcionesNormalizadas(opciones: { nombre: string; precio: number }[] | undefined) {
  return (opciones ?? []).map((opcion) => ({ nombre: opcion.nombre.trim(), precio: Number(opcion.precio) }))
}

function tituloNormalizado(titulo: string | undefined) {
  const limpio = titulo?.trim()
  return limpio ? limpio.slice(0, 120) : undefined
}

/** Convierte el JSON validado a la forma que consume el onboarding y /crear. */
export function normalizarCartaJson(carta: CartaJson) {
  return {
    categorias: carta.categorias.map((categoria) => ({
      nombre: categoria.nombre.trim(),
      esBebida: categoria.esBebida === true,
      productos: categoria.productos.map((producto) => ({
        nombre: producto.nombre.trim(),
        descripcion: producto.descripcion?.trim() || null,
        precio: producto.precio == null ? null : Number(producto.precio),
        ingredientes: (producto.ingredientes ?? []).map((ingrediente) => ingrediente.trim()).filter(Boolean),
        variantes: opcionesNormalizadas(producto.variantes),
        variantesSecundarias: producto.variantes?.length ? opcionesNormalizadas(producto.variantesSecundarias) : [],
        extras: opcionesNormalizadas(producto.extras),
        extrasSecundarios: opcionesNormalizadas(producto.extrasSecundarios),
        tituloVariantesPrimarias: tituloNormalizado(producto.tituloVariantesPrimarias),
        tituloVariantesSecundarias: tituloNormalizado(producto.tituloVariantesSecundarias),
        tituloExtrasPrimarios: tituloNormalizado(producto.tituloExtrasPrimarios),
        tituloExtrasSecundarios: tituloNormalizado(producto.tituloExtrasSecundarios),
        permiteNota: producto.permiteNota === true,
        tituloNota: tituloNormalizado(producto.tituloNota),
      })),
    })),
  }
}

/** Avisos que no impiden importar, pero conviene mostrar antes de crear los productos. */
export function avisosCartaJson(carta: CartaJson): string[] {
  const avisos: string[] = []
  const categorias = new Set<string>()
  const productos = new Set<string>()
  let sinPrecio = 0

  for (const categoria of carta.categorias) {
    const categoriaClave = clave(categoria.nombre)
    if (categorias.has(categoriaClave)) avisos.push(`La categoría "${categoria.nombre}" está repetida y se va a unificar.`)
    categorias.add(categoriaClave)

    for (const producto of categoria.productos) {
      const productoClave = clave(producto.nombre)
      if (productos.has(productoClave)) avisos.push(`El producto "${producto.nombre}" está repetido en la carta.`)
      productos.add(productoClave)
      if (producto.precio == null && !producto.variantes?.length) sinPrecio++
    }
  }

  if (sinPrecio > 0) {
    avisos.push(
      `${sinPrecio} producto${sinPrecio === 1 ? '' : 's'} no tiene${sinPrecio === 1 ? '' : 'n'} precio ni variantes: se va${sinPrecio === 1 ? '' : 'n'} a cargar con precio 0.`,
    )
  }

  return avisos
}

/** Mensaje legible para mostrar en el onboarding cuando el JSON no cumple el contrato. */
export function describirErroresCartaJson(error: z.ZodError): string {
  const ruta = (path: PropertyKey[]) =>
    path
      .map((segmento) =>
        typeof segmento === 'number' ? `[${segmento + 1}]` : `.${String(segmento)}`,
      )
      .join('')
      .replace(/^\./, '')

  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const campo = ruta(issue.path)
      return campo ? `${campo}: ${issue.message}` : issue.message
    })
    .join(' · ')
}

// ─── Ejemplo usado en el instructivo (y validado por los tests) ─────────────
export const CARTA_JSON_EJEMPLO: CartaJson = {
  categorias: [
    {
      nombre: 'Hamburguesas',
      esBebida: false,
      productos: [
        {
          nombre: 'Doble cheddar',
          descripcion: 'Dos medallones de carne, cheddar, cebolla y pan brioche.',
          ingredientes: ['carne', 'cheddar', 'cebolla', 'pan brioche'],
          precio: null,
          variantes: [
            { nombre: 'Simple', precio: 6500 },
            { nombre: 'Doble', precio: 8200 },
          ],
          tituloVariantesPrimarias: 'Elegí el tamaño',
          extras: [
            { nombre: 'Extra cheddar', precio: 900 },
            { nombre: 'Bacon', precio: 1200 },
          ],
          tituloExtrasPrimarios: 'Agregá extras',
          permiteNota: true,
          tituloNota: '¿Querés aclarar algo?',
        },
        {
          nombre: 'Papas rústicas',
          descripcion: 'Papas con piel, crocantes y con sal marina.',
          precio: 4200,
          ingredientes: ['papa', 'sal marina'],
          extras: [{ nombre: 'Cheddar fundido', precio: 800 }],
          tituloExtrasPrimarios: 'Agregá extras',
        },
      ],
    },
    {
      nombre: 'Bebidas',
      esBebida: true,
      productos: [
        { nombre: 'Coca-Cola 500 ml', precio: 2500 },
        { nombre: 'Agua mineral 500 ml', precio: 1800 },
      ],
    },
  ],
}

// ─── Instructivo descargable para pegarle a una IA ──────────────────────────
const ejemplo = JSON.stringify(CARTA_JSON_EJEMPLO, null, 2)

export const INSTRUCTIVO_CARTA_JSON = `# Instructivo para que una IA arme la carta de Piru en JSON

Versión ${INSTRUCTIVO_CARTA_JSON_VERSION} · Piru

Este archivo explica cómo convertir la carta de un local en el JSON que Piru
importa durante el alta. Pegá este instructivo completo junto con la carta
(fotos, texto, PDF o el menú de otra plataforma) y pedile a la IA que devuelva
sólo el JSON.

## Regla principal

Devolvé **un único objeto JSON válido**, sin texto antes ni después, sin
comentarios y sin bloques de Markdown (\`\`\`json). El objeto tiene que tener
exactamente esta forma general:

{
  "categorias": [
    {
      "nombre": "Hamburguesas",
      "esBebida": false,
      "productos": [
        { "nombre": "Doble cheddar", "precio": 8200 }
      ]
    }
  ]
}

La carta necesita al menos una categoría y al menos un producto.

## Estructura completa

### Categoría

| Campo | Tipo | Obligatorio | Reglas |
| --- | --- | --- | --- |
| \`nombre\` | texto | Sí | 1 a 255 caracteres. Conservá el nombre real de la carta. |
| \`esBebida\` | booleano | No | \`true\` sólo en categorías de bebidas. |
| \`productos\` | lista | Sí | Al menos un producto. No incluyas categorías vacías. |

### Producto

| Campo | Tipo | Obligatorio | Reglas |
| --- | --- | --- | --- |
| \`nombre\` | texto | Sí | 1 a 255 caracteres. |
| \`descripcion\` | texto o null | No | Máximo 255 caracteres. Texto libre, no una lista de ingredientes. |
| \`precio\` | número o null | No | Precio base en pesos argentinos, sin símbolos. \`null\` si sólo se vende por variantes. |
| \`ingredientes\` | lista de textos | No | Ingredientes reales del producto, sin cantidades. |
| \`variantes\` | lista de opciones | No | Versiones con precio propio (Simple/Doble, Chica/Grande, sabores). |
| \`variantesSecundarias\` | lista de opciones | No | Segunda elección obligatoria e independiente. Sólo si existen \`variantes\`. |
| \`extras\` | lista de opciones | No | Agregados opcionales que suman precio. |
| \`extrasSecundarios\` | lista de opciones | No | Segundo grupo opcional de agregados, sólo si la carta lo distingue. |
| \`tituloVariantesPrimarias\` | texto | No | Pregunta del primer grupo, por ejemplo "Elegí el tamaño". |
| \`tituloVariantesSecundarias\` | texto | No | Pregunta de la segunda elección, por ejemplo "Elegí el sabor". |
| \`tituloExtrasPrimarios\` | texto | No | Título del primer grupo de extras, por ejemplo "Agregá extras". |
| \`tituloExtrasSecundarios\` | texto | No | Título del segundo grupo de extras. |
| \`permiteNota\` | booleano | No | \`true\` sólo si la carta permite aclaraciones. |
| \`tituloNota\` | texto | No | Pregunta para la aclaración. |

### Opción (variantes y extras)

Cada elemento de \`variantes\`, \`variantesSecundarias\`, \`extras\` y
\`extrasSecundarios\` tiene exactamente:

| Campo | Tipo | Obligatorio | Reglas |
| --- | --- | --- | --- |
| \`nombre\` | texto | Sí | Nombre de la opción. |
| \`precio\` | número | Sí | Mayor o igual a 0, en pesos argentinos. |

## Reglas de contenido

1. **Precios como números.** Escribí \`7200\`, no \`"$ 7.200"\`, \`"7.200"\` ni
   \`"ARS 7.200"\`. Si hay decimales, usá punto: \`7200.50\`.
2. **No inventes nada.** Extraé sólo productos, precios, descripciones,
   ingredientes y opciones que estén en la carta. Si un dato no aparece, omitilo
   o usá \`null\` cuando el campo lo permita.
3. **Un precio único va en \`precio\`.** No armes una variante para un producto
   que tiene un solo precio.
4. **Producto con variantes.** Cargá cada versión en \`variantes\` con su precio
   total. Si no hay un precio base único, usá \`"precio": null\`.
5. **Dos elecciones independientes.** Si el producto exige dos decisiones
   (por ejemplo tamaño y sabor), usá \`variantes\` y \`variantesSecundarias\`.
   La variante secundaria lleva sólo el **recargo** sobre la principal (0 si
   está incluida), nunca el precio total otra vez. Simple/Doble/Triple son
   variantes de un solo grupo.
6. **Extras.** Son adicionales opcionales. Si no suman precio, usá \`0\`. Si la
   carta separa dos grupos de agregados (por ejemplo toppings y salsas), usá
   \`extras\` y \`extrasSecundarios\` con sus títulos. Si un agregado se puede
   pedir doble, es una opción con nombre propio ("Doble cheddar"), no un grupo
   nuevo.
7. **Ingredientes.** Separá cada ingrediente en un elemento distinto y sin
   cantidades: \`["carne", "cheddar", "lechuga"]\`. Si la carta sólo tiene una
   descripción libre, ponela en \`descripcion\` y no inventes ingredientes.
8. **Categorías.** Respetá el orden y los nombres de la carta. Si no hay
   categorías claras, agrupá todo en una categoría llamada "General". Marcá
   \`"esBebida": true\` en las categorías de bebidas.
9. **Títulos de opciones.** Usá los títulos sólo cuando el producto tenga
   variantes o extras, y escribí preguntas claras y cortas (máximo 120
   caracteres).
10. **Notas.** Usá \`"permiteNota": true\` y un \`tituloNota\` sólo si la carta
    permite aclaraciones (por ejemplo, "sin cebolla").
11. **Sin duplicados.** No repitas productos ni categorías. Si un producto
    aparece en dos secciones, elegí la sección principal.
12. **Texto limpio.** Conservá acentos y mayúsculas. No agregues emojis,
    viñetas, HTML ni campos que no estén en este instructivo (\`id\`, \`localId\`,
    \`image\`, \`imagenUrl\`, \`etiquetas\`, etc.).

## Ejemplo válido completo

${ejemplo}

### Ejemplo de dos elecciones independientes

Este producto elige tamaño y masa por separado. El precio de la masa es sólo el
recargo: 0 si está incluida.

\`\`\`json
{
  "nombre": "Pizza muzzarella",
  "precio": null,
  "variantes": [
    { "nombre": "Chica", "precio": 6000 },
    { "nombre": "Grande", "precio": 8500 }
  ],
  "variantesSecundarias": [
    { "nombre": "Masa fina", "precio": 0 },
    { "nombre": "Masa al molde", "precio": 500 }
  ],
  "tituloVariantesPrimarias": "Elegí el tamaño",
  "tituloVariantesSecundarias": "Elegí la masa"
}
\`\`\`

## Checklist antes de responder

- [ ] El resultado es un único objeto JSON válido, sin bloques de Markdown.
- [ ] Tiene al menos una categoría y un producto.
- [ ] Todos los precios son números mayores o iguales a 0.
- [ ] Los productos con variantes tienen \`precio: null\` si no hay precio base.
- [ ] \`variantesSecundarias\` sólo aparece si también hay \`variantes\`.
- [ ] Las categorías de bebidas tienen \`esBebida: true\`.
- [ ] No hay productos ni categorías duplicadas.
- [ ] No hay campos extra ni datos inventados.

## Cómo usar la respuesta en Piru

1. Guardá la respuesta de la IA en un archivo con extensión \`.json\`
   (por ejemplo \`carta.json\`).
2. En Piru, durante el alta, elegí **Cargá tu carta → Importar un JSON**.
3. Subí el archivo o pegá el contenido y tocá **Importar carta**.
4. Piru valida el JSON y te muestra los productos detectados en el paso de
   revisión. Ahí podés editar cada producto antes de crearlo.
`
