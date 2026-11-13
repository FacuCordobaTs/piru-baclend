// Liquidación de un cadete para un período.
//
// El local configura cuatro importes por repartidor: lo que paga por envío y el
// fijo por día según el tipo de día (hábil, fin de semana o feriado). Un día
// cuenta como trabajado si tiene al menos una entrega asignada y no cancelada.
// Si un feriado cae sábado o domingo, se paga como feriado.
//
// Es una función pura: los días y los feriados propios los resuelve la ruta y
// así se puede probar sin base de datos.

import { tipoDeDia, type TipoDia } from './feriados-ar'

export interface ConfigPagoRepartidor {
  precioEnvio: number
  pagoDiaHabil: number
  pagoFinDeSemana: number
  pagoFeriado: number
}

export interface DiaTrabajado {
  fecha: string // YYYY-MM-DD
  entregas: number
}

export interface LiquidacionRepartidor {
  entregas: number
  diasTrabajados: number
  diasHabiles: number
  diasFinDeSemana: number
  diasFeriados: number
  pagoEnvios: number
  pagoDias: number
  pagoTotal: number
}

const redondear2 = (n: number) => Math.round(n * 100) / 100

/**
 * `feriados` son los feriados propios del local (se suman a los nacionales).
 * Cada fecha debe aparecer una sola vez en `dias`: la consulta los agrupa.
 */
export function liquidarRepartidor(
  config: ConfigPagoRepartidor,
  dias: DiaTrabajado[],
  feriados: ReadonlySet<string> = new Set(),
): LiquidacionRepartidor {
  let entregas = 0
  let diasHabiles = 0
  let diasFinDeSemana = 0
  let diasFeriados = 0

  for (const dia of dias) {
    const tipo: TipoDia = tipoDeDia(dia.fecha, feriados)
    entregas += dia.entregas
    if (tipo === 'feriado') diasFeriados += 1
    else if (tipo === 'fin_de_semana') diasFinDeSemana += 1
    else diasHabiles += 1
  }

  const pagoEnvios = redondear2(config.precioEnvio * entregas)
  const pagoDias = redondear2(
    diasHabiles * config.pagoDiaHabil +
      diasFinDeSemana * config.pagoFinDeSemana +
      diasFeriados * config.pagoFeriado,
  )

  return {
    entregas,
    diasTrabajados: dias.length,
    diasHabiles,
    diasFinDeSemana,
    diasFeriados,
    pagoEnvios,
    pagoDias,
    pagoTotal: redondear2(pagoEnvios + pagoDias),
  }
}
