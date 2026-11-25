/**
 * Las plantillas de Páginas: el único lugar donde se declaran. Sumar una `<id>` es agregar su
 * entrada acá (y su espejo en `sitios/src/lib/plantillas.ts`, que `sitios.test.ts` compara) y sus
 * reglas `.pv-<id>` en `sitios-plantilla/style.css.txt`.
 *
 * `plantillaInicial` escribe este registro dentro de `components/Sitio.tsx` de cada página nueva;
 * las páginas ya creadas conservan su copia (una plantilla que no conocen cae en `PLANTILLA_POR_DEFECTO`).
 */
export type BasePlantilla = {
  fondo: string
  texto: string
  superficie: string
  primario: string
  secundario: string
  titulos: string
  cuerpo: string
  peso: number
  /** Letra de respaldo de los títulos: Georgia si es serif, la del sistema si no. */
  serif: boolean
  /** Radio de bordes del checkout. */
  radio: number
  /** Disposición de la portada cuando la sección no elige una. */
  portada: 'fondo' | 'costado'
}

export const PLANTILLAS_SITIO = {
  sencilla: { fondo: '#ffffff', texto: '#1d1d1f', superficie: '#f5f5f7', primario: '#1d1d1f', secundario: '#6e6e73', titulos: 'Inter', cuerpo: 'Inter', peso: 600, serif: false, radio: 12, portada: 'costado' },
  // «Brasa» en la galería: conserva la id `elegante` porque las páginas ya creadas la guardan.
  elegante: { fondo: '#0f0c0a', texto: '#f3eadb', superficie: '#1b1612', primario: '#e2a04a', secundario: '#b8391f', titulos: 'Playfair Display', cuerpo: 'Jost', peso: 600, serif: true, radio: 2, portada: 'fondo' },
  // «Umami» en la galería: editorial japonés, el nombre gigante entre crema y tinta, marco laca.
  umami: { fondo: '#120c0b', texto: '#f4ecdc', superficie: '#1d1514', primario: '#a3100f', secundario: '#f4ecdc', titulos: 'Dela Gothic One', cuerpo: 'Archivo', peso: 400, serif: false, radio: 0, portada: 'costado' },
  // «Sobremesa» en la galería: alta cocina sobre lino, la página como una tablet sobre la mesa y los platos en pedestales.
  sobremesa: { fondo: '#e8dfd1', texto: '#1f1a15', superficie: '#f6f1e8', primario: '#a8834b', secundario: '#1c1713', titulos: 'Gloock', cuerpo: 'Manrope', peso: 400, serif: true, radio: 18, portada: 'fondo' },
  // «Tarascón» en la galería: hamburguesería pop, lima y verde botella, el nombre gigante muerde la foto y los platos apilados en píldoras.
  tarascon: { fondo: '#eef37b', texto: '#173d24', superficie: '#f6f9b4', primario: '#f2662f', secundario: '#173d24', titulos: 'Anton', cuerpo: 'Space Grotesk', peso: 400, serif: false, radio: 28, portada: 'fondo' },
  // «Ñam» en la galería: hamburguesería de cartel, la portada verde con la ola mostaza, el ÑAM calado de fondo y los platos flotando sobre crema.
  nam: { fondo: '#f8e8c8', texto: '#0f3a22', superficie: '#fff4de', primario: '#f26a1f', secundario: '#0f3a22', titulos: 'Outfit', cuerpo: 'Lexend', peso: 800, serif: false, radio: 26, portada: 'costado' },
  // «Chispa» en la galería: hamburguesería de cartel moderno, crema, tinta petróleo y naranja, la burger flotando sobre una pincelada y la carta en fichas durazno.
  chispa: { fondo: '#fdf6ec', texto: '#15232d', superficie: '#fdebd3', primario: '#f7931e', secundario: '#15232d', titulos: 'Archivo Black', cuerpo: 'Poppins', peso: 400, serif: false, radio: 18, portada: 'costado' },
  // «Sorbo» en la galería: noodle bar de cartel, crema y naranja, el nombre gigante en escalera, cintas de «¡promos!» y la carta en tarjetas con la franja naranja.
  sorbo: { fondo: '#fdf3e1', texto: '#3a1707', superficie: '#fbe4c4', primario: '#ff5a0f', secundario: '#3a1707', titulos: 'Big Shoulders Display', cuerpo: 'Manrope', peso: 800, serif: false, radio: 6, portada: 'costado' },
  // «Girasol» en la galería: comida de mediodía al sol, crema, amarillo girasol y rojo tomate, título serif crema sobre la mesa y los platos sobre rayos de sol.
  girasol: { fondo: '#fdf1dc', texto: '#3a2416', superficie: '#f6deb2', primario: '#d9452b', secundario: '#f7c52e', titulos: 'Fraunces', cuerpo: 'Space Mono', peso: 600, serif: true, radio: 18, portada: 'fondo' },
  // «Calcomanía» en la galería: taquería-hamburguesería de stickers, verde botella y crema, el nombre en letra de bloque pegado sobre la foto y stickers que se despegan.
  calcomania: { fondo: '#1f5138', texto: '#f6e9c8', superficie: '#2a6646', primario: '#f4b42c', secundario: '#7a4bb3', titulos: 'Bungee', cuerpo: 'Rubik', peso: 400, serif: false, radio: 16, portada: 'fondo' },
  // «Baobab» en la galería: cocina africana de fiesta, rojo achiote y amarillo maíz, la foto de la mesa que gotea sobre el rojo, el titular condensado en mayúsculas y la carta en marcos de tela estampada.
  baobab: { fondo: '#b3170f', texto: '#fff3dc', superficie: '#8e110b', primario: '#f7c325', secundario: '#1f5fae', titulos: 'Oswald', cuerpo: 'Outfit', peso: 700, serif: false, radio: 14, portada: 'fondo' },
  // «Porción» en la galería: pizzería de barrio sobre cemento claro, la pizza entera asomando en semicírculo con el arco de sabores que gira, letra condensada, naranja horno y la franja negra con polaroids.
  porcion: { fondo: '#ecebe7', texto: '#1d1d1b', superficie: '#ffffff', primario: '#e8662a', secundario: '#1f1e1c', titulos: 'Pathway Gothic One', cuerpo: 'Roboto Condensed', peso: 400, serif: false, radio: 18, portada: 'fondo' },
  // «Tazón» en la galería: ramen bar sobre bordó, el tazón servido sobre un círculo mostaza de pincel con salpicaduras, el titular blanco gastado con la última palabra en firma amarilla y los palillos que bajan.
  tazon: { fondo: '#6d0b19', texto: '#fff5ea', superficie: '#560713', primario: '#eea21b', secundario: '#2b0409', titulos: 'Rubik Dirt', cuerpo: 'Poppins', peso: 400, serif: false, radio: 6, portada: 'costado' },
  // «Hanko» en la galería: sushi de autor entre tinta y papel washi, el titular serif fino, kanji en vertical, el sello rojo y montañas de tinta que se pintan al bajar.
  hanko: { fondo: '#efe9df', texto: '#151311', superficie: '#f8f4ed', primario: '#a3201f', secundario: '#0e0d0c', titulos: 'Cormorant Garamond', cuerpo: 'Jost', peso: 500, serif: true, radio: 2, portada: 'fondo' },
  // «Sumi» en la galería: sushi lounge de tinta, negro con el titular en mayúsculas y la palabra roja, kanjis de pincel de fondo, el nigiri con su reflejo, la franja roja con palillos y el pie blanco con el sol rojo.
  // «Fideo» en la galería: noodle bar de revista sobre papel hueso, el nombre gigante en negro de cartel, la foto a lo ancho, la carta en grilla de tres con la regla fina, el botón píldora negro y el rosa del sello.
  fideo: { fondo: '#efeee9', texto: '#111111', superficie: '#e3e1da', primario: '#f2a7c3', secundario: '#111111', titulos: 'Archivo Black', cuerpo: 'Archivo', peso: 400, serif: false, radio: 14, portada: 'costado' },
  sumi: { fondo: '#060606', texto: '#f3f1ee', superficie: '#141414', primario: '#e3121b', secundario: '#f6f3ee', titulos: 'Open Sans', cuerpo: 'Open Sans', peso: 800, serif: false, radio: 0, portada: 'costado' },
  // «Kuro» en la galería: sushi bar de noche, negro piedra, rojo laca y blanco arroz, el nombre en versalitas con la inicial roja, la portada a sangre sobre la pizarra y la carta en platos con el botón laca.
  kuro: { fondo: '#0c0c0c', texto: '#f3efe8', superficie: '#1a1a1a', primario: '#8c1c22', secundario: '#262626', titulos: 'Inter', cuerpo: 'Inter', peso: 600, serif: false, radio: 8, portada: 'fondo' },
  // «Damero» en la galería: hamburguesería de cielo azul, el titular condensado blanco con la última palabra en amarillo, la firma en cursiva, el damero azul y blanco, el sello «Pedí ya» y la carta en tickets con código de barras.
  damero: { fondo: '#2338c4', texto: '#ffffff', superficie: '#1a2ba3', primario: '#ffd21f', secundario: '#0a0a0a', titulos: 'Anton', cuerpo: 'Archivo', peso: 400, serif: false, radio: 18, portada: 'costado' },
  // «Mordisco» en la galería: hamburguesería de afiche, crema con curvas de nivel, el titular gigante en marrón tostado, la burger en un arco amarillo, cintas cruzadas de «¡a morder!», el sello verde que gira e ingredientes en tarjetas sticker.
  mordisco: { fondo: '#fbf0d6', texto: '#2a1408', superficie: '#fffaf0', primario: '#f9c80e', secundario: '#2a1408', titulos: 'Bowlby One', cuerpo: 'Plus Jakarta Sans', peso: 400, serif: false, radio: 18, portada: 'costado' },
  // «Miga» en la galería: panadería de vidriera, rosa harina y paneles blancos redondeados, el titular gordo que baila letra por letra, stickers violeta y naranja y la etiqueta amarilla del precio.
  miga: { fondo: '#f3e5dd', texto: '#2b1610', superficie: '#ffffff', primario: '#ec9757', secundario: '#ffdf3e', titulos: 'Titan One', cuerpo: 'Figtree', peso: 400, serif: false, radio: 22, portada: 'costado' },
} satisfies Record<string, BasePlantilla>

export type PlantillaSitio = keyof typeof PLANTILLAS_SITIO
export const PLANTILLA_POR_DEFECTO: PlantillaSitio = 'sencilla'

export const esPlantillaSitio = (v: unknown): v is PlantillaSitio => typeof v === 'string' && Object.hasOwn(PLANTILLAS_SITIO, v)
