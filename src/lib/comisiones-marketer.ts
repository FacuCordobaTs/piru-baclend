/** Dominio contable sin DB ni credenciales. Los importes se redondean a centavos. */
export type ItemComision = { tipo: string; monto: number | string }
function centavos(valor: number | string): bigint {
  const numero = Number(valor)
  if (!Number.isFinite(numero) || numero < 0)
    throw new Error('Importe inválido')
  return BigInt(Math.round(numero * 100))
}
export function calcularComision(
  items: ItemComision[],
  porcentaje: number | string,
) {
  const pct = Number(porcentaje)
  if (!Number.isFinite(pct) || pct < 0 || pct > 100)
    throw new Error('Porcentaje inválido')
  const base = items
    .filter((i) => i.tipo === 'base' || i.tipo === 'modulo')
    .reduce((total, i) => total + centavos(i.monto), BigInt(0))
  const monto =
    (base * BigInt(Math.round(pct * 100)) + BigInt(5000)) / BigInt(10000)
  return {
    baseComisionable: Number(base) / 100,
    porcentaje: Math.round(pct * 100) / 100,
    monto: Number(monto) / 100,
  }
}
export function esFacturaComisionable(
  factura: { estado: string; createdAt: Date | string },
  vinculo: {
    estado: string
    activadoAt: Date | string
    marketerActivo: boolean
  } | null,
) {
  return (
    !!vinculo &&
    vinculo.estado === 'activo' &&
    vinculo.marketerActivo &&
    factura.estado === 'paid' &&
    Number.isFinite(new Date(factura.createdAt).getTime()) &&
    new Date(factura.createdAt).getTime() >=
      new Date(vinculo.activadoAt).getTime()
  )
}

export interface FuenteComision {
  factura: {
    id: number
    restauranteId: number
    estado: string
    createdAt: Date | string
  }
  vinculo: {
    marketerId: number
    estado: string
    activadoAt: Date | string
    marketerActivo: boolean
    porcentaje: string | number
  }
  items: ItemComision[]
}
export interface RepositorioComisiones {
  obtenerFuente(pagoId: number): Promise<FuenteComision | null>
  insertarUnica(asiento: {
    pagoSuscripcionId: number
    restauranteId: number
    marketerId: number
    baseComisionable: string
    porcentaje: string
    monto: string
    createdAt: Date
  }): Promise<boolean>
  pendientesDeConciliar(): Promise<number[]>
}
export async function generarComision(
  repo: RepositorioComisiones,
  pagoId: number,
): Promise<boolean> {
  const fuente = await repo.obtenerFuente(pagoId)
  if (!fuente || !esFacturaComisionable(fuente.factura, fuente.vinculo))
    return false
  const calculo = calcularComision(fuente.items, fuente.vinculo.porcentaje)
  if (calculo.baseComisionable <= 0) return false
  return repo.insertarUnica({
    pagoSuscripcionId: pagoId,
    restauranteId: fuente.factura.restauranteId,
    marketerId: fuente.vinculo.marketerId,
    baseComisionable: calculo.baseComisionable.toFixed(2),
    porcentaje: calculo.porcentaje.toFixed(2),
    monto: calculo.monto.toFixed(2),
    createdAt: new Date(),
  })
}
export async function sincronizarComisiones(repo: RepositorioComisiones) {
  let creadas = 0
  let fallidas = 0
  for (const id of await repo.pendientesDeConciliar()) {
    try {
      if (await generarComision(repo, id)) creadas++
    } catch {
      fallidas++
    }
  }
  return { creadas, fallidas }
}
