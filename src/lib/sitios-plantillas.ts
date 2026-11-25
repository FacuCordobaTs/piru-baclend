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
} satisfies Record<string, BasePlantilla>

export type PlantillaSitio = keyof typeof PLANTILLAS_SITIO
export const PLANTILLA_POR_DEFECTO: PlantillaSitio = 'artesanal'

export const esPlantillaSitio = (v: unknown): v is PlantillaSitio => typeof v === 'string' && Object.hasOwn(PLANTILLAS_SITIO, v)
