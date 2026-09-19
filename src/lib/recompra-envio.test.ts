import { describe, expect, test } from 'bun:test'
import { ESCALERA, listarRecetasRecompra, resolverRecetaRecompra } from './recetas-recompra'
import { resolverEnvioRecompra } from './recompra-envio'

/**
 * Qué se manda en un toque: el copy, el link y el `%`. Es la antesala del cupón y de la plata, y por
 * eso se fija acá — en un módulo puro, porque `recupero.ts` (donde vive el flujo real) abre el pool
 * de MySQL al importarse.
 *
 * LÍMITE CONOCIDO: la emisión del cupón en sí (`upsertCuponRecupero`) y el armado del token necesitan
 * base; acá se cubre la DECISIÓN de la que dependen (`emiteCupon`, `descuento`, `link`).
 */

const escalon = (nivel: number) => ESCALERA[nivel - 1]
const recomendada = resolverRecetaRecompra('dormido')
/** Una receta con incentivo propio: la que el operador elige a mano en vez de la recomendada. */
const conIncentivo = listarRecetasRecompra().find(
  (r) => r.codigo !== recomendada.codigo && r.incentivoMaximo.descuentoPorcentaje > 0,
)!

function envio(over: Partial<Parameters<typeof resolverEnvioRecompra>[0]> = {}) {
  return resolverEnvioRecompra({
    escalon: escalon(1),
    proximoNivel: 1,
    receta: recomendada,
    esRecetaRecomendada: true,
    ...over,
  })
}

describe('el toque elige el copy, la escalera elige el porcentaje', () => {
  test('sin decisiones el toque y el % son los de la escalera', () => {
    const d = envio()
    expect(d.toque).toBe(1)
    expect(d.descuento).toBe(0)
    expect(d.link).toBe('lo-mismo')
    expect(d.descuentoOrigen).toBe('escalon')
  })

  test('mandar el copy de un toque posterior NO adelanta el porcentaje', () => {
    // El operador puede mandar el cierre antes de tiempo: es una decisión editorial sobre el copy.
    // Lo que no puede es regalar el 20 % del 3º a quien todavía está en el escalón 1.
    const d = envio({ toque: 3 })
    expect(d.toque).toBe(3)
    expect(d.descuento).toBe(0)
    expect(d.beneficio.nivel).toBe(1)
    expect(d.emiteCupon).toBe(false)
  })

  test('el nivel registrado es el del escalón aunque el toque sea otro', () => {
    const d = envio({ escalon: escalon(2), proximoNivel: 2, toque: 1 })
    expect(d.toque).toBe(1)
    expect(d.beneficio.nivel).toBe(2)
    expect(d.descuento).toBe(10)
  })

  test('el toque fuera de rango se normaliza en vez de romper', () => {
    expect(envio({ toque: 7 }).toque).toBe(3)
    expect(envio({ toque: 0 }).toque).toBe(1)
    expect(envio({ toque: Number.NaN }).toque).toBe(1)
  })
})

describe('el link decide si hay descuento', () => {
  test('`lo-mismo` nunca lleva descuento, ni con el % más alto elegido a mano', () => {
    // Ese link abre el drawer de un toque, sin banner: un % ahí sería un descuento anunciado que
    // nadie cobra, y además un cupón emitido al pedo.
    const d = envio({ escalon: escalon(3), proximoNivel: 3, link: 'lo-mismo', descuento: 30 })
    expect(d.descuento).toBe(0)
    expect(d.beneficio.expiraHoras).toBeNull()
    expect(d.emiteCupon).toBe(false)
  })

  test('`reactivacion` con descuento es la única combinación que emite cupón, y emite uno solo', () => {
    const d = envio({ escalon: escalon(3), proximoNivel: 3, link: 'reactivacion' })
    expect(d.descuento).toBe(20)
    expect(d.beneficio.expiraHoras).toBe(48)
    expect(d.emiteCupon).toBe(true)
  })

  test('sin link elegido, el que tiene descuento lo enciende solo', () => {
    expect(envio({ escalon: escalon(2), proximoNivel: 2 }).link).toBe('reactivacion')
    expect(envio({ escalon: escalon(1), proximoNivel: 1 }).link).toBe('lo-mismo')
  })

  test('el vencimiento cuelga del descuento: sin `%` no hay nada que venza', () => {
    const d = envio({ escalon: escalon(3), proximoNivel: 3, link: 'lo-mismo' })
    expect(d.beneficio.expiraHoras).toBeNull()
  })
})

describe('el descuento a mano', () => {
  test('gana sobre el de la escalera y queda marcado como manual', () => {
    const d = envio({ escalon: escalon(3), proximoNivel: 3, descuento: 15 })
    expect(d.descuento).toBe(15)
    expect(d.descuentoOrigen).toBe('manual')
  })

  test('se recorta al rango 0..30: por encima se va de margen', () => {
    expect(envio({ descuento: 80, link: 'reactivacion' }).descuento).toBe(30)
    expect(envio({ descuento: -5, link: 'reactivacion' }).descuento).toBe(0)
    expect(envio({ descuento: 12.7, link: 'reactivacion' }).descuento).toBe(12)
  })

  test('0 es "sin descuento" y apaga el cupón', () => {
    const d = envio({ escalon: escalon(3), proximoNivel: 3, descuento: 0, link: 'reactivacion' })
    expect(d.descuento).toBe(0)
    expect(d.emiteCupon).toBe(false)
  })

  test('elegir una receta distinta de la recomendada no reinicia la escalera', () => {
    const d = envio({
      escalon: escalon(2),
      proximoNivel: 2,
      receta: conIncentivo,
      esRecetaRecomendada: false,
    })
    // El `%` sale del techo de esa receta, pero el nivel que avanza sigue siendo el del escalón.
    expect(d.descuentoOrigen).toBe('receta')
    expect(d.descuento).toBe(conIncentivo.incentivoMaximo.descuentoPorcentaje)
    expect(d.beneficio.nivel).toBe(2)
  })
})
