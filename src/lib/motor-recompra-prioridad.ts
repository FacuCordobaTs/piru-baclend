/** Peso del segmento para drenar el stock: en_riesgo primero, perdido al final. */
const PESO_SEGMENTO_STOCK: Record<string, number> = { en_riesgo: 3, dormido: 2, perdido: 1 }

/** El segmento domina y el ticket histórico desempata dentro del segmento. */
export function calcularPrioridadStock(segmento: string, ticket: number): number {
  const peso = PESO_SEGMENTO_STOCK[segmento] ?? 1
  return peso * 10_000_000 + Math.min(Math.round(ticket), 9_999_999)
}
