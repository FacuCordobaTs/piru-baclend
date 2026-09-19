import { describe, expect, test } from 'bun:test'
import {
  esSegmentoRecompra,
  listarRecetasRecompra,
  RECETAS_RECOMPRA,
  resolverBeneficioRecompra,
  resolverRecetaRecompra,
  resolverSegmentoRecompraDesdeRFM,
  SEGMENTOS_RECUPERABLES,
  textoIncentivoReceta,
  type EscalonIncentivo,
} from './recetas-recompra'

/**
 * La escalera de `recupero.ts` espejada acá a propósito: el test fija el contrato del recetario
 * (qué pasa en cada nivel) sin arrastrar el pool de MySQL ni el cliente de WhatsApp.
 */
const ESCALERA: EscalonIncentivo[] = [
  { nivel: 1, descuento: 0, expiraHoras: null },
  { nivel: 2, descuento: 10, expiraHoras: null },
  { nivel: 3, descuento: 20, expiraHoras: 48 },
]

describe('recetario del Motor de Recompra', () => {
  test('hay una receta por segmento recuperable, con nombre y copy propios', () => {
    const recetas = listarRecetasRecompra()
    expect(recetas.map((r) => r.codigo)).toEqual(SEGMENTOS_RECUPERABLES)
    expect(new Set(recetas.map((r) => r.textoBase)).size).toBe(recetas.length)
    for (const r of recetas) {
      expect(r.nombre.length).toBeGreaterThan(0)
      expect(r.textoBase.length).toBeGreaterThan(0)
    }
  })

  test('el vocabulario de segmentos se valida', () => {
    expect(esSegmentoRecompra('dormido')).toBe(true)
    expect(esSegmentoRecompra('vip')).toBe(false)
    expect(esSegmentoRecompra(null)).toBe(false)
  })

  test('el segmento RFM se traduce al vocabulario del motor (y activo/vip no son recuperables)', () => {
    expect(resolverSegmentoRecompraDesdeRFM('nuevo')).toBe('primer_pedido')
    expect(resolverSegmentoRecompraDesdeRFM('dormido')).toBe('dormido')
    expect(resolverSegmentoRecompraDesdeRFM('activo')).toBeNull()
    expect(resolverSegmentoRecompraDesdeRFM('vip')).toBeNull()
  })

  test('resolverRecetaRecompra devuelve la receta del segmento pedido', () => {
    expect(resolverRecetaRecompra('perdido').codigo).toBe('perdido')
    expect(RECETAS_RECOMPRA.primer_pedido.codigo).toBe('primer_pedido')
  })
})

describe('beneficio de un toque: la escalera manda, la receta sólo puede bajarlo', () => {
  const escalon = (nivel: number) => ESCALERA[nivel - 1]

  test('la receta recomendada conserva el beneficio de la escalera (el mensaje del automático no cambia)', () => {
    for (const nivel of [1, 2, 3]) {
      const e = escalon(nivel)
      const receta = resolverRecetaRecompra('dormido')
      expect(resolverBeneficioRecompra(e, receta, true)).toEqual({
        nivel: e.nivel,
        descuento: e.descuento,
        expiraHoras: e.expiraHoras,
      })
    }
  })

  test('elegir una receta sin descuento apaga el cupón sin reiniciar la escalera', () => {
    const e = escalon(3) // 20% OFF con vencimiento
    const beneficio = resolverBeneficioRecompra(e, resolverRecetaRecompra('en_riesgo'), false)
    expect(beneficio.descuento).toBe(0)
    expect(beneficio.nivel).toBe(3)
    expect(beneficio.expiraHoras).toBeNull()
  })

  test('el techo de la receta recorta la escalera, nunca la sube', () => {
    const e = escalon(3) // 20%
    // `dormido` tiene techo 10%: elegida a mano, baja el beneficio al 10% de su propia receta.
    const dormido = resolverBeneficioRecompra(e, resolverRecetaRecompra('dormido'), false)
    expect(dormido.descuento).toBe(10)
    expect(dormido.descuento).toBeLessThan(e.descuento)
    // `perdido` tiene techo 20% con vencimiento: coincide con el escalón, no lo supera.
    const perdido = resolverBeneficioRecompra(e, resolverRecetaRecompra('perdido'), false)
    expect(perdido.descuento).toBe(20)
    expect(perdido.descuento).toBeLessThanOrEqual(e.descuento)
  })

  test('nunca hay descuento si la escalera no lo habilitó, aunque la receta tenga techo', () => {
    for (const receta of listarRecetasRecompra()) {
      expect(resolverBeneficioRecompra(escalon(1), receta, false).descuento).toBe(0)
    }
  })
})

describe('copy del toque', () => {
  test('sin descuento es la voz del segmento, sin hablar de cupones', () => {
    const receta = resolverRecetaRecompra('perdido')
    const texto = textoIncentivoReceta(receta, { nivel: 1, descuento: 0, expiraHoras: null }, null)
    expect(texto).toBe(receta.textoBase)
    expect(texto).not.toContain('código')
  })

  test('con descuento agrega la línea del cupón debajo del hook del segmento', () => {
    const receta = resolverRecetaRecompra('dormido')
    const texto = textoIncentivoReceta(receta, { nivel: 2, descuento: 10, expiraHoras: null }, 'VOLVE10-7')
    expect(texto.startsWith(receta.textoBase)).toBe(true)
    expect(texto).toContain('10% de descuento')
    expect(texto).toContain('VOLVE10-7')
  })

  test('con vencimiento avisa las horas del escalón', () => {
    const receta = resolverRecetaRecompra('perdido')
    const texto = textoIncentivoReceta(receta, { nivel: 3, descuento: 20, expiraHoras: 48 }, 'VOLVE20-7')
    expect(texto).toContain('20% OFF')
    expect(texto).toContain('vence en 48 horas')
  })

  test('cada segmento recibe un texto distinto con el mismo beneficio', () => {
    const beneficio = { nivel: 2, descuento: 10, expiraHoras: null }
    const textos = listarRecetasRecompra().map((r) => textoIncentivoReceta(r, beneficio, 'VOLVE10-7'))
    expect(new Set(textos).size).toBe(textos.length)
  })
})
