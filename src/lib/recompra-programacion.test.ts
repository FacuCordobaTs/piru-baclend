// src/lib/recompra-programacion.test.ts
//
// Fija la DECISIÓN del dueño: la lista que ve en pantalla tiene que ser exactamente la que se
// programa. Los casos que importan son los que protegen eso —el orden determinista, que el control
// salga de los siguientes y no descuente de N, que agregar a mano no saltee la protección de la
// base— y los clamps, porque son la única puerta por la que entra lo que mandó la UI.

import { describe, expect, test } from 'bun:test'
import {
  CANTIDAD_MAX,
  CANTIDAD_MIN,
  filtrarPorSegmento,
  normalizarEspecificacion,
  ordenarPorPrioridad,
  PORCENTAJE_CONTROL_MAX,
  PORCENTAJE_CONTROL_MIN,
  programarToqueSiguiente,
  seleccionarCandidatos,
  SEGMENTOS_PROGRAMABLES,
  ticketDeCliente,
} from './recompra-programacion'
import { DIAS_ENTRE_TOQUES_MIN } from './recompra-goteo'
import type { ClienteCohorte } from './recupero'
import type { SegmentoRecompra } from './recetas-recompra'

// ── Fixtures ─────────────────────────────────────────────────────────────────
function cliente(over: Partial<ClienteCohorte> & { clienteId: number }): ClienteCohorte {
  return {
    nombre: `Cliente ${over.clienteId}`,
    telefono: `54911000000${over.clienteId}`,
    segmento: 'perdido',
    diasDesdeUltimo: 90,
    totalGastado: 10000,
    ultimoPedidoMs: null,
    cantidadPedidos: 4,
    proximoNivel: 1,
    toquesDesdeUltimoPedido: 0,
    ultimoToqueMs: null,
    fechasPedidosMs: [],
    ...over,
  }
}

/** Cohorte con un segmento por cliente, en orden de id, para razonar el orden esperado a mano. */
function cohorteMixta(): ClienteCohorte[] {
  return [
    cliente({ clienteId: 1, segmento: 'perdido', totalGastado: 4000 }),
    cliente({ clienteId: 2, segmento: 'primer_pedido', totalGastado: 1000 }),
    cliente({ clienteId: 3, segmento: 'en_riesgo', totalGastado: 5000 }),
    cliente({ clienteId: 4, segmento: 'dormido', totalGastado: 2000 }),
    cliente({ clienteId: 5, segmento: 'perdido', totalGastado: 9000 }),
    cliente({ clienteId: 6, segmento: 'dormido', totalGastado: 8000 }),
  ]
}

const ids = (arr: { clienteId: number }[]) => arr.map((c) => c.clienteId)
const spec = (
  over: Parameters<typeof normalizarEspecificacion>[0] = {},
  fallback: Parameters<typeof normalizarEspecificacion>[1] = {},
) => normalizarEspecificacion(over, fallback)

// ── normalizarEspecificacion ─────────────────────────────────────────────────
describe('normalizarEspecificacion', () => {
  test('la cantidad se recorta al rango programable y nunca queda en 0', () => {
    expect(spec({ cantidad: 0 }).cantidad).toBe(CANTIDAD_MIN)
    expect(spec({ cantidad: -30 }).cantidad).toBe(CANTIDAD_MIN)
    expect(spec({ cantidad: 10_000 }).cantidad).toBe(CANTIDAD_MAX)
    expect(spec({ cantidad: 50.9 }).cantidad).toBe(50)
    expect(spec({}).cantidad).toBe(CANTIDAD_MIN)
    expect(spec({ cantidad: null }).cantidad).toBe(CANTIDAD_MIN)
    expect(spec({ cantidad: Number.NaN }).cantidad).toBe(CANTIDAD_MIN)
  })

  test('el toqueHasta se recorta a 1..3', () => {
    expect(spec({ toqueHasta: 0 }).toqueHasta).toBe(1)
    expect(spec({ toqueHasta: 2 }).toqueHasta).toBe(2)
    expect(spec({ toqueHasta: 3 }).toqueHasta).toBe(3)
    expect(spec({ toqueHasta: 9 }).toqueHasta).toBe(3)
    expect(spec({}).toqueHasta).toBe(1)
  })

  test('el % de control se recorta a 0..30 y sin valor cae en el default', () => {
    expect(spec({ porcentajeControl: -5 }).porcentajeControl).toBe(PORCENTAJE_CONTROL_MIN)
    expect(spec({ porcentajeControl: 99 }).porcentajeControl).toBe(PORCENTAJE_CONTROL_MAX)
    expect(spec({ porcentajeControl: 20 }).porcentajeControl).toBe(20)
    // 0 es una decisión válida: renunciar a medir el uplift.
    expect(spec({ porcentajeControl: 0 }).porcentajeControl).toBe(0)
    expect(spec({}).porcentajeControl).toBe(10)
  })

  test('sólo se aceptan segmentos programables: activo y vip no son recuperables', () => {
    expect(spec({ segmento: 'perdido' }).segmento).toBe('perdido')
    expect(spec({ segmento: 'primer_pedido' }).segmento).toBe('primer_pedido')
    // 'activo'/'vip' existen como string pero no son un segmento del motor.
    expect(spec({ segmento: 'vip' as SegmentoRecompra }).segmento).toBeNull()
    expect(spec({ segmento: 'activo' as SegmentoRecompra }).segmento).toBeNull()
    expect(spec({ segmento: null }).segmento).toBeNull()
    expect(spec({}).segmento).toBeNull()
  })

  test('los segmentos programables son los recuperables, sin activo ni vip', () => {
    expect([...SEGMENTOS_PROGRAMABLES]).toEqual(['primer_pedido', 'en_riesgo', 'dormido', 'perdido'])
  })

  test('los días entre toques heredan los del local y respetan el piso de 48 hs', () => {
    // Sin nada: se guarda el del local (para que la tanda quede auditable).
    expect(spec({}, { diasToque2: 5, diasToque3: 7 }).diasToque2).toBe(5)
    expect(spec({}, { diasToque2: 5, diasToque3: 7 }).diasToque3).toBe(7)
    // El override de la tanda manda sobre el del local.
    expect(spec({ diasToque2: 3 }, { diasToque2: 6 }).diasToque2).toBe(3)
    // El piso anti-spam no se puede bajar por configuración.
    expect(spec({ diasToque2: 1 }, { diasToque2: 1 }).diasToque2).toBe(DIAS_ENTRE_TOQUES_MIN)
    expect(spec({ diasToque3: 0 }, { diasToque3: 0 }).diasToque3).toBe(DIAS_ENTRE_TOQUES_MIN)
    // Sin valor en ningún lado queda null = "usá el del local al momento de programar".
    expect(spec({}).diasToque2).toBeNull()
  })

  test('los ids se limpian: enteros positivos, sin repetir, en el orden recibido', () => {
    const s = spec({ incluirIds: [3, 3, -1, 0, 2.9, Number.NaN], excluirIds: [1, 1, 1] })
    expect(s.incluirIds).toEqual([3, 2])
    expect(s.excluirIds).toEqual([1])
  })

  test('un id incluido y excluido a la vez sale de la lista: gana la exclusión', () => {
    expect(spec({ incluirIds: [1, 2, 3], excluirIds: [2] }).incluirIds).toEqual([1, 3])
  })

  test('acepta ids como string (los query params llegan así) y descarta la basura', () => {
    const s = spec({ incluirIds: ['7', '8', 'abc'] as unknown as number[] })
    expect(s.incluirIds).toEqual([7, 8])
  })
})

// ── Orden y prioridad ────────────────────────────────────────────────────────
describe('prioridad y orden', () => {
  test('el ticket promedio sale del gasto total sobre la cantidad de pedidos', () => {
    expect(ticketDeCliente({ totalGastado: 10_000, cantidadPedidos: 4 })).toBe(2500)
    // Sin pedidos no hay promedio: el gasto total es lo único que hay.
    expect(ticketDeCliente({ totalGastado: 700, cantidadPedidos: 0 })).toBe(700)
  })

  test('ordena por peso de segmento y desempata por ticket', () => {
    // primer_pedido (4) > en_riesgo (3) > dormido (2) > perdido (1).
    expect(ids(ordenarPorPrioridad(cohorteMixta()))).toEqual([2, 3, 6, 4, 5, 1])
  })

  test('el desempate por clienteId hace el orden reproducible entre dos llamadas', () => {
    // Mismo segmento, mismo ticket: sin desempate estable el preview podría no coincidir con lo
    // que se programa (dos clientes intercambiables de posición entre llamadas).
    const cohorte = [
      cliente({ clienteId: 30, segmento: 'dormido', totalGastado: 2000, cantidadPedidos: 1 }),
      cliente({ clienteId: 10, segmento: 'dormido', totalGastado: 2000, cantidadPedidos: 1 }),
      cliente({ clienteId: 20, segmento: 'dormido', totalGastado: 2000, cantidadPedidos: 1 }),
    ]
    expect(ids(ordenarPorPrioridad(cohorte))).toEqual([10, 20, 30])
    expect(ids(ordenarPorPrioridad([...cohorte].reverse()))).toEqual([10, 20, 30])
  })

  test('no muta la cohorte que recibe', () => {
    const cohorte = cohorteMixta()
    const antes = ids(cohorte)
    ordenarPorPrioridad(cohorte)
    expect(ids(cohorte)).toEqual(antes)
  })

  test('filtrarPorSegmento con null devuelve todo ("en general")', () => {
    const cohorte = cohorteMixta()
    expect(ids(filtrarPorSegmento(cohorte, null))).toEqual([1, 2, 3, 4, 5, 6])
    expect(ids(filtrarPorSegmento(cohorte, 'perdido'))).toEqual([1, 5])
    expect(ids(filtrarPorSegmento(cohorte, 'primer_pedido'))).toEqual([2])
  })
})

// ── seleccionarCandidatos ────────────────────────────────────────────────────
describe('seleccionarCandidatos', () => {
  test('toma los N mejores en orden de prioridad', () => {
    const { contactar, control } = seleccionarCandidatos(cohorteMixta(), spec({ cantidad: 3, porcentajeControl: 0 }))
    expect(ids(contactar)).toEqual([2, 3, 6])
    expect(control).toEqual([])
  })

  test('el segmento acota la lista antes de elegir', () => {
    const { contactar } = seleccionarCandidatos(
      cohorteMixta(),
      spec({ segmento: 'perdido', cantidad: 10, porcentajeControl: 0 }),
    )
    // Sólo los perdidos, y entre ellos primero el de mayor ticket.
    expect(ids(contactar)).toEqual([5, 1])
  })

  test('excluirIds saca al cliente y libera su lugar para el siguiente', () => {
    const { contactar } = seleccionarCandidatos(
      cohorteMixta(),
      spec({ cantidad: 3, excluirIds: [2, 3], porcentajeControl: 0 }),
    )
    // Sin 2 ni 3, entran el 6, el 4 y el 5 (el 1 queda afuera por el corte en 3).
    expect(ids(contactar)).toEqual([6, 4, 5])
  })

  test('el control sale de los SIGUIENTES de la misma lista y no descuenta de N', () => {
    const { contactar, control } = seleccionarCandidatos(cohorteMixta(), spec({ cantidad: 2, porcentajeControl: 10 }))
    expect(ids(contactar)).toEqual([2, 3])
    // N=2 → 10% = 0.2 → round = 0: con tandas chicas el control puede quedar vacío.
    expect(ids(control)).toEqual([])

    const grande = Array.from({ length: 20 }, (_, i) => cliente({ clienteId: i + 1, segmento: 'dormido' }))
    const r = seleccionarCandidatos(grande, spec({ cantidad: 10, porcentajeControl: 10 }))
    expect(r.contactar).toHaveLength(10)
    expect(r.control).toHaveLength(1)
    // El control sale del puesto 11, no de la lista entera: si saliera de los mejores, la tasa
    // del control dejaría de ser comparable con la de los contactados (sesgo de selección).
    expect(ids(r.control)).toEqual([11])
  })

  test('si la lista se termina, el control queda incompleto antes que recortar los envíos', () => {
    const r = seleccionarCandidatos(cohorteMixta(), spec({ cantidad: 6, porcentajeControl: 30 }))
    expect(ids(r.contactar)).toEqual([2, 3, 6, 4, 5, 1])
    expect(r.control).toEqual([])
  })

  test('porcentajeControl 0 es una decisión válida: no hay grupo de control', () => {
    const grande = Array.from({ length: 50 }, (_, i) => cliente({ clienteId: i + 1 }))
    expect(seleccionarCandidatos(grande, spec({ cantidad: 10, porcentajeControl: 0 })).control).toEqual([])
  })

  test('los incluidos a mano van PRIMERO y no consumen el cupo de los automáticos', () => {
    const r = seleccionarCandidatos(cohorteMixta(), spec({ cantidad: 2, incluirIds: [4], porcentajeControl: 0 }))
    // El 4 entra primero aunque su prioridad sea baja, y el N=2 se sigue eligiendo del resto.
    expect(ids(r.contactar)).toEqual([4, 2, 3])
  })

  test('incluir un id que no está en la cohorte no se inventa: vuelve en incluidosIgnorados', () => {
    // La cohorte ya viene filtrada por la protección de la base (opt-out, sin teléfono, tope,
    // cooldown), así que un id ausente es un cliente NO contactable. Agregarlo a mano no puede
    // saltear eso; la pantalla lo tiene que decir en vez de mentir.
    const r = seleccionarCandidatos(cohorteMixta(), spec({ cantidad: 1, incluirIds: [99], porcentajeControl: 0 }))
    expect(r.incluidosIgnorados).toEqual([99])
    expect(ids(r.contactar)).toEqual([2])
  })

  test('el incluido a mano puede ser de OTRO segmento: es decisión editorial del dueño', () => {
    const r = seleccionarCandidatos(
      cohorteMixta(),
      spec({ segmento: 'perdido', cantidad: 1, incluirIds: [2], porcentajeControl: 0 }),
    )
    // El 2 es primer_pedido y el filtro era 'perdido': entra igual porque fue pedido a mano.
    expect(ids(r.contactar)).toEqual([2, 5])
  })

  test('un incluido a mano no se duplica si además cae en los automáticos', () => {
    const r = seleccionarCandidatos(cohorteMixta(), spec({ cantidad: 3, incluirIds: [2], porcentajeControl: 0 }))
    expect(ids(r.contactar)).toEqual([2, 3, 6, 4])
    expect(new Set(ids(r.contactar)).size).toBe(r.contactar.length)
  })

  test('contactar y control nunca se solapan', () => {
    const grande = Array.from({ length: 40 }, (_, i) => cliente({ clienteId: i + 1, segmento: 'dormido' }))
    const r = seleccionarCandidatos(grande, spec({ cantidad: 20, porcentajeControl: 30 }))
    const solapan = ids(r.contactar).filter((id) => r.control.some((c) => c.clienteId === id))
    expect(solapan).toEqual([])
  })

  test('una cohorte vacía no rompe: no hay a quién contactar', () => {
    const r = seleccionarCandidatos([], spec({ cantidad: 50 }))
    expect(r.contactar).toEqual([])
    expect(r.control).toEqual([])
    expect(r.elegibles).toBe(0)
  })
})

// ── programarToqueSiguiente ──────────────────────────────────────────────────
describe('programarToqueSiguiente', () => {
  test('una tanda de sólo primeros toques no encola ninguno', () => {
    expect(programarToqueSiguiente(1, 1)).toBeNull()
  })

  test('avanza sólo hasta donde llega la tanda', () => {
    expect(programarToqueSiguiente(1, 2)).toBe(2)
    expect(programarToqueSiguiente(2, 2)).toBeNull()
    expect(programarToqueSiguiente(1, 3)).toBe(2)
    expect(programarToqueSiguiente(2, 3)).toBe(3)
    expect(programarToqueSiguiente(3, 3)).toBeNull()
  })

  test('nunca pasa de 3, aunque la tanda pida más', () => {
    expect(programarToqueSiguiente(3, 99)).toBeNull()
    expect(programarToqueSiguiente(2, 99)).toBe(3)
  })

  test('sin un toque previo no hay siguiente: la tanda no arranca por el 2º', () => {
    // Es la garantía de que el 1º siempre sale primero: sin él, el cliente recibiría un
    // "segundo aviso" de algo que nunca le llegó.
    expect(programarToqueSiguiente(0, 3)).toBeNull()
    expect(programarToqueSiguiente(-1, 3)).toBeNull()
  })

  test('toqueHasta ausente o inválido se comporta como 1', () => {
    expect(programarToqueSiguiente(1, null)).toBeNull()
    expect(programarToqueSiguiente(1, undefined)).toBeNull()
    expect(programarToqueSiguiente(1, Number.NaN)).toBeNull()
  })

  test('devuelve siempre un toque del 1 al 3 (es lo que va a la columna tinyint)', () => {
    for (const hasta of [1, 2, 3]) {
      for (const enviados of [1, 2, 3]) {
        const t = programarToqueSiguiente(enviados, hasta)
        if (t != null) expect([1, 2, 3]).toContain(t)
      }
    }
  })
})