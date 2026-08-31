export interface OfertaProductoCampana {
  id: number
  productoId: number
  descuentoProductoPorcentaje: number
  limiteUsos: number | null
  usosActuales: number
  fechaInicio: Date | null
  fechaFin: Date | null
}

export function ofertaProductoEstaVigente(oferta: OfertaProductoCampana, ahora = new Date()): boolean {
  return (!oferta.fechaInicio || oferta.fechaInicio <= ahora)
    && (!oferta.fechaFin || oferta.fechaFin >= ahora)
    && (oferta.limiteUsos == null || oferta.usosActuales < oferta.limiteUsos)
}

/**
 * La oferta nunca empeora un descuento propio del producto. Se aplica al
 * precio de producto/variante y no a los agregados ni a otros productos.
 */
export function aplicarOfertaProducto(
  precioBase: number,
  descuentoPropioPorcentaje: number,
  productoId: number,
  oferta: OfertaProductoCampana | null,
) {
  const descuentoPropio = Math.max(0, Math.min(100, descuentoPropioPorcentaje || 0))
  const descuentoCampana = oferta?.productoId === productoId
    ? Math.max(0, Math.min(100, oferta.descuentoProductoPorcentaje || 0))
    : 0
  const descuentoAplicado = Math.max(descuentoPropio, descuentoCampana)
  const precioConDescuentoPropio = precioBase * (1 - descuentoPropio / 100)
  const precioFinal = precioBase * (1 - descuentoAplicado / 100)
  return {
    precioFinal,
    descuentoAplicado,
    descuentoAtribuibleCampana: Math.max(0, precioConDescuentoPropio - precioFinal),
  }
}
