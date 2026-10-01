/**
 * Dobles de prueba del cobro QR: un repositorio en memoria que respeta el contrato de
 * `RepositorioCobrosQr` (mismas reglas que la implementación MySQL) y un Mercado Pago simulado.
 * Los usan los tests del servicio y de la ruta HTTP; no es un test en sí mismo.
 */
import { MpError, type CajaMp, type ClienteMpQr, type EntradaOrdenQr, type OrdenMp, type TiendaMp } from './mp-qr'
import {
  crearServicioCobrosQr,
  type CajaQr,
  type CobroQr,
  type ConexionMp,
  type DatosCajaGuardada,
  type PedidoCobrable,
  type RepositorioCobrosQr,
  type ReservaCobro,
} from './pos-cobros-qr'

export const RESTAURANTE = 7
export const T0 = new Date('2026-09-29T15:00:00.000Z')

// ───────────────────────── Repositorio en memoria (mismo contrato que el de MySQL) ─────────────────────────

export function crearRepoFalso(inicial: { conexion?: Partial<ConexionMp>; pedidos?: Array<Partial<PedidoCobrable> & { id: number }>; cajas?: Array<Partial<CajaQr> & { id: number }> } = {}) {
  const conexion: ConexionMp = { moduloActivo: true, conectado: true, mpUserId: '555', ...inicial.conexion }
  const pedidos = new Map<number, PedidoCobrable>()
  for (const p of inicial.pedidos ?? [{ id: 100 }]) {
    pedidos.set(p.id, { restauranteId: RESTAURANTE, tipo: 'takeaway', sucursalId: null, total: '1500.00', pagado: false, estado: 'pending', ...p })
  }
  const cajas: CajaQr[] = (inicial.cajas ?? [{ id: 1 }]).map((c) => ({
    restauranteId: RESTAURANTE, nombre: `Caja ${c.id}`, mpPosId: `MP${c.id}`, mpStoreId: '10', externalPosId: `PIRU7CAJA${c.id}`,
    qrImagenUrl: `https://mp/qr${c.id}.png`, qrPlantillaUrl: null, activo: true, ...c,
  }))
  const cobros: CobroQr[] = []
  const pagos: Array<{ pedidoId: number; monto: string; mpPaymentId: string | null }> = []
  let sigCobro = 1
  let sigCaja = 100

  const copia = <T extends object>(x: T): T => ({ ...x })
  const activos = (c: CobroQr) => c.estado === 'creando' || c.estado === 'creado'

  const repo: RepositorioCobrosQr = {
    async conexion() { return conexion },
    async listarCajas(restauranteId) { return cajas.filter((c) => c.restauranteId === restauranteId && c.activo).map(copia) },
    async buscarCaja(restauranteId, cajaId) {
      const c = cajas.find((x) => x.id === cajaId && x.restauranteId === restauranteId)
      return c ? copia(c) : null
    },
    async guardarCaja(restauranteId, datos: DatosCajaGuardada) {
      const existente = cajas.find((c) => c.restauranteId === restauranteId && c.mpPosId === datos.mpPosId)
      if (existente) { Object.assign(existente, datos, { activo: true }); return copia(existente) }
      const nueva: CajaQr = { id: sigCaja++, restauranteId, activo: true, ...datos }
      cajas.push(nueva)
      return copia(nueva)
    },
    async desactivarCaja(restauranteId, cajaId) {
      const c = cajas.find((x) => x.id === cajaId && x.restauranteId === restauranteId && x.activo)
      if (!c) return false
      c.activo = false
      return true
    },
    async buscarPedido(restauranteId, pedidoId) {
      const p = pedidos.get(pedidoId)
      return p && p.restauranteId === restauranteId ? copia(p) : null
    },
    async reservarCobro(d): Promise<ReservaCobro> {
      for (const c of cobros) {
        if (c.cajaId === d.cajaId && c.estado === 'creando' && !c.mpOrderId && d.ahora.getTime() - c.createdAt.getTime() > d.vigenciaCreandoMs) {
          c.estado = 'error'
          c.mensaje = 'No se llegó a crear la orden'
        }
      }
      const deLaCaja = cobros.find((c) => activos(c) && c.cajaId === d.cajaId && c.pedidoId !== d.pedidoId)
      if (deLaCaja) return { tipo: 'ocupada', cobro: copia(deLaCaja) }
      const enOtraCaja = cobros.find((c) => activos(c) && c.pedidoId === d.pedidoId && c.cajaId !== d.cajaId)
      if (enOtraCaja) return { tipo: 'ocupada', cobro: copia(enOtraCaja) }
      const propio = cobros.find((c) => activos(c) && c.pedidoId === d.pedidoId && c.cajaId === d.cajaId)
      if (propio) return { tipo: 'existente', cobro: copia(propio) }
      const nuevo: CobroQr = {
        id: sigCobro++, restauranteId: d.restauranteId, pedidoId: d.pedidoId, cajaId: d.cajaId, monto: d.monto,
        externalReference: d.referencia, mpOrderId: null, estado: 'creando', mpStatus: null, mpStatusDetail: null,
        mpPaymentId: null, montoPagado: null, mensaje: null, expiraAt: null, pagadoAt: null, createdAt: d.ahora, updatedAt: d.ahora,
      }
      cobros.push(nuevo)
      return { tipo: 'nuevo', cobro: copia(nuevo) }
    },
    async registrarOrden(cobroId, d) {
      const c = cobros.find((x) => x.id === cobroId && x.estado === 'creando')
      if (!c) return null
      Object.assign(c, { mpOrderId: d.mpOrderId, mpStatus: d.mpStatus, estado: 'creado', expiraAt: d.expiraAt, updatedAt: d.ahora })
      return copia(c)
    },
    async transicionar(cobroId, desde, cambios) {
      const c = cobros.find((x) => x.id === cobroId)
      if (!c || !desde.includes(c.estado)) return null
      const { ahora, ...resto } = cambios
      Object.assign(c, resto, { updatedAt: ahora })
      return copia(c)
    },
    async buscarCobro(cobroId) {
      const c = cobros.find((x) => x.id === cobroId)
      return c ? copia(c) : null
    },
    async buscarCobroPorOrdenMp(mpOrderId) {
      const c = cobros.find((x) => x.mpOrderId === mpOrderId)
      return c ? copia(c) : null
    },
    async ultimoCobroDePedido(restauranteId, pedidoId) {
      const c = [...cobros].reverse().find((x) => x.pedidoId === pedidoId && x.restauranteId === restauranteId)
      return c ? copia(c) : null
    },
    async confirmarPago(d) {
      const c = cobros.find((x) => x.id === d.cobroId)!
      if (!activos(c)) return { aplicado: false, cobro: copia(c), pedido: null }
      Object.assign(c, { estado: 'pagado', mpPaymentId: d.paymentId, montoPagado: d.montoPagado, mpStatus: d.mpStatus, mpStatusDetail: d.mpStatusDetail, pagadoAt: d.ahora, updatedAt: d.ahora, mensaje: null })
      const pedido = pedidos.get(c.pedidoId)!
      pedido.pagado = true
      pagos.push({ pedidoId: pedido.id, monto: d.montoPagado, mpPaymentId: d.paymentId })
      return { aplicado: true, cobro: copia(c), pedido: copia(pedido) }
    },
    async cancelarPedidoImpago(restauranteId, pedidoId) {
      const p = pedidos.get(pedidoId)
      if (!p || p.restauranteId !== restauranteId || p.pagado || ['cancelled', 'archived', 'delivered'].includes(p.estado)) return null
      p.estado = 'cancelled'
      return copia(p)
    },
  }
  return { repo, cobros, pedidos, cajas, pagos, conexion }
}

// ───────────────────────────── Mercado Pago simulado ─────────────────────────────

/** Caja de Mercado Pago de un test: `activa` se omite y vale `true`. */
export type CajaRemotaFalsa = Omit<CajaMp, 'activa'> & { activa?: boolean }
const comoCajaMp = (caja: CajaRemotaFalsa): CajaMp => ({ activa: true, ...caja })

export function crearMpFalso() {
  const ordenes = new Map<string, OrdenMp>()
  const creadas: Array<{ restauranteId: number; entrada: EntradaOrdenQr }> = []
  const consultas: string[] = []
  const cancelaciones: string[] = []
  const cfg: {
    falloCrear: Error | null
    falloObtener: Error | null
    falloCancelar: Error | null
    cajasRemotas: CajaRemotaFalsa[]
    tiendas: TiendaMp[]
    cajasCreadas: Array<{ nombre: string; tiendaId: string; externalPosId: string }>
  } = { falloCrear: null, falloObtener: null, falloCancelar: null, cajasRemotas: [], tiendas: [], cajasCreadas: [] }
  let n = 1

  const cliente: ClienteMpQr = {
    async crearOrdenQr(restauranteId, entrada) {
      if (cfg.falloCrear) throw cfg.falloCrear
      creadas.push({ restauranteId, entrada })
      // Idempotencia real: misma referencia, misma orden.
      const previa = [...ordenes.values()].find((o) => o.externalReference === entrada.referencia)
      if (previa) return { ...previa }
      const orden: OrdenMp = { id: `ORD${n++}`, status: 'created', statusDetail: null, externalReference: entrada.referencia, totalAmount: entrada.monto, totalPaidAmount: null, pagos: [] }
      ordenes.set(orden.id, orden)
      return { ...orden }
    },
    async obtenerOrden(_r, id) {
      consultas.push(id)
      if (cfg.falloObtener) throw cfg.falloObtener
      const o = ordenes.get(id)
      if (!o) throw new MpError('not found', { status: 404 })
      return { ...o }
    },
    async cancelarOrden(_r, id) {
      cancelaciones.push(id)
      if (cfg.falloCancelar) throw cfg.falloCancelar
      const o = ordenes.get(id)
      if (!o) throw new MpError('not found', { status: 404 })
      if (o.status !== 'created') throw new MpError('No se puede cancelar', { status: 400, code: 'cannot_cancel_order' })
      o.status = 'canceled'
      return { ...o }
    },
    async listarCajas() { return cfg.cajasRemotas.map(comoCajaMp) },
    async obtenerCaja(_r, id) {
      const caja = cfg.cajasRemotas.find((c) => c.id === id)
      return caja ? comoCajaMp(caja) : null
    },
    async listarTiendas() { return cfg.tiendas },
    async crearCaja(_r, entrada) {
      cfg.cajasCreadas.push(entrada)
      return { id: '900', nombre: entrada.nombre, externalId: entrada.externalPosId, storeId: entrada.tiendaId, externalStoreId: null, qrImagen: null, qrPlantilla: null, activa: true }
    },
  }
  /** Simula lo que hace el comprador/Mercado Pago sobre la orden. */
  const mutar = (id: string, cambios: Partial<OrdenMp>) => Object.assign(ordenes.get(id)!, cambios)
  const pagar = (id: string, monto?: string) => mutar(id, {
    status: 'processed', statusDetail: 'accredited', totalPaidAmount: monto ?? ordenes.get(id)!.totalAmount,
    pagos: [{ id: `PAY-${id}`, status: 'processed', statusDetail: 'accredited', amount: monto ?? ordenes.get(id)!.totalAmount, paidAmount: monto ?? ordenes.get(id)!.totalAmount }],
  })
  return { cliente, ordenes, creadas, consultas, cancelaciones, cfg, mutar, pagar }
}

export function montar(inicial: Parameters<typeof crearRepoFalso>[0] = {}, opciones: { consultaMinimaMs?: number; appConfigurada?: boolean } = {}) {
  const r = crearRepoFalso(inicial)
  const mp = crearMpFalso()
  let reloj = T0.getTime()
  const efectosPagados: number[] = []
  const efectosCancelados: number[] = []
  const logs: string[] = []
  const servicio = crearServicioCobrosQr({
    repo: r.repo,
    mp: mp.cliente,
    efectos: {
      async pagoConfirmado(p) { efectosPagados.push(p.id) },
      async pedidoCancelado(p) { efectosCancelados.push(p.id) },
    },
    ahora: () => new Date(reloj),
    consultaMinimaMs: opciones.consultaMinimaMs ?? 0,
    appConfigurada: opciones.appConfigurada === undefined ? undefined : () => opciones.appConfigurada!,
    log: (m) => { logs.push(m) },
  })
  return { ...r, mp, servicio, efectosPagados, efectosCancelados, logs, avanzar: (ms: number) => { reloj += ms } }
}

