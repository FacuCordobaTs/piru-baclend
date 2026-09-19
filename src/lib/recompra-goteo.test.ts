import { describe, expect, test } from 'bun:test'
import { ESCALERA, NIVEL_MAX } from './recetas-recompra'
import {
  arranqueDeRecontacto,
  COOLDOWN_HORAS,
  dueDateDeRecontacto,
  estadoRecupero,
  finDeCooldown,
  MS_POR_HORA,
  reprogramarPorCooldown,
  reprogramarPorSilencio,
  toqueSiguiente,
} from './recompra-goteo'

/**
 * El ritmo del goteo: cada cuánto puede salir un toque, cuál le sigue y en qué escalón está el
 * cliente. Son las fórmulas que deciden si el motor insiste de más o se queda trabado, así que se
 * fijan acá — en un módulo puro, porque `recupero.ts` y `motor-recompra.ts` abren el pool de MySQL
 * al importarse y nada que quieran fijar los tests puede vivir ahí.
 *
 * LÍMITE CONOCIDO: lo que NO se cubre son las condiciones que dependen de consultas —grupo de
 * control, tope de 4 contactos en 30 días y el filtro de la cohorte—, que viven en
 * `detectarFlujo`/`sincronizarFlujo` y necesitan base. Acá está la parte pura, que es donde estaban
 * los riesgos reales: reencolar el mismo toque, reprogramar hacia el pasado y contar mal los toques
 * desde el último pedido.
 */

const AHORA = new Date('2026-09-19T15:00:00.000Z').getTime()
const HORA = MS_POR_HORA

describe('cooldown entre toques', () => {
  test('48 horas es la ventana mínima entre dos toques', () => {
    expect(COOLDOWN_HORAS).toBe(48)
  })

  test('el fin del cooldown se cuenta desde el último toque', () => {
    expect(finDeCooldown(AHORA - 10 * HORA, AHORA)).toBe(AHORA - 10 * HORA + 48 * HORA)
  })

  test('una fecha desconocida espera una ventana completa, no cero', () => {
    // Lado conservador a propósito: acá un null es "no pudimos fechar el último toque", y el motor
    // sólo llega con al menos una fila en el ledger. Ante la duda, esperar antes que arriesgar dos
    // mensajes seguidos. (El opuesto —sin toque previo no hay cooldown— es `estadoRecupero`.)
    expect(finDeCooldown(null, AHORA)).toBe(AHORA + 48 * HORA)
  })

  test('el recontacto arranca en el fin del cooldown, nunca antes de ahora', () => {
    // El último toque fue hace 47 hs: todavía le queda una hora de espera.
    expect(arranqueDeRecontacto(AHORA - 47 * HORA, AHORA)).toBe(AHORA + 1 * HORA)
    // El último toque fue hace 10 días: el cooldown ya venció y manda el ahora.
    expect(arranqueDeRecontacto(AHORA - 240 * HORA, AHORA)).toBe(AHORA)
  })
})

describe('cuándo se encola el toque siguiente', () => {
  // Último toque hace 40 hs → el cooldown vence en AHORA + 8h. Así los dos candidatos de abajo caen
  // uno de cada lado del piso y se ve cuál gana.
  const ULTIMO = AHORA - 40 * HORA
  const FIN_COOLDOWN = AHORA + 8 * HORA

  test('el fin del cooldown es un piso, aunque el patrón habitual proponga antes', () => {
    const temprano = new Date(AHORA + 2 * HORA)
    expect(dueDateDeRecontacto(temprano, ULTIMO, AHORA).getTime()).toBe(FIN_COOLDOWN)
  })

  test('el primer hueco habitual posterior al cooldown manda sobre el piso', () => {
    const tarde = new Date(AHORA + 30 * HORA)
    expect(dueDateDeRecontacto(tarde, ULTIMO, AHORA).getTime()).toBe(tarde.getTime())
  })

  test('sin cooldown fechado el patrón habitual también espera la ventana', () => {
    const slot = new Date(AHORA + 5 * HORA)
    expect(dueDateDeRecontacto(slot, null, AHORA).getTime()).toBe(AHORA + 48 * HORA)
  })

  test('sin patrón de envío queda el fin del cooldown', () => {
    expect(dueDateDeRecontacto(null, ULTIMO, AHORA).getTime()).toBe(FIN_COOLDOWN)
  })

  test('con el cooldown ya vencido la fila queda lista para drenar, no espera de nuevo', () => {
    // Fin del cooldown hace 2 hs (en el pasado): eso no es un error, es "puede salir ya". Si acá
    // devolviera AHORA + 48h, un cliente elegible volvería a esperar dos días en cada tick.
    const vencido = dueDateDeRecontacto(null, AHORA - 50 * HORA, AHORA)
    expect(vencido.getTime()).toBe(AHORA - 2 * HORA)
    expect(vencido.getTime()).toBeLessThan(AHORA)
  })
})

describe('qué toque le sigue a un cliente ya contactado', () => {
  test('con el 1º enviado le toca el 2º, y con el 2º el 3º', () => {
    expect(toqueSiguiente(1, new Set())).toBe(2)
    expect(toqueSiguiente(2, new Set())).toBe(3)
  })

  test('con los 3 toques agotados no le toca ninguno', () => {
    expect(toqueSiguiente(3, new Set())).toBeNull()
    expect(toqueSiguiente(4, new Set())).toBeNull()
  })

  test('un cliente sin toques enviados no entra por el 2º o el 3º', () => {
    // El toque 1 lo encola el goteo normal: si acá devolviera 2, un cliente de una campaña anterior
    // arrancaría el goteo por el medio.
    expect(toqueSiguiente(0, new Set())).toBeNull()
  })

  test('no se reencola un toque que ya está en la cola, en cualquier estado', () => {
    expect(toqueSiguiente(1, new Set([2]))).toBeNull()
    expect(toqueSiguiente(2, new Set([3]))).toBeNull()
    // Tener encolado OTRO toque no bloquea el que corresponde.
    expect(toqueSiguiente(1, new Set([1]))).toBe(2)
  })

  test('un valor imposible no rompe: normaliza o no encola', () => {
    expect(toqueSiguiente(Number.NaN, new Set())).toBeNull()
    expect(toqueSiguiente(-5, new Set())).toBeNull()
  })
})

describe('reprogramación de un intento que no pudo salir', () => {
  test('el reintento por cooldown siempre queda en el futuro', () => {
    const reintento = reprogramarPorCooldown(AHORA)
    expect(reintento.getTime()).toBeGreaterThan(AHORA)
    expect(reintento.getTime()).toBe(AHORA + 48 * HORA + 5 * 60 * 1000)
  })

  test('el reintento por silencio es una hora, no un día', () => {
    expect(reprogramarPorSilencio(AHORA).getTime()).toBe(AHORA + HORA)
  })

  test('una fila bloqueada no se reprograma dos veces hacia el mismo instante', () => {
    // Dos ticks seguidos del drenaje producen dos dueDate estrictamente crecientes: es lo que
    // garantiza que la fila avance en vez de reintentarse en cada tick.
    const primero = reprogramarPorCooldown(AHORA)
    const segundo = reprogramarPorCooldown(primero.getTime())
    expect(segundo.getTime()).toBeGreaterThan(primero.getTime())
  })
})

describe('el estado del goteo de un cliente', () => {
  const hace = (horas: number) => new Date(AHORA - horas * HORA)
  const toque = (nivel: number, horas: number) => ({ nivel, createdAt: hace(horas) })

  test('un cliente sin toques arranca en el escalón 1 y sin cooldown', () => {
    const e = estadoRecupero([], AHORA - 100 * HORA, AHORA)
    expect(e.proximoNivel).toBe(1)
    expect(e.toquesDesdeUltimoPedido).toBe(0)
    expect(e.puedeEnviar).toBe(true)
    expect(e.ultimoEnvioAt).toBeNull()
    expect(e.ultimoNivel).toBeNull()
  })

  test('los toques que cuentan son los posteriores al último pedido: si volvió a pedir, la escalera se reinicia', () => {
    const e = estadoRecupero(
      [toque(1, 100), toque(2, 80), toque(3, 60)],
      AHORA - 70 * HORA, // pidió después de los dos primeros toques y antes del tercero
      AHORA,
    )
    expect(e.totalEnvios).toBe(3)
    expect(e.toquesDesdeUltimoPedido).toBe(1)
    expect(e.proximoNivel).toBe(2)
  })

  test('el conteo crudo no se capa aunque el nivel sí: es lo que frena el 4º toque', () => {
    const tres = estadoRecupero([toque(1, 90), toque(2, 70), toque(3, 50)], AHORA - 100 * HORA, AHORA)
    expect(tres.toquesDesdeUltimoPedido).toBe(3)
    expect(tres.proximoNivel).toBe(3)

    // Un 4º toque en el ledger (dato viejo o carga manual) tiene que verse: `proximoNivel` sigue
    // capado, pero el conteo crudo dice "ya se agotó" y `toqueSiguiente` no reencola nada más.
    const cuatro = estadoRecupero(
      [toque(1, 90), toque(2, 70), toque(3, 50), toque(3, 30)],
      AHORA - 100 * HORA,
      AHORA,
    )
    expect(cuatro.toquesDesdeUltimoPedido).toBe(4)
    expect(cuatro.proximoNivel).toBe(3)
    expect(toqueSiguiente(cuatro.toquesDesdeUltimoPedido, new Set())).toBeNull()
  })

  test('el cooldown se mide contra el último toque, sin importar el orden en que lleguen', () => {
    // Desordenados a propósito: el ledger no garantiza orden.
    const dentro = estadoRecupero([toque(2, 10), toque(1, 47)], AHORA - 100 * HORA, AHORA)
    expect(dentro.puedeEnviar).toBe(false)
    expect(dentro.ultimoNivel).toBe(2)

    const fuera = estadoRecupero([toque(2, 50), toque(1, 60)], AHORA - 100 * HORA, AHORA)
    expect(fuera.puedeEnviar).toBe(true)
    expect(fuera.ultimoNivel).toBe(2)
  })

  test('cada escalón trae su porcentaje y su vencimiento', () => {
    expect(ESCALERA.map((e) => e.descuento)).toEqual([0, 10, 20])
    expect(ESCALERA.map((e) => e.expiraHoras)).toEqual([null, null, 48])
    expect(ESCALERA.map((e) => e.nivel)).toEqual([1, 2, 3])
    expect(NIVEL_MAX).toBe(3)
  })
})
