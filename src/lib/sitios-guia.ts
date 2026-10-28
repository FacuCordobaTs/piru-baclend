import { PLANTILLA_INICIAL } from './sitios-plantilla'
import { TIPOS_SDK } from './sitios-sdk-tipos.generado'
import { TIPOS_ASSET } from './sitios-reglas'

/**
 * Guía para Claude (docs/PAGINAS_PROPIAS.md, §16): el `.md` que el dueño descarga y le pasa a Claude
 * para que le escriba la página. Incluye el contrato del SDK (generado desde el código), las reglas,
 * los estados, la CSP, un ejemplo completo y los datos reales del local.
 */

type DatosGuia = {
  nombre: string
  username: string
  restaurante: Record<string, unknown>
  productos: Record<string, unknown>[]
  horarios: unknown[]
  assets: string[]
}

const CAMPOS_LOCAL = [
  'nombre',
  'username',
  'direccion',
  'telefono',
  'colorPrimario',
  'colorSecundario',
  'imagenUrl',
  'imagenLightUrl',
  'tienda',
  'deliveryEnabled',
  'takeawayEnabled',
  'deliveryFee',
  'metodosPago',
  'sistemaPuntos',
  'configuracionPuntos',
  'permitirPedidosProgramados',
]

function resumirProducto(p: Record<string, unknown>) {
  const opciones = (lista: unknown) =>
    Array.isArray(lista) ? lista.map((o) => ({ id: (o as Record<string, unknown>).id, nombre: (o as Record<string, unknown>).nombre, precio: (o as Record<string, unknown>).precio })) : []
  return {
    id: p.id,
    nombre: p.nombre,
    descripcion: p.descripcion,
    categoria: p.categoria,
    precio: p.precio,
    descuento: p.descuento || undefined,
    imagenUrl: p.imagenUrl,
    imagenesExtra: Array.isArray(p.imagenesExtra) && p.imagenesExtra.length ? p.imagenesExtra : undefined,
    variantes: opciones(p.variantes).length ? opciones(p.variantes) : undefined,
    variantesSecundarias: opciones(p.variantesSecundarias).length ? opciones(p.variantesSecundarias) : undefined,
    agregados: opciones(p.agregados).length ? opciones(p.agregados) : undefined,
    ingredientes: Array.isArray(p.ingredientes) && p.ingredientes.length ? p.ingredientes : undefined,
    soloCanjePuntos: p.soloCanjePuntos || undefined,
    puntosNecesarios: p.puntosNecesarios ?? undefined,
  }
}

export function generarGuia(datos: DatosGuia): string {
  const local = Object.fromEntries(CAMPOS_LOCAL.filter((c) => datos.restaurante[c] !== undefined).map((c) => [c, datos.restaurante[c]]))
  const extensionesAsset = Object.keys(TIPOS_ASSET).join(', ')
  return `# Página de ${datos.nombre} en Piru — guía para Claude

Sos diseñador web. Entregá \`page.tsx\` y \`style.css\` (y, si hace falta, componentes en \`components/\`) para la tienda online de **${datos.nombre}**, que se publica en \`https://${datos.username}.piru.app\`. Usá solo \`@piru/tienda\`, \`react\`, \`motion/react\` y \`lucide-react\`. No implementes checkout, pagos, pedidos ni analytics: eso lo hace Piru. Contemplá los estados de la sección 4. Usá HTML semántico, foco visible, buen contraste y respetá \`prefers-reduced-motion\`.

## 1. Qué hay que entregar

\`\`\`
page.tsx          ← obligatorio: export default del componente de la página
style.css         ← opcional, importado desde page.tsx (import "./style.css")
components/*.tsx  ← opcional, importados con rutas relativas
assets/*          ← imágenes, fuentes y video que el dueño sube desde el editor
\`\`\`

- Código: solo \`.tsx\`, \`.ts\` y \`.css\`. Assets: ${extensionesAsset}.
- Imports permitidos: rutas relativas del sitio (\`./components/Hero\`, \`./assets/logo.png\`, \`./style.css\`) y los paquetes \`react\`, \`react-dom\`, \`motion/react\`, \`react-router\`, \`@piru/tienda\` y \`lucide-react\`. Cualquier otro (\`lodash\`, \`https://…\`, \`node:*\`) no compila.
- Un asset importado devuelve su URL: \`import foto from "./assets/portada.jpg"\`.
- Prohibido (no compila): \`<script>\`, \`dangerouslySetInnerHTML\`, \`eval\`, \`new Function\`, \`import()\` dinámico, \`import.meta\`, \`process\`, \`globalThis\`, imports con \`with { … }\`.
- No hay backend ni secretos: el código es público. Todo se compila en un solo archivo.
- No hay Tailwind: escribí CSS propio. Usá clases con un prefijo propio para no chocar con las de Piru (\`piru-*\`).

## 2. El SDK \`@piru/tienda\`

Los datos y las reglas (precios, descuentos, horarios, disponibilidad) vienen del SDK; el diseño solo los muestra.

- \`useLocal()\` → \`{ estado: "cargando" | "error" | "listo", local }\`. Con \`estado === "listo"\`, \`local\` tiene nombre, logos, colores, dirección, horarios, si está \`abierto\`, si está \`pausado\` y más.
- \`useCarta()\` → \`{ secciones, productos, canjes, destacado }\`. Cada producto tiene \`precioFinal\` (con descuento), \`fotos\`, \`disponible\`, \`tieneOpciones\`, \`abrir()\` y \`agregar()\`.
- \`producto.abrir()\` abre la hoja de opciones de Piru (variantes, extras, ingredientes, nota y cantidad). Es el camino recomendado: si \`producto.tieneOpciones\`, abrí la hoja; si no, \`producto.agregar()\`.
- \`useCarrito()\` → \`lines\`, \`count\`, \`totalFormatted\` (subtotal), \`set(key, n)\`, \`remove\`, \`canCheckout\`, \`blockReason\` y \`checkout()\`. \`checkout()\` lleva al checkout de Piru en otra página: ahí se piden los datos, el envío, los cupones, los puntos y el pago. Mostrá "Subtotal" o "Pedir · $X", nunca un total final.
- \`useContenido()\` → lo que el local cargó en Ajustes → Tienda: frase, bajada, portada, galería, historia, colores.
- \`useHorarios()\` → \`{ abierto, texto, turnos, … }\`. \`texto\` ya viene armado ("Abierto · hasta las 23:45").
- \`useCampana()\` → la campaña cuando se entra por un link de promo (\`/c/:slug\`), o \`null\`.
- \`useNavegacionCarta(secciones.length)\` → categoría activa y \`ir(i)\` para un índice de categorías.
- \`formatPesos(n)\` → "$2.000". \`PiruCanjes\` → bloque opcional de canjes de puntos.

Referencia completa (TypeScript):

\`\`\`ts
${TIPOS_SDK.trim()}
\`\`\`

## 3. Lo que agrega Piru alrededor de tu página

- Un pie chico "Pedidos por Piru · Ver la tienda estándar". Toma sus colores de \`--piru-footer-fg\` y \`--piru-footer-bg\`; definilas en \`:root\` para que combine. No lo tapes.
- La hoja de opciones de producto, los avisos ("agregado al pedido") y una pantalla de error si la página falla.
- El acento de esas piezas sale del color del local.

## 4. Estados que el diseño tiene que contemplar

- \`estado === "cargando"\`: un esqueleto o spinner con el color de fondo del sitio.
- \`estado === "error"\`: un mensaje simple.
- Local cerrado (\`horarios.abierto === false\`): mostrar \`horarios.texto\`. Si \`horarios.permiteProgramados\`, se puede seguir armando el pedido.
- \`local.pausado\`: la tienda se ve pero no toma pedidos; \`carrito.canCheckout\` es \`false\`.
- Carta vacía (\`secciones.length === 0\`) y productos sin categoría (sección "Sin categoría").
- \`producto.disponible === false\`: mostrarlo apagado y sin botón de agregar.
- \`carrito.blockReason\`: \`"empty"\`, \`"closed"\`, \`"paused"\` o \`"unavailable"\` → explicar por qué no se puede pedir.
- Productos solo de canje (\`useCarta().canjes\`) y puntos (\`usePuntos()\`).
- Campaña activa (\`useCampana()\`).

## 5. Restricciones de seguridad (CSP)

- Sin scripts externos ni analytics. Sin \`<form>\` que mande datos.
- Fuentes: Google Fonts (\`@import url("https://fonts.googleapis.com/…")\` en el CSS) o archivos propios en \`assets/\`.
- Imágenes: las del local (vienen en los datos) o subidas como assets. Ninguna de otro sitio.
- Mapas: solo con \`<iframe src="https://www.google.com/maps/embed?…">\`.
- \`fetch\` solo llega a la API de Piru: el SDK ya trae todos los datos.

## 6. Ejemplo completo y funcional

\`page.tsx\`:

\`\`\`tsx
${PLANTILLA_INICIAL['page.tsx'].trim()}
\`\`\`

\`style.css\`:

\`\`\`css
${PLANTILLA_INICIAL['style.css'].trim()}
\`\`\`

## 7. Datos reales de ${datos.nombre}

Diseñá con este contenido; no inventes platos ni precios. En la página, leelos siempre del SDK (pueden cambiar).

Assets ya subidos: ${datos.assets.length ? datos.assets.map((a) => `\`${a}\``).join(', ') : 'ninguno todavía'}.

\`\`\`json
${JSON.stringify({ local, horarios: datos.horarios, productos: datos.productos.map(resumirProducto) }, null, 2)}
\`\`\`

## 8. Cómo entregar

Un bloque de código por archivo, con su ruta como título (\`page.tsx\`, \`style.css\`, \`components/Hero.tsx\`), o un \`.zip\` con esa estructura. El dueño lo pega o lo sube en el editor de Páginas, lo prueba en la vista previa y lo publica.
`
}
