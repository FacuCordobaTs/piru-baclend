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
  // «Mordisco» en la galería: conserva la id `moderna` porque las páginas ya creadas la guardan.
  moderna: { fondo: '#fff4e4', texto: '#1b1530', superficie: '#ffffff', primario: '#ff5a36', secundario: '#ffc83d', titulos: 'Bricolage Grotesque', cuerpo: 'DM Sans', peso: 800, serif: false, radio: 22, portada: 'costado' },
  // «Hornito» en la galería: conserva la id `artesanal` porque las páginas ya creadas la guardan.
  artesanal: { fondo: '#efe3cf', texto: '#2b1d14', superficie: '#fbf5ea', primario: '#b5452b', secundario: '#3d5a3a', titulos: 'Young Serif', cuerpo: 'Karla', peso: 400, serif: true, radio: 12, portada: 'costado' },
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
} satisfies Record<string, BasePlantilla>

export type PlantillaSitio = keyof typeof PLANTILLAS_SITIO
export const PLANTILLA_POR_DEFECTO: PlantillaSitio = 'artesanal'

export const esPlantillaSitio = (v: unknown): v is PlantillaSitio => typeof v === 'string' && Object.hasOwn(PLANTILLAS_SITIO, v)
