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
  /** El `contenido.ts` del borrador: textos, colores, fotos y contacto elegidos. */
  contenido: string
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

Sos diseñador web. Entregá \`contenido.ts\`, \`page.tsx\` y \`style.css\` (y, si hace falta, componentes en \`components/\`) para la tienda online de **${datos.nombre}**, que se publica en \`https://${datos.username}.piru.app\`. Usá solo \`@piru/tienda\`, \`react\`, \`motion/react\` y \`lucide-react\`. No reimplementes checkout, pagos, pedidos ni analytics: el checkout es \`<PiruCheckout />\` del runtime y los pagos los hace Piru. Contemplá los estados de la sección 4. Usá HTML semántico, foco visible, buen contraste y respetá \`prefers-reduced-motion\`.

## 1. Qué hay que entregar

\`\`\`
contenido.ts      ← textos, colores, fotos y contacto de esta página (editable)
page.tsx          ← obligatorio: export default del componente de la página
style.css         ← opcional, importado desde page.tsx (import "./style.css")
components/DetalleProducto.tsx ← el detalle de producto que abre cada plato (editable)
components/detalle.css         ← sus estilos
components/Checkout.tsx        ← incluye <PiruCheckout /> y elige su variante y colores (no la lógica)
components/*.tsx  ← opcional, importados con rutas relativas
assets/*          ← imágenes, fuentes y video que el dueño sube desde el editor
\`\`\`

- El contenido elegido por el local vive en \`contenido.ts\`, **dentro del código**. Podés leerlo, moverlo a tu diseño o reemplazarlo; no hay una configuración del backend que lo pise.
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
- \`producto.abrir()\` abre la hoja de opciones de Piru (variantes, extras, ingredientes, nota y cantidad). La plantilla inicial no la usa: abre su propio detalle (\`components/DetalleProducto.tsx\`, sección 5.1). Si preferís la hoja de Piru, \`abrir()\` sigue disponible; si no, \`producto.agregar()\` agrega sin opciones.
- \`useCarrito()\` → \`lines\`, \`count\`, \`totalFormatted\` (subtotal), \`set(key, n)\`, \`remove\`, \`canCheckout\`, \`blockReason\` y \`checkout()\`. \`checkout()\` abre el checkout de Piru **en la misma página** (el \`<PiruCheckout />\` que incluís); ahí se piden los datos, el envío, los cupones, los puntos y el pago. Mostrá "Subtotal" o "Pedir · $X", nunca un total final.
- \`useCheckout()\` → \`{ abierto, abrir(), cerrar() }\` por si querés otro botón además de "Pedir".
- \`useContenido()\` → opcional: la personalización de la **tienda estándar**. La plantilla inicial no lo usa; el contenido de esta página vive en \`contenido.ts\`.
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
- La hoja de opciones de producto de Piru (la que abre \`producto.abrir()\`) y los avisos ("agregado al pedido") del runtime. La plantilla inicial usa su propio detalle y no muestra esos avisos: avisá del alta en el diseño.
- Una pantalla de error neutra si la página falla.
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

## 5.1 El detalle de producto (\`components/DetalleProducto.tsx\`)

Cuando alguien toca un plato se abre el detalle: la foto, la descripción, las variantes, los ingredientes que se pueden sacar, los extras y la nota. **Es una pieza del diseño, no del runtime**: vive en \`components/DetalleProducto.tsx\` (con \`components/detalle.css\`) y podés rediseñarla entera.

\`CONTENIDO.detalleProducto\` elige uno de tres estilos, que ya están implementados en el mismo componente:

- \`"pasos"\`: foto grande arriba, una decisión por pantalla (opción, segunda opción, ingredientes y extras, nota), resumen de lo elegido y avance automático al elegir. Es el que se parece a la tienda de Piru.
- \`"dialogo"\`: ventana al centro, con todas las opciones juntas y el botón fijo abajo.
- \`"hoja"\`: hoja inferior que sube desde abajo con animación, todas las opciones juntas y arrastre para cerrar.

Reglas que hay que respetar al tocarlo:

- Los precios, el descuento y la disponibilidad salen del \`Producto\` del SDK; nunca los recalcules ni los inventes.
- El alta va por \`useCarrito().add({ productoId, cantidad, varianteId, varianteSecundariaId, agregados, ingredientesExcluidos, nota })\`. Con variantes obligatorias sin elegir devuelve \`{ ok: false, reason: "requires-options" }\`.
- El checkout, el envío, los cupones y los puntos siguen siendo de Piru: no hay total final ni medios de pago en el detalle.
- Si el local está pausado o el producto no está disponible, el botón no agrega.
- Accesibilidad: rol de diálogo, cierre con Escape y con el fondo, foco adentro, y \`prefers-reduced-motion\` sin animaciones.

Si el dueño quiere otro detalle (una ficha a pantalla completa, un acordeón en la grilla, lo que sea), cambiá el componente y dejá \`CONTENIDO\` como fuente de textos e imágenes. Las únicas dependencias son \`react\`, \`motion/react\`, \`lucide-react\` y \`@piru/tienda\`.

## 5.2 El checkout (\`components/Checkout.tsx\`)

El checkout **no se reescribe**. Es \`<PiruCheckout />\`, una caja cerrada del runtime: el diseño lo incluye una vez en la página y sólo elige su forma y su piel. \`carrito.checkout()\` (el botón "Pedir") lo abre en la misma página; no hay redirección a la tienda estándar.

\`CONTENIDO.checkout\` elige una de tres variantes:

- \`"pasos"\`: hoja inferior con un paso por pantalla (tipo de pedido, datos, entrega, pago). Es la más guiada.
- \`"hoja"\`: hoja inferior con todo el formulario junto, sin pasos.
- \`"pagina"\`: pantalla completa con todo el formulario junto, sin pasos.

\`PiruCheckout\` acepta sólo \`variante\` y \`estilo\` (\`acento\`, \`texto\`, \`superficie\`, \`linea\`, \`radio\`, \`fuente\`, \`textoConfirmar\`). No recibe el carrito, los datos del comprador ni los medios de pago: eso lo resuelve el runtime y el backend. El sitio no puede leer lo que se carga adentro.

Reglas:
- No dibujes un formulario de datos, envío o pago propio: el alta, los cupones, los puntos y el cobro se validan en el backend.
- No pases precios ni totales: el subtotal del carrito es sólo para mostrar; el total final lo calcula el checkout.
- El éxito también es del runtime: muestra el pedido, el alias de transferencia, los puntos y el botón de WhatsApp cuando el local no tiene avisos automáticos.
- Si el local usa Mercado Pago, el checkout crea el pedido y redirige al pago; al volver, la página retoma el éxito en el mismo sitio.

## 6. Ejemplo completo y funcional

\`contenido.ts\`:

\`\`\`ts
${(datos.contenido || PLANTILLA_INICIAL['contenido.ts']).trim()}
\`\`\`

\`page.tsx\`:

\`\`\`tsx
${PLANTILLA_INICIAL['page.tsx'].trim()}
\`\`\`

\`style.css\`:

\`\`\`css
${PLANTILLA_INICIAL['style.css'].trim()}
\`\`\`

\`components/DetalleProducto.tsx\` (el detalle de producto; cambialo o dejalo como está):

\`\`\`tsx
${PLANTILLA_INICIAL['components/DetalleProducto.tsx'].trim()}
\`\`\`

\`components/detalle.css\`:

\`\`\`css
${PLANTILLA_INICIAL['components/detalle.css'].trim()}
\`\`\`

\`components/Checkout.tsx\` (incluye el checkout de Piru; cambialo sólo para elegir la variante o la piel):

\`\`\`tsx
${PLANTILLA_INICIAL['components/Checkout.tsx'].trim()}
\`\`\`

## 7. Datos reales de ${datos.nombre}

El contenido y los recursos visuales de esta página están en \`contenido.ts\` (sección 6): textos, colores, tipografías, fotos, logos, historia y contacto. Podés usar esas URLs o reemplazarlas por assets propios. No inventes platos, precios ni fotos.

Assets ya subidos: ${datos.assets.length ? datos.assets.map((a) => `\`${a}\``).join(', ') : 'ninguno todavía'}.

\`\`\`json
${JSON.stringify({ local, horarios: datos.horarios, productos: datos.productos.map(resumirProducto) }, null, 2)}
\`\`\`

## 8. Cómo entregar

Un bloque de código por archivo, con su ruta como título (\`page.tsx\`, \`style.css\`, \`components/DetalleProducto.tsx\`, \`components/Checkout.tsx\`, \`components/Hero.tsx\`), o un \`.zip\` con esa estructura. El dueño lo pega o lo sube en el editor de Páginas, lo prueba en la vista previa y lo publica.
`
}
