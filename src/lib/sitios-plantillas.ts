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
  moderna: { fondo: '#f5f7fa', texto: '#171d2b', superficie: '#ffffff', primario: '#315cfd', secundario: '#ffc21a', titulos: 'Unbounded', cuerpo: 'Manrope', peso: 700, serif: false, radio: 22, portada: 'costado' },
  artesanal: { fondo: '#f4ead8', texto: '#392a20', superficie: '#fffaf1', primario: '#c2410c', secundario: '#3f7d3a', titulos: 'Fraunces', cuerpo: 'Nunito Sans', peso: 700, serif: true, radio: 16, portada: 'costado' },
} satisfies Record<string, BasePlantilla>

export type PlantillaSitio = keyof typeof PLANTILLAS_SITIO
export const PLANTILLA_POR_DEFECTO: PlantillaSitio = 'artesanal'

export const esPlantillaSitio = (v: unknown): v is PlantillaSitio => typeof v === 'string' && Object.hasOwn(PLANTILLAS_SITIO, v)
