import { describe, expect, test } from 'bun:test'
import {
  componerCuerpoToque,
  esSegmentoRecompra,
  lineaBeneficioRecompra,
  listarPlantillasNuevas,
  listarRecetasRecompra,
  listarRecetasToque,
  normalizarToque,
  RECETAS_RECOMPRA,
  RECETAS_TOQUE,
  resolverBeneficioRecompra,
  resolverPlantillaRecompra,
  resolverRecetaRecompra,
  resolverRecetaToque,
  resolverSegmentoRecompraDesdeRFM,
  SEGMENTOS_RECUPERABLES,
  TOQUES_RECOMPRA,
  type EscalonIncentivo,
  type VariableToque,
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

/** Los 5 datos que puede usar un tramo, con valores distinguibles entre sí. */
const VALORES: Record<VariableToque, string> = {
  cliente: 'Facundo',
  local: 'Alfajor con Papas',
  tiempoSinPedir: '3 semanas',
  productoFavorito: 'Alfajor Especial',
  beneficio: 'Te guardamos 10% OFF.',
}

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

describe('beneficio de un toque: la recomendada es la escalera, la elegida a mano trae el suyo', () => {
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

  test('la receta elegida a mano aplica su propio beneficio: puede bajar o subir el del escalón', () => {
    // Baja: el escalón ya daba 20% y el operador manda la receta moderada del 10%.
    expect(resolverBeneficioRecompra(escalon(3), resolverRecetaRecompra('dormido'), false)).toEqual({
      nivel: 3,
      descuento: 10,
      expiraHoras: null,
    })
    // Sube: el primer toque no daba descuento y el operador manda el último intento (20% / 48 hs).
    expect(resolverBeneficioRecompra(escalon(1), resolverRecetaRecompra('perdido'), false)).toEqual({
      nivel: 1,
      descuento: 20,
      expiraHoras: 48,
    })
  })

  test('en el primer toque la recomendada sigue sin descuento, pero las recetas con techo lo traen', () => {
    const e = escalon(1)
    expect(resolverBeneficioRecompra(e, resolverRecetaRecompra('dormido'), true).descuento).toBe(0)
    expect(resolverBeneficioRecompra(e, resolverRecetaRecompra('dormido'), false).descuento).toBe(10)
    expect(resolverBeneficioRecompra(e, resolverRecetaRecompra('perdido'), false).descuento).toBe(20)
    // Las recetas sin incentivo no inventan descuento ni elegidas a mano.
    for (const codigo of ['primer_pedido', 'en_riesgo'] as const) {
      const beneficio = resolverBeneficioRecompra(e, resolverRecetaRecompra(codigo), false)
      expect(beneficio.descuento).toBe(0)
      expect(beneficio.expiraHoras).toBeNull()
    }
  })
})

describe('recetario por segmento × toque', () => {
  test('hay un tramo por cada segmento y cada toque, y el nombre de la plantilla los identifica', () => {
    expect(listarRecetasToque()).toHaveLength(SEGMENTOS_RECUPERABLES.length * TOQUES_RECOMPRA.length)
    for (const segmento of SEGMENTOS_RECUPERABLES) {
      for (const toque of TOQUES_RECOMPRA) {
        const r = RECETAS_TOQUE[segmento][toque]
        expect(r.segmento).toBe(segmento)
        expect(r.toque).toBe(toque)
        expect(r.cuerpo.length).toBeGreaterThan(0)
      }
    }
    expect(resolverRecetaToque('en_riesgo', 2).plantilla).toBe('recupero_toque2_en_riesgo_v1')
    expect(resolverPlantillaRecompra('perdido', 3)).toBe('recupero_toque3_perdido_v1')
    expect(resolverPlantillaRecompra('primer_pedido', 1)).toBe('recupero_toque1_primer_pedido_v1')
  })

  test('el 1º toque de dormido conserva la plantilla histórica (ya está aprobada en las WABAs)', () => {
    expect(RECETAS_TOQUE.dormido[1].plantilla).toBe('recupero_dormido_v1')
    // Y es la ÚNICA histórica: las otras 11 hay que crearlas en Meta.
    expect(listarRecetasToque().filter((r) => r.plantilla === 'recupero_dormido_v1')).toHaveLength(1)
    expect(listarPlantillasNuevas()).toHaveLength(11)
    expect(listarPlantillasNuevas().some((r) => r.plantilla === 'recupero_dormido_v1')).toBe(false)
  })

  test('las 11 plantillas nuevas tienen nombre único (una por combinación)', () => {
    const nombres = listarPlantillasNuevas().map((r) => r.plantilla)
    expect(new Set(nombres).size).toBe(11)
  })

  test('sólo el 1º toque lleva la foto del producto; el 2º y el 3º van sin encabezado', () => {
    for (const segmento of SEGMENTOS_RECUPERABLES) {
      expect(RECETAS_TOQUE[segmento][1].conImagen).toBe(true)
      expect(RECETAS_TOQUE[segmento][2].conImagen).toBe(false)
      expect(RECETAS_TOQUE[segmento][3].conImagen).toBe(false)
    }
  })

  test('primer_pedido no habla de ausencia: no usa el tiempo sin pedir en ningún toque', () => {
    // No se fue, todavía no volvió: "hace 3 semanas que no te vemos" le quedaría mal.
    for (const toque of TOQUES_RECOMPRA) {
      expect(RECETAS_TOQUE.primer_pedido[toque].variables).not.toContain('tiempoSinPedir')
    }
    // Por eso el producto favorito cae en {{3}} y no en {{4}}.
    expect(RECETAS_TOQUE.primer_pedido[1].variables).toEqual([
      'cliente',
      'local',
      'productoFavorito',
      'beneficio',
    ])
    for (const segmento of ['dormido', 'en_riesgo', 'perdido'] as const) {
      expect(RECETAS_TOQUE[segmento][1].variables).toEqual([
        'cliente',
        'local',
        'tiempoSinPedir',
        'productoFavorito',
        'beneficio',
      ])
    }
  })

  test('los toques 2 y 3 son cortos y no pueden apoyarse en una imagen que no se ve', () => {
    for (const segmento of SEGMENTOS_RECUPERABLES) {
      for (const toque of [2, 3] as const) {
        // `perdido` no nombra al local, así que su beneficio cae en {{2}} en vez de {{3}}.
        const esperado: VariableToque[] = segmento === 'perdido' && toque === 2
          ? ['cliente', 'beneficio']
          : ['cliente', 'local', 'beneficio']
        expect(RECETAS_TOQUE[segmento][toque].variables).toEqual(esperado)
      }
    }
  })

  test('los placeholders de cada cuerpo son {{1}}..{{n}} consecutivos: Meta rechaza los que saltean', () => {
    // Es LA condición para que una plantilla se pueda crear en WhatsApp Manager. Un cuerpo con
    // `{{1}}` y `{{3}}` no se puede cargar: por eso cada tramo declara sus propias variables.
    for (const receta of listarRecetasToque()) {
      const usados = [...new Set(receta.cuerpo.match(/\{\{\d+\}\}/g) ?? [])]
        .map((m) => Number(m.replace(/[{}]/g, '')))
        .sort((a, b) => a - b)
      const esperados = Array.from({ length: receta.variables.length }, (_, i) => i + 1)
      expect(usados).toEqual(esperados)
    }
  })

  test('ningún cuerpo empieza ni termina con una variable: Meta los rechaza en automático', () => {
    // "Invalid format": una variable como primer o último carácter del cuerpo es rechazo automático,
    // sin revisión humana. Es la razón por la que los toques 2 y 3 cierran con el CTA del botón:
    // la línea de beneficio es la última variable y necesita texto fijo detrás.
    for (const receta of listarRecetasToque()) {
      expect(receta.cuerpo.trimStart().startsWith('{{')).toBe(false)
      expect(receta.cuerpo.trimEnd().endsWith('}}')).toBe(false)
    }
  })

  test('no hay dos variables pegadas sin texto entre medio', () => {
    // Tampoco son válidas dos variables contiguas: "{{1}} {{2}}" se rechaza igual que las sueltas.
    for (const receta of listarRecetasToque()) {
      expect(receta.cuerpo).not.toMatch(/\}\}\s*\{\{/)
    }
  })

  test('el texto fijo alcanza el mínimo de Meta para la cantidad de variables (3n + 1)', () => {
    // Error 2388293, "parameters words ratio exceeds limit": un cuerpo con más variables que texto
    // se lee genérico y no se aprueba. Se cuentan palabras reales (tokens con letras o dígitos), no
    // espacios: los signos que quedan sueltos al quitar las variables no suman.
    const palabrasFijas = (cuerpo: string) =>
      cuerpo
        .replace(/\{\{\d+\}\}/g, ' ')
        .split(/\s+/)
        .filter((token) => /[\p{L}\p{N}]/u.test(token)).length
    for (const receta of listarRecetasToque()) {
      const total = palabrasFijas(receta.cuerpo) + receta.variables.length
      expect(total).toBeGreaterThanOrEqual(3 * receta.variables.length + 1)
    }
  })

  test('el trabajo de cada toque se nota en el cuerpo: relato, recordatorio y cierre', () => {
    for (const segmento of SEGMENTOS_RECUPERABLES) {
      // El 1º presenta el antojo y el CTA del botón.
      expect(RECETAS_TOQUE[segmento][1].cuerpo).toContain('Tocá el botón y pedí en segundos')
      // El 2º es un recordatorio más corto que el relato.
      expect(RECETAS_TOQUE[segmento][2].cuerpo.length).toBeLessThan(
        RECETAS_TOQUE[segmento][1].cuerpo.length,
      )
      // El 3º avisa que cierra (no se puede prometer "última vez" y seguir mandando igual).
      expect(RECETAS_TOQUE[segmento][3].cuerpo.toLowerCase()).toMatch(/últim|cerramos|no es ahora/)
    }
  })
})

describe('el cuerpo renderizado es el mismo que el de la plantilla de Meta', () => {
  test('componerCuerpoToque reemplaza las variables y no deja ningún {{n}} sin resolver', () => {
    for (const receta of listarRecetasToque()) {
      const { texto, parametros } = componerCuerpoToque(receta, VALORES)
      expect(texto).not.toContain('{{')
      expect(parametros.map((p) => p.nombre)).toEqual(receta.variables)
      for (const p of parametros) expect(texto).toContain(p.valor)
    }
  })

  test('los parámetros salen en el orden declarado: es el contrato con las variables posicionales', () => {
    const { parametros } = componerCuerpoToque(RECETAS_TOQUE.en_riesgo[1], VALORES)
    expect(parametros).toEqual([
      { nombre: 'cliente', valor: 'Facundo' },
      { nombre: 'local', valor: 'Alfajor con Papas' },
      { nombre: 'tiempoSinPedir', valor: '3 semanas' },
      { nombre: 'productoFavorito', valor: 'Alfajor Especial' },
      { nombre: 'beneficio', valor: 'Te guardamos 10% OFF.' },
    ])
  })

  test('un toque fuera de rango se normaliza en vez de romper los envíos ya encolados', () => {
    expect(normalizarToque(0)).toBe(1)
    expect(normalizarToque(99)).toBe(3)
    expect(normalizarToque('2')).toBe(2)
    expect(normalizarToque(null)).toBe(1)
    expect(normalizarToque(2.7)).toBe(2)
    expect(resolverRecetaToque('dormido', 99).toque).toBe(3)
    expect(resolverPlantillaRecompra('dormido', 0)).toBe('recupero_dormido_v1')
  })
})

describe('la línea de beneficio', () => {
  test('nunca menciona un código: el descuento viaja en el link y la tienda lo aplica sola', () => {
    for (const nivel of [1, 2, 3]) {
      const e = ESCALERA[nivel - 1]
      for (const toque of TOQUES_RECOMPRA) {
        const linea = lineaBeneficioRecompra(
          { nivel, descuento: e.descuento, expiraHoras: e.expiraHoras },
          toque,
        )
        expect(linea).not.toMatch(/VOLVE|GROWTH|CRECE/)
        expect(linea.toLowerCase()).not.toContain('código')
      }
    }
  })

  test('sin descuento el 1º invita a armar el pedido y los otros dos acompañan', () => {
    const sinDto = { nivel: 1, descuento: 0, expiraHoras: null }
    expect(lineaBeneficioRecompra(sinDto, 1)).toContain('armalo en segundos')
    expect(lineaBeneficioRecompra(sinDto, 2)).toContain('a un toque')
    expect(lineaBeneficioRecompra(sinDto, 3)).toContain('a un toque')
  })

  test('con vencimiento avisa las horas del escalón; sin él, aclara que se aplica solo', () => {
    const ultimo = lineaBeneficioRecompra({ nivel: 3, descuento: 20, expiraHoras: 48 }, 3)
    expect(ultimo).toContain('20% OFF')
    expect(ultimo).toContain('vence en 48 horas')
    expect(lineaBeneficioRecompra({ nivel: 2, descuento: 10, expiraHoras: null }, 2)).toContain(
      '10% de descuento',
    )
  })

  test('cada segmento × toque tiene su propio texto con el mismo beneficio', () => {
    const beneficio = { nivel: 2, descuento: 10, expiraHoras: null }
    const textos = listarRecetasToque().map(
      (r) =>
        componerCuerpoToque(r, {
          ...VALORES,
          beneficio: lineaBeneficioRecompra(beneficio, r.toque),
        }).texto,
    )
    expect(new Set(textos).size).toBe(textos.length)
  })
})
