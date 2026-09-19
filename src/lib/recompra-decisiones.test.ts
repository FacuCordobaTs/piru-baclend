import { describe, expect, test } from 'bun:test'
import { decisionesRecetaSchema, opcionesDeDecisiones } from './recompra-decisiones'

/** Valida y devuelve lo que el motor recibiría. Falla el test si el schema rechaza. */
function decidir(entrada: Record<string, unknown>) {
  const parsed = decisionesRecetaSchema.safeParse(entrada)
  if (!parsed.success) throw new Error(`el schema rechazó ${JSON.stringify(entrada)}`)
  return opcionesDeDecisiones(parsed.data)
}

function rechaza(entrada: Record<string, unknown>) {
  return decisionesRecetaSchema.safeParse(entrada).success === false
}

describe('las tres decisiones del envío manual', () => {
  test('sin nada elegido no se decide nada: el motor pone sus defaults', () => {
    // Es la diferencia entre "no lo mandé" y "lo mandé en 0": un 0 apagaría el descuento ganado.
    expect(decidir({})).toEqual({
      segmento: undefined,
      toque: undefined,
      link: undefined,
      descuento: undefined,
    })
  })

  test('los números llegan como texto desde la query y se convierten', () => {
    expect(decidir({ toque: '2', descuento: '20' })).toMatchObject({ toque: 2, descuento: 20 })
    expect(decidir({ toque: 3, descuento: 5 })).toMatchObject({ toque: 3, descuento: 5 })
  })

  test('un campo vacío es "no lo mandé", no un valor inválido', () => {
    // El admin manda los cinco campos siempre; los que no se tocaron viajan como ''.
    expect(decidir({ segmento: '', toque: '', link: '', descuento: '' })).toEqual({
      segmento: undefined,
      toque: undefined,
      link: undefined,
      descuento: undefined,
    })
    // `optional()` no acepta `null`, así que el `null` explícito también se traduce a ausente.
    expect(decidir({ toque: null, descuento: null, link: null })).toMatchObject({ toque: undefined })
  })

  test('el vocabulario es cerrado: ni segmentos RFM ni toques inventados', () => {
    expect(rechaza({ segmento: 'vip' })).toBe(true)
    expect(rechaza({ segmento: 'activo' })).toBe(true)
    expect(rechaza({ link: 'descuento_banner' })).toBe(true)
    expect(rechaza({ toque: '0' })).toBe(true)
    expect(rechaza({ toque: '4' })).toBe(true)
    expect(rechaza({ toque: '2.7' })).toBe(true)
    for (const segmento of ['primer_pedido', 'en_riesgo', 'dormido', 'perdido']) {
      expect(decidir({ segmento })).toMatchObject({ segmento })
    }
  })

  test('el descuento va de 0 a 30: por encima se va de margen y por debajo no existe', () => {
    expect(decidir({ descuento: '0' }).descuento).toBe(0)
    expect(decidir({ descuento: '30' }).descuento).toBe(30)
    expect(rechaza({ descuento: '31' })).toBe(true)
    expect(rechaza({ descuento: '-1' })).toBe(true)
    expect(rechaza({ descuento: 'mucho' })).toBe(true)
  })

  test('el link "lo mismo" y el descuento no pueden ir juntos', () => {
    // No se resuelve solo a propósito: son dos pedidos incompatibles y adivinar cuál quiso es peor.
    expect(rechaza({ link: 'lo-mismo', descuento: 10 })).toBe(true)
    expect(rechaza({ link: 'lo-mismo', descuento: '5' })).toBe(true)
    expect(decidir({ link: 'lo-mismo', descuento: 0 })).toMatchObject({ link: 'lo-mismo', descuento: 0 })
    expect(decidir({ link: 'lo-mismo' })).toMatchObject({ link: 'lo-mismo' })
    expect(decidir({ link: 'reactivacion', descuento: 20 })).toMatchObject({
      link: 'reactivacion',
      descuento: 20,
    })
    // Un descuento sin link elegido no es contradictorio: el motor deriva reactivación.
    expect(decidir({ descuento: 20 })).toMatchObject({ link: undefined, descuento: 20 })
  })

  test('`receta` sigue siendo el nombre viejo de `segmento`, y `segmento` gana', () => {
    expect(decidir({ receta: 'perdido' }).segmento).toBe('perdido')
    expect(decidir({ receta: 'perdido', segmento: 'dormido' }).segmento).toBe('dormido')
    expect(rechaza({ receta: 'vip' })).toBe(true)
  })
})
