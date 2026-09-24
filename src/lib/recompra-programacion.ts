// src/lib/recompra-programacion.ts
//
// La DECISIÓN del dueño convertida en una lista concreta de envíos: a quiénes, cuántos, hasta qué
// toque y cada cuánto. Antes esto no existía como decisión —el motor detectaba la cohorte solo cada
// vez que alguien miraba la pantalla— y ahora es lo único que crea filas nuevas en la cola.
//
// El motivo del módulo aparte es el mismo que el de `recompra-goteo.ts` y `motor-recompra-prioridad.ts`:
// `motor-recompra.ts` y `recupero.ts` abren el pool de MySQL al importarse, así que nada que quieran
// fijar los tests puede vivir ahí. `ClienteCohorte` se importa como TIPO (`import type`), que el
// transpilador borra: este módulo no arrastra una sola dependencia de runtime.
//
// Dominio puro: sin DB, sin Hono, sin WhatsApp.

import { normalizarToque, TOQUE_MAX, type SegmentoRecompra, type ToqueRecompra } from './recetas-recompra'
import { diasEntreToques } from './recompra-goteo'
import { calcularPrioridadStock } from './motor-recompra-prioridad'
import type { ClienteCohorte } from './recupero'

/** Mínimo de mensajes de una tanda: programar 0 no es programar. */
export const CANTIDAD_MIN = 1

/**
 * Tope de una tanda. No es una regla de negocio: es un tope de cordura para que un dedazo no
 * encoles diez mil filas de una. Con el cupo máximo (60/día) una tanda de 500 tarda ~9 días.
 */
export const CANTIDAD_MAX = 500

export const PORCENTAJE_CONTROL_DEFAULT = 10
/** 0 = sin control (el dueño renuncia a medir el uplift). */
export const PORCENTAJE_CONTROL_MIN = 0
/** Arriba de 30% el control deja de ser una muestra y se come la tanda. */
export const PORCENTAJE_CONTROL_MAX = 30

/** Lo que el dueño pidió desde la pantalla del motor. Todo opcional salvo la cantidad. */
export interface EspecificacionProgramacion {
  /** Segmento elegido. `null`/ausente = "en general" (todos los recuperables). */
  segmento?: SegmentoRecompra | null
  /** N: mensajes que el asistente selecciona automáticamente. Los `incluirIds` se suman aparte. */
  cantidad?: number | null
  /** Hasta qué toque llega la tanda (1 = sólo primeros toques). */
  toqueHasta?: number | null
  /** Días entre el 1º y el 2º toque. Ausente = los del local. */
  diasToque2?: number | null
  /** Días entre el 2º y el 3º. Ausente = los del local. */
  diasToque3?: number | null
  /** % del lote apartado como control. Ausente = el del local. */
  porcentajeControl?: number | null
  /** Clientes que el dueño agregó a mano a la lista. */
  incluirIds?: number[] | null
  /** Clientes que el dueño sacó de la lista. */
  excluirIds?: number[] | null
}

/** La especificación ya acotada: nada fuera de rango llega a la base ni al planificador. */
export interface EspecificacionNormalizada {
  segmento: SegmentoRecompra | null
  cantidad: number
  toqueHasta: ToqueRecompra
  /** `null` = usar los días configurados del local (la tanda no los pisa). */
  diasToque2: number | null
  diasToque3: number | null
  /** `null` = usar el % de control del local. */
  porcentajeControl: number | null
  incluirIds: number[]
  excluirIds: number[]
}

function enteroEnRango(valor: number | null | undefined, min: number, max: number): number | null {
  if (valor == null) return null
  const n = typeof valor === 'string' ? Number(valor) : valor
  if (!Number.isFinite(n)) return null
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

/** Ids positivos, enteros, sin repetir y en el orden en que llegaron (el orden es la prioridad). */
function idsValidos(ids: number[] | null | undefined): number[] {
  if (!Array.isArray(ids)) return []
  const vistos = new Set<number>()
  const out: number[] = []
  for (const id of ids) {
    const n = typeof id === 'string' ? Number(id) : id
    if (!Number.isFinite(n) || n <= 0) continue
    const entero = Math.trunc(n)
    if (vistos.has(entero)) continue
    vistos.add(entero)
    out.push(entero)
  }
  return out
}

/**
 * Acota la especificación. Es la única puerta por la que entra lo que mandó la UI, así que ningún
 * valor fuera de rango puede llegar a la base: la cantidad, el toque y el % se recortan acá, y los
 * días de recontacto —que además tienen su propio piso anti-spam— se dejan pasar crudos cuando
 * vienen ausentes para que la tanda herede los del local.
 */
export function normalizarEspecificacion(
  spec: EspecificacionProgramacion = {},
  fallback: { diasToque2?: number | null; diasToque3?: number | null; porcentajeControl?: number | null } = {},
): EspecificacionNormalizada {
  const segmento = spec.segmento ?? null
  const excluirIds = idsValidos(spec.excluirIds)
  const excluidos = new Set(excluirIds)

  return {
    segmento: segmento && SEGMENTOS_PROGRAMABLES.includes(segmento) ? segmento : null,
    cantidad: enteroEnRango(spec.cantidad, CANTIDAD_MIN, CANTIDAD_MAX) ?? CANTIDAD_MIN,
    toqueHasta: normalizarToque(spec.toqueHasta ?? 1),
    // El override de la tanda manda; si no vino, se guarda el del local al momento de programar para
    // que la tanda quede auditable aunque después cambie la config (es lo que se le prometió al cliente).
    diasToque2: resolverDias(spec.diasToque2, fallback.diasToque2),
    diasToque3: resolverDias(spec.diasToque3, fallback.diasToque3),
    porcentajeControl: enteroEnRango(
      spec.porcentajeControl ?? fallback.porcentajeControl,
      PORCENTAJE_CONTROL_MIN,
      PORCENTAJE_CONTROL_MAX,
    ) ?? PORCENTAJE_CONTROL_DEFAULT,
    incluirIds: idsValidos(spec.incluirIds).filter((id) => !excluidos.has(id)),
    excluirIds,
  }
}

/**
 * Días de espaciado que se guardan en la tanda: `null` significa "los del local" y así queda escrito.
 * Un valor presente pasa por el piso anti-spam de 48 hs antes de guardarse, para que la fila de la
 * campaña no mienta sobre lo que el motor va a hacer de verdad.
 */
function resolverDias(override: number | null | undefined, delLocal: number | null | undefined): number | null {
  if (override == null && delLocal == null) return null
  return diasEntreToques(override ?? delLocal)
}

/** Los segmentos que la pantalla puede programar. `activo`/`vip` no son recuperables, por definición. */
export const SEGMENTOS_PROGRAMABLES: readonly SegmentoRecompra[] = ['primer_pedido', 'en_riesgo', 'dormido', 'perdido']

/** Ticket promedio del cliente: desempata la prioridad dentro de cada segmento. */
export function ticketDeCliente(cl: Pick<ClienteCohorte, 'totalGastado' | 'cantidadPedidos'>): number {
  return cl.cantidadPedidos > 0 ? cl.totalGastado / cl.cantidadPedidos : cl.totalGastado
}

/**
 * Orden de la lista del asistente: prioridad del segmento × ticket, descendente.
 *
 * El desempate por `clienteId` ascendente no es cosmético: sin él dos clientes con el mismo score
 * podrían intercambiar posiciones entre dos previews y la lista que el dueño vio no sería la que se
 * programó.
 */
export function ordenarPorPrioridad(cohorte: ClienteCohorte[]): ClienteCohorte[] {
  return [...cohorte].sort((a, b) => {
    const pa = calcularPrioridadStock(a.segmento, ticketDeCliente(a))
    const pb = calcularPrioridadStock(b.segmento, ticketDeCliente(b))
    if (pb !== pa) return pb - pa
    return a.clienteId - b.clienteId
  })
}

/** Los candidatos del segmento pedido ("en general" = todos los recuperables). */
export function filtrarPorSegmento(
  cohorte: ClienteCohorte[],
  segmento: SegmentoRecompra | null,
): ClienteCohorte[] {
  return segmento ? cohorte.filter((cl) => cl.segmento === segmento) : cohorte
}

export interface SeleccionProgramacion {
  /** Los que reciben los toques: los elegidos a mano primero, después los N automáticos. */
  contactar: ClienteCohorte[]
  /**
   * El grupo de control: sale de los SIGUIENTES de la misma lista de prioridad, así que no descuenta
   * de la cantidad pedida ni gasta cupo diario. Si la lista se termina, el control queda incompleto
   * —mejor eso que recortar los envíos que el dueño pidió.
   */
  control: ClienteCohorte[]
  /** Cuántos candidatos había disponibles después de aplicar exclusiones y filtro de segmento. */
  elegibles: number
  /** Ids que el dueño pidió incluir a mano y no están en la cohorte (opt-out, sin teléfono, tope…). */
  incluidosIgnorados: number[]
}

/**
 * Convierte la especificación en la lista concreta de a quién se le va a escribir.
 *
 * Los `incluirIds` van PRIMERO y sin pasar por el filtro de segmento: agregar a mano a alguien de
 * otro segmento es una decisión editorial explícita del dueño (la receta la resuelve su propio
 * segmento al enviar). Lo que NO pueden saltear es la protección de la base: si el cliente no está
 * en la cohorte —opt-out, sin teléfono, tope mensual, cooldown— no se lo puede programar, y el id
 * vuelve en `incluidosIgnorados` para que la pantalla lo diga en vez de mentir.
 */
export function seleccionarCandidatos(
  cohorte: ClienteCohorte[],
  spec: EspecificacionNormalizada,
): SeleccionProgramacion {
  const excluidos = new Set(spec.excluirIds)
  const porId = new Map(cohorte.map((cl) => [cl.clienteId, cl]))

  const manuales: ClienteCohorte[] = []
  const incluidosIgnorados: number[] = []
  for (const id of spec.incluirIds) {
    if (excluidos.has(id)) continue
    const cl = porId.get(id)
    if (!cl) {
      incluidosIgnorados.push(id)
      continue
    }
    manuales.push(cl)
  }

  const base = ordenarPorPrioridad(filtrarPorSegmento(cohorte, spec.segmento))
  const yaElegidos = new Set(manuales.map((cl) => cl.clienteId))
  const resto = base.filter((cl) => !excluidos.has(cl.clienteId) && !yaElegidos.has(cl.clienteId))

  const automaticos = resto.slice(0, spec.cantidad)
  const contactar = [...manuales, ...automaticos]

  // El control sale del tramo que sigue en la lista, no de la lista entera: un control elegido entre
  // los mejores deja de ser comparable con los contactados (sesgo de selección) y la tasa mentiría.
  const nControl = Math.round(contactar.length * (spec.porcentajeControl ?? PORCENTAJE_CONTROL_DEFAULT) / 100)
  const control = resto.slice(automaticos.length, automaticos.length + nControl)

  return {
    contactar,
    control,
    elegibles: base.filter((cl) => !excluidos.has(cl.clienteId)).length + manuales.filter((cl) => !base.some((b) => b.clienteId === cl.clienteId)).length,
    incluidosIgnorados,
  }
}

/**
 * El toque que le sigue a un cliente dentro de ESTA tanda, o null si la tanda no llega hasta ahí.
 *
 * Es distinto de `toqueSiguiente`: aquél avanza por el ledger histórico del cliente (`¿cuántos toques
 * lleva desde su último pedido?`), y éste responde la pregunta de la tanda (`¿hasta dónde dije que
 * llegaba?`). Una tanda de "sólo primeros toques" corta acá aunque el cliente tenga historial de sobra.
 */
export function programarToqueSiguiente(
  toquesEnviados: number,
  toqueHasta: number | null | undefined,
): ToqueRecompra | null {
  const hasta = normalizarToque(toqueHasta ?? 1)
  const t = typeof toquesEnviados === 'number' && Number.isFinite(toquesEnviados) ? Math.trunc(toquesEnviados) : 0
  if (t < 1) return null
  const siguiente = t + 1
  if (siguiente > hasta || siguiente > TOQUE_MAX) return null
  return normalizarToque(siguiente)
}
