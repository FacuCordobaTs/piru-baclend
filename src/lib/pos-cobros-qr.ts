/**
 * Cobros del POS con el QR estático de una caja de Mercado Pago.
 *
 * Reglas que este servicio garantiza (ver docs/WHATSAPP_AND_PAYMENTS.md):
 * - El monto sale del `total` del pedido persistido; el cliente sólo dice qué pedido y qué caja.
 * - El pago lo confirma el servidor consultando la orden en Mercado Pago (webhook `orders` o
 *   consulta directa mientras el POS espera). El navegador nunca marca nada como pagado.
 * - Una caja con QR estático sólo puede tener una orden pendiente: el servicio lo serializa.
 * - Un pago se acredita una sola vez aunque lleguen el webhook y la consulta a la vez.
 *
 * No importa la base ni el entorno: todo llega por `repo`, `mp` y `efectos`.
 */
import {
  ESTADOS_COBRO_ACTIVOS,
  EXPIRACION_COBRO_MINUTOS,
  MpError,
  aCentavos,
  interpretarOrdenMp,
  montoParaMp,
  nuevoExternalPosId,
  nuevaReferenciaCobro,
  type ClienteMpQr,
  type EstadoCobroQr,
  type OrdenMp,
} from './mp-qr'

export interface CajaQr {
  id: number
  restauranteId: number
  nombre: string
  mpPosId: string
  mpStoreId: string | null
  externalPosId: string
  qrImagenUrl: string | null
  qrPlantillaUrl: string | null
  activo: boolean
}

export interface CobroQr {
  id: number
  restauranteId: number
  pedidoId: number
  cajaId: number
  monto: string
  externalReference: string
  mpOrderId: string | null
  estado: EstadoCobroQr
  mpStatus: string | null
  mpStatusDetail: string | null
  mpPaymentId: string | null
  montoPagado: string | null
  mensaje: string | null
  expiraAt: Date | null
  pagadoAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface PedidoCobrable {
  id: number
  restauranteId: number
  tipo: 'delivery' | 'takeaway' | 'mesa'
  sucursalId: number | null
  total: string
  pagado: boolean
  estado: string
}

export interface ConexionMp {
  /** El local tiene el módulo comercial "Mercado Pago". */
  moduloActivo: boolean
  conectado: boolean
  mpUserId: string | null
}

export type ReservaCobro =
  | { tipo: 'nuevo'; cobro: CobroQr }
  | { tipo: 'existente'; cobro: CobroQr }
  /** Otro pedido ocupa la caja, o este mismo pedido ya tiene un cobro activo en otra caja. */
  | { tipo: 'ocupada'; cobro: CobroQr }

export interface ConfirmacionPago {
  /** `false` si otro proceso ya lo había acreditado: no repetir efectos. */
  aplicado: boolean
  cobro: CobroQr
  pedido: PedidoCobrable | null
}

export interface DatosCajaGuardada {
  nombre: string
  mpPosId: string
  mpStoreId: string | null
  externalPosId: string
  qrImagenUrl: string | null
  qrPlantillaUrl: string | null
}

/**
 * Persistencia. Los métodos con efectos compuestos son atómicos a propósito:
 * `reservarCobro` serializa por pedido y por caja; `confirmarPago` pasa el cobro a `pagado`,
 * el pedido a pagado y registra el `pago` en una sola transacción.
 */
export interface RepositorioCobrosQr {
  conexion(restauranteId: number): Promise<ConexionMp>
  listarCajas(restauranteId: number): Promise<CajaQr[]>
  buscarCaja(restauranteId: number, cajaId: number): Promise<CajaQr | null>
  /** Inserta o reactiva por `(restaurante, mpPosId)`. */
  guardarCaja(restauranteId: number, datos: DatosCajaGuardada): Promise<CajaQr>
  desactivarCaja(restauranteId: number, cajaId: number): Promise<boolean>
  buscarPedido(restauranteId: number, pedidoId: number): Promise<PedidoCobrable | null>
  /**
   * Bajo lock de pedido y caja: descarta los `creando` sin orden más viejos que
   * `vigenciaCreandoMs`; si la caja tiene un cobro activo de otro pedido, o el pedido uno en otra
   * caja, devuelve `ocupada`; si ya hay uno de este pedido en esta caja, `existente`; si no, inserta
   * un `creando` con `referencia`.
   */
  reservarCobro(datos: {
    restauranteId: number
    pedidoId: number
    cajaId: number
    monto: string
    referencia: string
    ahora: Date
    vigenciaCreandoMs: number
  }): Promise<ReservaCobro>
  registrarOrden(cobroId: number, datos: { mpOrderId: string; mpStatus: string; expiraAt: Date; ahora: Date }): Promise<CobroQr | null>
  /** Actualiza sólo si el estado actual está en `desde`. Devuelve la fila resultante o `null` si no aplicó. */
  transicionar(
    cobroId: number,
    desde: readonly EstadoCobroQr[],
    cambios: { estado?: EstadoCobroQr; mpStatus?: string | null; mpStatusDetail?: string | null; mensaje?: string | null; ahora: Date },
  ): Promise<CobroQr | null>
  buscarCobro(cobroId: number): Promise<CobroQr | null>
  buscarCobroPorOrdenMp(mpOrderId: string): Promise<CobroQr | null>
  ultimoCobroDePedido(restauranteId: number, pedidoId: number): Promise<CobroQr | null>
  confirmarPago(datos: {
    cobroId: number
    paymentId: string | null
    montoPagado: string
    mpStatus: string
    mpStatusDetail: string | null
    ahora: Date
  }): Promise<ConfirmacionPago>
  /** Cancela el pedido sólo si sigue impago y abierto. Devuelve el pedido si esta llamada lo canceló. */
  cancelarPedidoImpago(restauranteId: number, pedidoId: number): Promise<PedidoCobrable | null>
}

/** Efectos posteriores al commit (puntos, difusión, impresión). Best-effort: nunca rompen el flujo. */
export interface EfectosCobrosQr {
  pagoConfirmado(pedido: PedidoCobrable): Promise<void>
  pedidoCancelado(pedido: PedidoCobrable): Promise<void>
}

// ───────────────────────────── Contratos de salida ─────────────────────────────

export type CodigoErrorPosQr =
  | 'MODULO_MP_INACTIVO'
  | 'MP_NO_CONECTADO'
  | 'CAJA_NO_ENCONTRADA'
  | 'CAJA_SIN_ID_EXTERNO'
  | 'TIENDA_INVALIDA'
  | 'PEDIDO_NO_ENCONTRADO'
  | 'PEDIDO_YA_PAGADO'
  | 'PEDIDO_NO_COBRABLE'
  | 'MONTO_INVALIDO'
  | 'CAJA_OCUPADA'
  | 'COBRO_EN_OTRA_CAJA'
  | 'MP_ERROR'

export type Resultado<T> =
  | { ok: true; data: T }
  | { ok: false; codigo: CodigoErrorPosQr; mensaje: string; status: number; reintentable?: boolean; datos?: Record<string, unknown> }

export interface CajaQrDto {
  id: number
  nombre: string
  externalPosId: string
  qrUrl: string | null
  plantillaUrl: string | null
}

export interface CobroQrDto {
  id: number
  pedidoId: number
  cajaId: number
  cajaNombre: string | null
  qrUrl: string | null
  monto: string
  estado: EstadoCobroQr
  mpStatus: string | null
  mensaje: string | null
  expiraAt: string | null
  pagadoAt: string | null
}

export interface CajaMpDto {
  mpPosId: string
  nombre: string
  externalId: string | null
  storeId: string | null
  qrUrl: string | null
  vinculada: boolean
}

export interface TiendaMpDto {
  id: string
  nombre: string
  direccion: string | null
}

export interface EstadoPosQrDto {
  moduloMercadoPago: boolean
  mpConectado: boolean
  cajas: CajaQrDto[]
}

export interface ResultadoCancelacionDto {
  cobro: CobroQrDto | null
  /** El pedido quedó cancelado por esta llamada. */
  pedidoCancelado: boolean
}

const fallo = (
  codigo: CodigoErrorPosQr,
  mensaje: string,
  status: number,
  extra: { reintentable?: boolean; datos?: Record<string, unknown> } = {},
): Resultado<never> => ({ ok: false, codigo, mensaje, status, ...extra })

const estaActivo = (cobro: CobroQr) => (ESTADOS_COBRO_ACTIVOS as readonly string[]).includes(cobro.estado)
const ESTADOS_PEDIDO_CERRADOS = ['cancelled', 'archived', 'delivered']
const recortar = (mensaje: string, max = 240) => (mensaje.length > max ? `${mensaje.slice(0, max - 1)}…` : mensaje)

export interface DependenciasCobrosQr {
  repo: RepositorioCobrosQr
  mp: ClienteMpQr
  efectos: EfectosCobrosQr
  ahora?: () => Date
  /** Mínimo entre dos consultas a Mercado Pago por el mismo cobro (el POS consulta cada pocos segundos). */
  consultaMinimaMs?: number
  /** Un `creando` sin orden más viejo que esto se da por fallido. */
  vigenciaCreandoMs?: number
  log?: (mensaje: string, detalle?: unknown) => void
}

export function crearServicioCobrosQr(deps: DependenciasCobrosQr) {
  const { repo, mp, efectos } = deps
  const ahora = deps.ahora ?? (() => new Date())
  const consultaMinimaMs = deps.consultaMinimaMs ?? 1_500
  const vigenciaCreandoMs = deps.vigenciaCreandoMs ?? 2 * 60_000
  const log = deps.log ?? ((mensaje, detalle) => console.error(`[pos-qr] ${mensaje}`, detalle ?? ''))
  const ultimaConsulta = new Map<number, number>()

  async function aDto(cobro: CobroQr, caja?: CajaQr | null): Promise<CobroQrDto> {
    const cajaCobro = caja !== undefined ? caja : await repo.buscarCaja(cobro.restauranteId, cobro.cajaId)
    return {
      id: cobro.id,
      pedidoId: cobro.pedidoId,
      cajaId: cobro.cajaId,
      cajaNombre: cajaCobro?.nombre ?? null,
      qrUrl: cajaCobro?.qrImagenUrl ?? null,
      monto: cobro.monto,
      estado: cobro.estado,
      mpStatus: cobro.mpStatus,
      mensaje: cobro.mensaje,
      expiraAt: cobro.expiraAt ? cobro.expiraAt.toISOString() : null,
      pagadoAt: cobro.pagadoAt ? cobro.pagadoAt.toISOString() : null,
    }
  }

  const aCajaDto = (caja: CajaQr): CajaQrDto => ({
    id: caja.id,
    nombre: caja.nombre,
    externalPosId: caja.externalPosId,
    qrUrl: caja.qrImagenUrl,
    plantillaUrl: caja.qrPlantillaUrl,
  })

  async function efectoSeguro(nombre: string, accion: () => Promise<void>) {
    try {
      await accion()
    } catch (error) {
      log(`Falló el efecto posterior "${nombre}"`, error)
    }
  }

  /** Aplica lo que dice Mercado Pago sobre la orden al cobro local. Idempotente. */
  async function aplicarOrden(cobro: CobroQr, orden: OrdenMp): Promise<CobroQr> {
    const montoCentavos = aCentavos(cobro.monto)
    if (montoCentavos === null) throw new Error(`Cobro ${cobro.id} con monto inválido`)
    const resultado = interpretarOrdenMp(orden, { montoCentavos, referencia: cobro.externalReference })
    const relee = async () => (await repo.buscarCobro(cobro.id)) ?? cobro

    if (cobro.estado === 'pagado') {
      // Sólo importa un reembolso posterior: queda registrado sin tocar el pedido.
      if (resultado.estado === 'reembolsado') {
        return (await repo.transicionar(cobro.id, ['pagado'], {
          estado: 'reembolsado', mpStatus: resultado.mpStatus, mpStatusDetail: resultado.mpStatusDetail,
          mensaje: 'Mercado Pago reembolsó este cobro', ahora: ahora(),
        })) ?? relee()
      }
      return cobro
    }
    if (!estaActivo(cobro)) return cobro

    switch (resultado.estado) {
      case 'creado': {
        if (resultado.mpStatus === cobro.mpStatus && resultado.mpStatusDetail === cobro.mpStatusDetail) return cobro
        return (await repo.transicionar(cobro.id, ESTADOS_COBRO_ACTIVOS, {
          mpStatus: resultado.mpStatus, mpStatusDetail: resultado.mpStatusDetail, ahora: ahora(),
        })) ?? relee()
      }
      case 'pagado': {
        const confirmacion = await repo.confirmarPago({
          cobroId: cobro.id,
          paymentId: resultado.paymentId,
          montoPagado: resultado.montoPagado,
          mpStatus: resultado.mpStatus,
          mpStatusDetail: resultado.mpStatusDetail,
          ahora: ahora(),
        })
        if (confirmacion.aplicado && confirmacion.pedido) {
          const pedido = confirmacion.pedido
          await efectoSeguro('pago confirmado', () => efectos.pagoConfirmado(pedido))
        }
        return confirmacion.cobro
      }
      case 'error':
        return (await repo.transicionar(cobro.id, ESTADOS_COBRO_ACTIVOS, {
          estado: 'error', mpStatus: resultado.mpStatus, mpStatusDetail: resultado.mpStatusDetail,
          mensaje: recortar(resultado.mensaje), ahora: ahora(),
        })) ?? relee()
      default: {
        const mensaje = resultado.estado === 'vencido' ? 'El cobro venció sin pagarse' : null
        return (await repo.transicionar(cobro.id, ESTADOS_COBRO_ACTIVOS, {
          estado: resultado.estado, mpStatus: resultado.mpStatus, mpStatusDetail: resultado.mpStatusDetail,
          mensaje, ahora: ahora(),
        })) ?? relee()
      }
    }
  }

  /** Consulta a Mercado Pago y aplica el resultado. Un fallo de comunicación deja el cobro como estaba. */
  async function sincronizar(cobro: CobroQr, { forzar = false }: { forzar?: boolean } = {}): Promise<CobroQr> {
    if (!estaActivo(cobro)) {
      ultimaConsulta.delete(cobro.id)
      return cobro
    }
    if (!cobro.mpOrderId) {
      if (ahora().getTime() - cobro.createdAt.getTime() > vigenciaCreandoMs) {
        return (await repo.transicionar(cobro.id, ['creando'], {
          estado: 'error', mensaje: 'No se llegó a crear la orden en Mercado Pago', ahora: ahora(),
        })) ?? (await repo.buscarCobro(cobro.id)) ?? cobro
      }
      return cobro
    }
    const ahoraMs = ahora().getTime()
    if (!forzar && ahoraMs - (ultimaConsulta.get(cobro.id) ?? 0) < consultaMinimaMs) return cobro
    ultimaConsulta.set(cobro.id, ahoraMs)
    try {
      return await aplicarOrden(cobro, await mp.obtenerOrden(cobro.restauranteId, cobro.mpOrderId))
    } catch (error) {
      if (error instanceof MpError) {
        log(`No se pudo consultar la orden ${cobro.mpOrderId}`, error.message)
        return cobro
      }
      throw error
    }
  }

  const errorDeMp = (error: MpError): Resultado<never> => {
    if (error.status === 401 || error.status === 403 || error.code === 'mp_no_conectado') {
      return fallo('MP_NO_CONECTADO', 'Mercado Pago rechazó la conexión. Volvé a conectar tu cuenta en Ajustes → Métodos de pago.', 409)
    }
    return fallo('MP_ERROR', error.red || error.status >= 500
      ? 'No pudimos comunicarnos con Mercado Pago. Reintentá en unos segundos.'
      : recortar(error.message), 502, { reintentable: error.red || error.status >= 500 })
  }

  const ocupada = (cobro: CobroQr, pedidoId: number): Resultado<never> =>
    cobro.pedidoId === pedidoId
      ? fallo('COBRO_EN_OTRA_CAJA', 'Este pedido ya tiene un cobro pendiente en otra caja. Cancelalo antes de cobrar en esta.', 409, { datos: { cajaId: cobro.cajaId } })
      : fallo('CAJA_OCUPADA', `La caja está cobrando el pedido #${cobro.pedidoId}. Esperá a que termine o cancelá ese cobro.`, 409, { datos: { pedidoId: cobro.pedidoId } })

  return {
    async estado(restauranteId: number): Promise<EstadoPosQrDto> {
      const conexion = await repo.conexion(restauranteId)
      const cajas = conexion.moduloActivo ? await repo.listarCajas(restauranteId) : []
      return { moduloMercadoPago: conexion.moduloActivo, mpConectado: conexion.conectado, cajas: cajas.map(aCajaDto) }
    },

    // ── Administración de cajas ──

    async listarCajasMp(restauranteId: number): Promise<Resultado<CajaMpDto[]>> {
      const conexion = await repo.conexion(restauranteId)
      if (!conexion.moduloActivo) return fallo('MODULO_MP_INACTIVO', 'Activá el módulo Mercado Pago para cobrar con QR', 403)
      if (!conexion.conectado) return fallo('MP_NO_CONECTADO', 'Conectá tu cuenta de Mercado Pago en Ajustes → Métodos de pago', 409)
      try {
        const [remotas, vinculadas] = await Promise.all([mp.listarCajas(restauranteId), repo.listarCajas(restauranteId)])
        const yaVinculadas = new Set(vinculadas.map((c) => c.mpPosId))
        return {
          ok: true,
          data: remotas.map((c) => ({
            mpPosId: c.id, nombre: c.nombre, externalId: c.externalId, storeId: c.storeId, qrUrl: c.qrImagen,
            vinculada: yaVinculadas.has(c.id),
          })),
        }
      } catch (error) {
        if (error instanceof MpError) return errorDeMp(error)
        throw error
      }
    },

    async listarTiendasMp(restauranteId: number): Promise<Resultado<TiendaMpDto[]>> {
      const conexion = await repo.conexion(restauranteId)
      if (!conexion.moduloActivo) return fallo('MODULO_MP_INACTIVO', 'Activá el módulo Mercado Pago para cobrar con QR', 403)
      if (!conexion.conectado || !conexion.mpUserId) return fallo('MP_NO_CONECTADO', 'Conectá tu cuenta de Mercado Pago en Ajustes → Métodos de pago', 409)
      try {
        const tiendas = await mp.listarTiendas(restauranteId, conexion.mpUserId)
        return { ok: true, data: tiendas.map((t) => ({ id: t.id, nombre: t.nombre, direccion: t.direccion })) }
      } catch (error) {
        if (error instanceof MpError) return errorDeMp(error)
        throw error
      }
    },

    /** Vincula una caja que el vendedor ya tiene en Mercado Pago (debe traer `external_id`). */
    async vincularCaja(restauranteId: number, mpPosId: string): Promise<Resultado<CajaQrDto>> {
      const conexion = await repo.conexion(restauranteId)
      if (!conexion.moduloActivo) return fallo('MODULO_MP_INACTIVO', 'Activá el módulo Mercado Pago para cobrar con QR', 403)
      if (!conexion.conectado) return fallo('MP_NO_CONECTADO', 'Conectá tu cuenta de Mercado Pago en Ajustes → Métodos de pago', 409)
      try {
        const remota = await mp.obtenerCaja(restauranteId, mpPosId)
        if (!remota) return fallo('CAJA_NO_ENCONTRADA', 'Esa caja no existe en tu cuenta de Mercado Pago', 404)
        if (!remota.externalId) {
          return fallo('CAJA_SIN_ID_EXTERNO', 'Esa caja no tiene un ID externo, que Mercado Pago exige para cobrar por API. Creá una caja nueva desde acá.', 422)
        }
        const caja = await repo.guardarCaja(restauranteId, {
          nombre: recortar(remota.nombre, 120), mpPosId: remota.id, mpStoreId: remota.storeId,
          externalPosId: remota.externalId, qrImagenUrl: remota.qrImagen, qrPlantillaUrl: remota.qrPlantilla,
        })
        return { ok: true, data: aCajaDto(caja) }
      } catch (error) {
        if (error instanceof MpError) return errorDeMp(error)
        throw error
      }
    },

    /** Crea una caja nueva sobre una tienda real del vendedor. Nunca crea ni inventa la tienda. */
    async crearCajaNueva(restauranteId: number, entrada: { nombre: string; tiendaId: string }): Promise<Resultado<CajaQrDto>> {
      const conexion = await repo.conexion(restauranteId)
      if (!conexion.moduloActivo) return fallo('MODULO_MP_INACTIVO', 'Activá el módulo Mercado Pago para cobrar con QR', 403)
      if (!conexion.conectado || !conexion.mpUserId) return fallo('MP_NO_CONECTADO', 'Conectá tu cuenta de Mercado Pago en Ajustes → Métodos de pago', 409)
      try {
        const tiendas = await mp.listarTiendas(restauranteId, conexion.mpUserId)
        const tienda = tiendas.find((t) => t.id === entrada.tiendaId)
        if (!tienda) return fallo('TIENDA_INVALIDA', 'Esa tienda no existe en tu cuenta de Mercado Pago', 422)
        let creada = await mp.crearCaja(restauranteId, {
          nombre: entrada.nombre, tiendaId: tienda.id, tiendaExternalId: tienda.externalId,
          externalPosId: nuevoExternalPosId(restauranteId),
        })
        if (!creada.qrImagen) creada = (await mp.obtenerCaja(restauranteId, creada.id)) ?? creada
        if (!creada.externalId) return fallo('MP_ERROR', 'Mercado Pago creó la caja sin ID externo', 502)
        const caja = await repo.guardarCaja(restauranteId, {
          nombre: recortar(creada.nombre, 120), mpPosId: creada.id, mpStoreId: creada.storeId ?? tienda.id,
          externalPosId: creada.externalId, qrImagenUrl: creada.qrImagen, qrPlantillaUrl: creada.qrPlantilla,
        })
        return { ok: true, data: aCajaDto(caja) }
      } catch (error) {
        if (error instanceof MpError) return errorDeMp(error)
        throw error
      }
    },

    async desvincularCaja(restauranteId: number, cajaId: number): Promise<Resultado<{ desvinculada: true }>> {
      const desactivada = await repo.desactivarCaja(restauranteId, cajaId)
      if (!desactivada) return fallo('CAJA_NO_ENCONTRADA', 'La caja no está vinculada', 404)
      return { ok: true, data: { desvinculada: true } }
    },

    // ── Cobro de un pedido ──

    /** Crea (o retoma) el cobro QR de un pedido en la caja indicada. Idempotente por pedido y caja. */
    async iniciarCobro(entrada: { restauranteId: number; pedidoId: number; cajaId: number }): Promise<Resultado<CobroQrDto>> {
      const { restauranteId, pedidoId, cajaId } = entrada
      const conexion = await repo.conexion(restauranteId)
      if (!conexion.moduloActivo) return fallo('MODULO_MP_INACTIVO', 'Activá el módulo Mercado Pago para cobrar con QR', 403)
      if (!conexion.conectado) return fallo('MP_NO_CONECTADO', 'Conectá tu cuenta de Mercado Pago en Ajustes → Métodos de pago', 409)

      const caja = await repo.buscarCaja(restauranteId, cajaId)
      if (!caja || !caja.activo) {
        return fallo('CAJA_NO_ENCONTRADA', 'La caja de Mercado Pago ya no está vinculada. Elegí otra en la configuración del POS.', 404)
      }
      const pedido = await repo.buscarPedido(restauranteId, pedidoId)
      if (!pedido) return fallo('PEDIDO_NO_ENCONTRADO', 'Pedido no encontrado', 404)
      if (pedido.pagado) return fallo('PEDIDO_YA_PAGADO', 'El pedido ya figura como pagado', 409)
      if (ESTADOS_PEDIDO_CERRADOS.includes(pedido.estado)) return fallo('PEDIDO_NO_COBRABLE', 'El pedido ya no admite cobro', 409)
      const monto = montoParaMp(pedido.total)
      if (!monto) return fallo('MONTO_INVALIDO', 'El pedido no tiene un importe a cobrar', 422)

      const reservar = () => repo.reservarCobro({
        restauranteId, pedidoId, cajaId, monto, referencia: nuevaReferenciaCobro(restauranteId, pedidoId),
        ahora: ahora(), vigenciaCreandoMs,
      })
      let reserva = await reservar()
      if (reserva.tipo === 'ocupada') {
        // Quizá quien la ocupaba ya pagó, venció o se canceló en Mercado Pago sin que lo supiéramos.
        const actualizado = await sincronizar(reserva.cobro, { forzar: true })
        if (estaActivo(actualizado)) return ocupada(actualizado, pedidoId)
        reserva = await reservar()
        if (reserva.tipo === 'ocupada') return ocupada(reserva.cobro, pedidoId)
      }

      let cobro = reserva.cobro
      if (cobro.mpOrderId) return { ok: true, data: await aDto(await sincronizar(cobro), caja) }

      // Cobro nuevo o retomado tras un corte: la referencia es la clave de idempotencia, así que
      // repetir el alta devuelve la misma orden en lugar de una segunda.
      try {
        const orden = await mp.crearOrdenQr(restauranteId, {
          monto: montoParaMp(cobro.monto) ?? monto,
          referencia: cobro.externalReference,
          externalPosId: caja.externalPosId,
          descripcion: `Pedido #${pedidoId}`,
        })
        const registrado = await repo.registrarOrden(cobro.id, {
          mpOrderId: orden.id,
          mpStatus: orden.status,
          expiraAt: new Date(ahora().getTime() + EXPIRACION_COBRO_MINUTOS * 60_000),
          ahora: ahora(),
        })
        cobro = registrado ?? (await repo.buscarCobro(cobro.id)) ?? cobro
        cobro = await aplicarOrden(cobro, orden)
        return { ok: true, data: await aDto(cobro, caja) }
      } catch (error) {
        if (!(error instanceof MpError)) throw error
        // Un corte de red o un 5xx no dicen si Mercado Pago creó la orden: el cobro queda en
        // `creando` para retomarlo con la misma clave. Un 4xx sí es un rechazo definitivo.
        const ambiguo = error.red || error.status >= 500
        if (!ambiguo) {
          await repo.transicionar(cobro.id, ['creando'], {
            estado: 'error',
            mensaje: error.cajaOcupada ? 'La caja tiene una orden pendiente en Mercado Pago' : recortar(error.message),
            ahora: ahora(),
          })
        }
        if (error.cajaOcupada) {
          return fallo('CAJA_OCUPADA', 'La caja tiene un cobro pendiente en Mercado Pago. Esperá unos minutos a que venza o cancelalo desde la app de Mercado Pago.', 409)
        }
        return errorDeMp(error)
      }
    },

    /** Último cobro del pedido, sincronizado con Mercado Pago si sigue pendiente. */
    async consultarCobro(restauranteId: number, pedidoId: number): Promise<CobroQrDto | null> {
      const cobro = await repo.ultimoCobroDePedido(restauranteId, pedidoId)
      if (!cobro) return null
      return aDto(await sincronizar(cobro))
    },

    /**
     * Cancela el cobro activo del pedido (en Mercado Pago y localmente) y, si se pide, el pedido
     * impago. Si el cliente alcanzó a pagar, el cobro queda `pagado` y el pedido no se cancela.
     */
    async cancelarCobro(entrada: { restauranteId: number; pedidoId: number; cancelarPedido: boolean }): Promise<Resultado<ResultadoCancelacionDto>> {
      const { restauranteId, pedidoId, cancelarPedido } = entrada
      const cobro = await repo.ultimoCobroDePedido(restauranteId, pedidoId)
      let final: CobroQr | null = cobro

      if (cobro && estaActivo(cobro)) {
        if (!cobro.mpOrderId) {
          final = (await repo.transicionar(cobro.id, ['creando'], {
            estado: 'cancelado', mensaje: 'Cancelado antes de crearse la orden', ahora: ahora(),
          })) ?? (await repo.buscarCobro(cobro.id)) ?? cobro
        } else {
          try {
            final = await aplicarOrden(cobro, await mp.cancelarOrden(restauranteId, cobro.mpOrderId))
          } catch (error) {
            if (!(error instanceof MpError)) throw error
            // No se pudo cancelar: puede que el cliente acabe de pagar o que ya haya vencido.
            try {
              final = await aplicarOrden(cobro, await mp.obtenerOrden(restauranteId, cobro.mpOrderId))
            } catch (segundo) {
              if (segundo instanceof MpError) return errorDeMp(segundo)
              throw segundo
            }
            if (final && estaActivo(final)) return errorDeMp(error)
          }
          if (final && estaActivo(final)) {
            return fallo('MP_ERROR', 'Mercado Pago no confirmó la cancelación. Reintentá.', 502, { reintentable: true })
          }
        }
      }

      if (final?.estado === 'pagado') {
        return { ok: true, data: { cobro: await aDto(final), pedidoCancelado: false } }
      }

      let pedidoCancelado = false
      if (cancelarPedido) {
        const pedido = await repo.cancelarPedidoImpago(restauranteId, pedidoId)
        if (pedido) {
          pedidoCancelado = true
          await efectoSeguro('pedido cancelado', () => efectos.pedidoCancelado(pedido))
        }
      }
      return { ok: true, data: { cobro: final ? await aDto(final) : null, pedidoCancelado } }
    },

    /** Webhook `orders`: no confía en el payload, sólo en la orden que devuelve Mercado Pago. */
    async procesarNotificacionOrden(mpOrderId: string): Promise<'ignorado' | 'sin_cambios' | 'error' | EstadoCobroQr> {
      const cobro = await repo.buscarCobroPorOrdenMp(mpOrderId)
      if (!cobro) return 'ignorado'
      // Los terminales (salvo `pagado`, por si llega un reembolso) no cambian.
      if (!estaActivo(cobro) && cobro.estado !== 'pagado') return 'sin_cambios'
      try {
        const orden = await mp.obtenerOrden(cobro.restauranteId, mpOrderId)
        return (await aplicarOrden(cobro, orden)).estado
      } catch (error) {
        if (error instanceof MpError) {
          log(`Webhook: no se pudo leer la orden ${mpOrderId}`, error.message)
          return 'error'
        }
        throw error
      }
    },
  }
}

export type ServicioCobrosQr = ReturnType<typeof crearServicioCobrosQr>
