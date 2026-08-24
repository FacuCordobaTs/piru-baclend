type ItemConfig = {
  productoId: number
  varianteId?: number | null
  varianteSecundariaId?: number | null
  ingredientesExcluidos?: unknown
  agregados?: unknown
  nota?: string | null
}

const normalizarJson = (value: unknown) => {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value)) } catch { return value }
  }
  return JSON.stringify(value ?? null)
}

export const mismaConfiguracionItem = (anterior: ItemConfig, siguiente: ItemConfig) =>
  anterior.productoId === siguiente.productoId
  && (anterior.varianteId ?? null) === (siguiente.varianteId ?? null)
  && (anterior.varianteSecundariaId ?? null) === (siguiente.varianteSecundariaId ?? null)
  && normalizarJson(anterior.ingredientesExcluidos) === normalizarJson(siguiente.ingredientesExcluidos)
  && normalizarJson(anterior.agregados) === normalizarJson(siguiente.agregados)
  && (anterior.nota ?? null) === (siguiente.nota ?? null)

export function cantidadImpresaTrasEdicion(
  anterior: ItemConfig & { cantidadImpresa?: number | null },
  siguiente: ItemConfig & { cantidad: number },
) {
  return mismaConfiguracionItem(anterior, siguiente)
    ? Math.min(Math.max(0, Number(anterior.cantidadImpresa ?? 0)), siguiente.cantidad)
    : 0
}

export function cantidadesPendientes(items: Array<{ id: number; cantidad: number; cantidadImpresa?: number | null }>) {
  return items.flatMap((item) => {
    const cantidad = Math.max(0, Number(item.cantidad) - Number(item.cantidadImpresa ?? 0))
    return cantidad > 0 ? [{ id: item.id, cantidad }] : []
  })
}
