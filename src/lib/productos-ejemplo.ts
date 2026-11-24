/**
 * Productos de ejemplo de las tiendas self-serve. Al crear la tienda el dueño responde dos preguntas
 * (rubro y formas de entrega, como las pantallas iniciales de Tiendanube) y la carta arranca con
 * tres productos de su rubro para que vea cómo queda la tienda y cómo se arma un producto, incluido
 * uno con opciones.
 *
 * Los productos quedan marcados (`producto.es_ejemplo`): el panel los distingue, no cuentan como
 * carta propia en "Primeros pasos" y el dueño los quita todos juntos sin tocar lo que cargó él.
 *
 * Este archivo es el catálogo, puro. La escritura vive en `productos-ejemplo-db.ts`.
 * No confundir con `datos-ejemplo.ts`: ésos son clientes y pedidos de la demo de prospección.
 */

export const RUBROS = ['cafeteria', 'rotiseria', 'hamburgueseria', 'pizzeria', 'otro'] as const
export type Rubro = (typeof RUBROS)[number]

export interface VarianteEjemplo {
  nombre: string
  precio: number
}

export interface ProductoEjemploDef {
  nombre: string
  descripcion: string
  /** Precio de lista. Con variantes es el de la primera opción (la tienda muestra "desde"). */
  precio: number
  /** Primera elección con precio absoluto (grupo 1), como el tamaño de una pizza. */
  variantes?: VarianteEjemplo[]
  tituloVariantes?: string
}

export interface CategoriaEjemploDef {
  nombre: string
  esBebida?: boolean
  productos: ProductoEjemploDef[]
}

/**
 * Tres productos por rubro, uno con opciones para mostrar cómo se arma. Los precios son
 * orientativos: el dueño los ve marcados como ejemplo y los cambia o los quita.
 */
export const CATALOGO_EJEMPLO: Record<Rubro, CategoriaEjemploDef[]> = {
  cafeteria: [
    {
      nombre: 'Cafetería',
      productos: [
        {
          nombre: 'Café con leche',
          descripcion: 'Espresso doble con leche texturizada.',
          precio: 2800,
          tituloVariantes: 'Elegí el tamaño',
          variantes: [
            { nombre: 'Chico', precio: 2800 },
            { nombre: 'Grande', precio: 3600 },
          ],
        },
      ],
    },
    {
      nombre: 'Para acompañar',
      productos: [
        { nombre: 'Medialunas x3', descripcion: 'De manteca, recién horneadas.', precio: 3000 },
        { nombre: 'Tostado de jamón y queso', descripcion: 'En pan de miga, con jamón cocido y queso tybo.', precio: 6500 },
      ],
    },
  ],
  rotiseria: [
    {
      nombre: 'Platos',
      productos: [
        {
          nombre: 'Pollo al spiedo',
          descripcion: 'Dorado a la leña, con su jugo.',
          precio: 9500,
          tituloVariantes: 'Elegí la porción',
          variantes: [
            { nombre: 'Medio pollo', precio: 9500 },
            { nombre: 'Pollo entero', precio: 17000 },
          ],
        },
      ],
    },
    {
      nombre: 'Empanadas y tartas',
      productos: [
        { nombre: 'Empanadas de carne x6', descripcion: 'Cortadas a cuchillo, al horno.', precio: 9000 },
        { nombre: 'Tarta de jamón y queso', descripcion: 'Porción grande, masa casera.', precio: 7500 },
      ],
    },
  ],
  hamburgueseria: [
    {
      nombre: 'Hamburguesas',
      productos: [
        {
          nombre: 'Hamburguesa clásica',
          descripcion: 'Medallón de carne, cheddar, lechuga, tomate y salsa de la casa.',
          precio: 9000,
          tituloVariantes: 'Elegí la medida',
          variantes: [
            { nombre: 'Simple', precio: 9000 },
            { nombre: 'Doble', precio: 11500 },
          ],
        },
        { nombre: 'Papas fritas', descripcion: 'Porción grande, con sal y pimentón.', precio: 5000 },
      ],
    },
    {
      nombre: 'Bebidas',
      esBebida: true,
      productos: [{ nombre: 'Gaseosa 500 ml', descripcion: 'Línea Coca-Cola.', precio: 2500 }],
    },
  ],
  pizzeria: [
    {
      nombre: 'Pizzas',
      productos: [
        {
          nombre: 'Pizza muzzarella',
          descripcion: 'Salsa de tomate, muzzarella y aceitunas.',
          precio: 9000,
          tituloVariantes: 'Elegí el tamaño',
          variantes: [
            { nombre: 'Chica', precio: 9000 },
            { nombre: 'Grande', precio: 13000 },
          ],
        },
        { nombre: 'Pizza napolitana', descripcion: 'Muzzarella, rodajas de tomate, ajo y orégano.', precio: 15000 },
      ],
    },
    {
      nombre: 'Para acompañar',
      productos: [{ nombre: 'Fainá', descripcion: 'La porción, para arriba de la pizza.', precio: 3000 }],
    },
  ],
  otro: [
    {
      nombre: 'Platos',
      productos: [
        {
          nombre: 'Milanesa con guarnición',
          descripcion: 'Milanesa de carne con la guarnición que elijas.',
          precio: 12000,
          tituloVariantes: 'Elegí la guarnición',
          variantes: [
            { nombre: 'Con papas fritas', precio: 12000 },
            { nombre: 'Con puré', precio: 12000 },
          ],
        },
        { nombre: 'Ensalada completa', descripcion: 'Lechuga, tomate, zanahoria, huevo y choclo.', precio: 8000 },
      ],
    },
    {
      nombre: 'Bebidas',
      esBebida: true,
      productos: [{ nombre: 'Agua mineral 500 ml', descripcion: 'Con o sin gas.', precio: 2000 }],
    },
  ],
}

export function esRubro(valor: unknown): valor is Rubro {
  return typeof valor === 'string' && (RUBROS as readonly string[]).includes(valor)
}

/** El catálogo del rubro; un rubro desconocido o vacío usa el genérico. */
export function catalogoDe(rubro: string | null | undefined): CategoriaEjemploDef[] {
  return CATALOGO_EJEMPLO[esRubro(rubro) ? rubro : 'otro']
}
