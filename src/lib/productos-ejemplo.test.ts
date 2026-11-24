import { describe, expect, test } from 'bun:test'
import { CATALOGO_EJEMPLO, RUBROS, catalogoDe, esRubro } from './productos-ejemplo'

describe('productos de ejemplo', () => {
  test('cada rubro trae 3 productos con precio y uno con opciones', () => {
    for (const rubro of RUBROS) {
      const productos = CATALOGO_EJEMPLO[rubro].flatMap((c) => c.productos)
      expect(productos).toHaveLength(3)
      expect(productos.every((p) => p.precio > 0 && p.nombre.trim() && p.descripcion.trim())).toBe(true)
      const conOpciones = productos.filter((p) => p.variantes?.length)
      expect(conOpciones).toHaveLength(1)
      // El precio de lista es el de la primera opción: la tienda lo muestra como "desde".
      expect(conOpciones[0].precio).toBe(conOpciones[0].variantes![0].precio)
    }
  })
  test('un rubro desconocido usa el catálogo genérico', () => {
    expect(esRubro('pizzeria')).toBe(true)
    expect(esRubro('heladeria')).toBe(false)
    expect(catalogoDe('heladeria')).toBe(CATALOGO_EJEMPLO.otro)
    expect(catalogoDe(null)).toBe(CATALOGO_EJEMPLO.otro)
  })
})
