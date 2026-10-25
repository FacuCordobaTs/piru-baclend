export type TipoCupon = 'porcentaje' | 'monto_fijo' | 'envio_gratis'

/** El envío se conserva en el pedido y se bonifica una sola vez como descuento. */
export function calcularBeneficioCupon(
  cupon: { tipo: TipoCupon; valor: string; montoMinimo?: string | null },
  pedido: { total: number; tipoPedido?: 'delivery' | 'takeaway'; costoEnvio?: number },
): { montoDescuento: number; error?: never } | { error: string; montoDescuento?: never } {
  const total = Math.max(0, pedido.total)
  const envio = pedido.tipoPedido === 'delivery' ? Math.max(0, pedido.costoEnvio ?? 0) : 0
  if (cupon.tipo === 'envio_gratis') {
    if (pedido.tipoPedido !== 'delivery') return { error: 'Este cupón es válido sólo para delivery' }
    if (envio <= 0) return { error: 'Este cupón requiere un envío con costo; quitá el canje de envío con puntos si lo activaste' }
  }
  const minimo = Number(cupon.montoMinimo || 0)
  const baseMinimo = cupon.tipo === 'envio_gratis' ? Math.max(0, total - envio) : total
  if (baseMinimo < minimo) return { error: `El código requiere un mínimo de $${minimo.toFixed(0)}` }
  const descuento = cupon.tipo === 'envio_gratis' ? envio
    : cupon.tipo === 'porcentaje' ? total * Number(cupon.valor) / 100 : Number(cupon.valor)
  return { montoDescuento: Math.round(Math.min(total, Math.max(0, descuento)) * 100) / 100 }
}
