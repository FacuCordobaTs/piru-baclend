/**
 * Implementación MySQL/Drizzle de `RepositorioCobrosQr` y de los efectos posteriores al pago.
 *
 * Reglas de este archivo:
 * - Orden de locks SIEMPRE pedido → caja → cobro. Cualquier transacción que toque más de una de
 *   estas filas las toma en ese orden; así `reservarCobro` y `confirmarPago` no se traban entre sí.
 * - Nunca se comparan instantes en SQL (`NOW()`, `CURRENT_TIMESTAMP`): la sesión MySQL y Drizzle
 *   no comparten zona horaria. Se leen las filas y se comparan en JS con fechas que escribió la app.
 * - Las escrituras que dependen del estado previo releen bajo lock en lugar de confiar en
 *   `affectedRows`, cuyo significado depende de las flags de la conexión.
 */
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import {
  mpCajaQr as CajaTable,
  mpConexionQr as ConexionTable,
  pago as PagoTable,
  pedidoUnificado as PedidoTable,
  posCobroQr as CobroTable,
} from '../db/schema'
import { MODULE_KEYS, tieneModuloActivo } from './modulos'
import { ESTADOS_COBRO_ACTIVOS, type EstadoCobroQr } from './mp-qr'
import { acreditarPuntosPedidoAprobado, revertirPuntosPedidoCancelado } from './puntos'
import { emitirEventoPedido } from './pedidos-activos'
import type {
  CajaQr,
  CobroQr,
  EfectosCobrosQr,
  PedidoCobrable,
  RepositorioCobrosQr,
} from './pos-cobros-qr'

const ESTADOS_PEDIDO_CERRADOS = ['cancelled', 'archived', 'delivered']

const aCaja = (fila: typeof CajaTable.$inferSelect): CajaQr => ({
  id: fila.id,
  restauranteId: fila.restauranteId,
  nombre: fila.nombre,
  mpPosId: fila.mpPosId,
  mpStoreId: fila.mpStoreId,
  externalPosId: fila.externalPosId,
  qrImagenUrl: fila.qrImagenUrl,
  qrPlantillaUrl: fila.qrPlantillaUrl,
  activo: fila.activo,
})

const aCobro = (fila: typeof CobroTable.$inferSelect): CobroQr => ({
  id: fila.id,
  restauranteId: fila.restauranteId,
  pedidoId: fila.pedidoId,
  cajaId: fila.cajaId,
  monto: fila.monto,
  externalReference: fila.externalReference,
  mpOrderId: fila.mpOrderId,
  estado: fila.estado as EstadoCobroQr,
  mpStatus: fila.mpStatus,
  mpStatusDetail: fila.mpStatusDetail,
  mpPaymentId: fila.mpPaymentId,
  montoPagado: fila.montoPagado,
  mensaje: fila.mensaje,
  expiraAt: fila.expiraAt,
  pagadoAt: fila.pagadoAt,
  createdAt: fila.createdAt,
  updatedAt: fila.updatedAt,
})

const aPedido = (fila: {
  id: number
  restauranteId: number
  tipo: 'delivery' | 'takeaway' | 'mesa'
  sucursalId: number | null
  total: string
  pagado: boolean
  estado: string
}): PedidoCobrable => ({
  id: fila.id,
  restauranteId: fila.restauranteId,
  tipo: fila.tipo,
  sucursalId: fila.sucursalId,
  total: fila.total,
  pagado: fila.pagado,
  estado: fila.estado,
})

const PROYECCION_PEDIDO = {
  id: PedidoTable.id,
  restauranteId: PedidoTable.restauranteId,
  tipo: PedidoTable.tipo,
  sucursalId: PedidoTable.sucursalId,
  total: PedidoTable.total,
  pagado: PedidoTable.pagado,
  estado: PedidoTable.estado,
} as const

const esClaveDuplicada = (error: unknown) => (error as { code?: string } | null)?.code === 'ER_DUP_ENTRY'

export function crearRepositorioCobrosQr(db: any): RepositorioCobrosQr {
  const leerCobro = async (ejecutor: any, cobroId: number) => {
    const [fila] = await ejecutor.select().from(CobroTable).where(eq(CobroTable.id, cobroId)).limit(1)
    return fila ? aCobro(fila) : null
  }

  return {
    async conexion(restauranteId) {
      // Conexión con la aplicación de Mercado Pago para QR (`mp_conexion_qr`), no la de pagos online.
      const [fila] = await db
        .select({ conectado: ConexionTable.conectado, token: ConexionTable.accessToken, mpUserId: ConexionTable.mpUserId })
        .from(ConexionTable)
        .where(eq(ConexionTable.restauranteId, restauranteId))
        .limit(1)
      return {
        moduloActivo: await tieneModuloActivo(db, restauranteId, MODULE_KEYS.MERCADOPAGO),
        // Sólo un booleano: el token no sale de esta capa.
        conectado: !!(fila?.conectado && fila.token),
        mpUserId: fila?.mpUserId ?? null,
      }
    },

    async listarCajas(restauranteId) {
      const filas = await db
        .select()
        .from(CajaTable)
        .where(and(eq(CajaTable.restauranteId, restauranteId), eq(CajaTable.activo, true)))
        .orderBy(CajaTable.id)
      return filas.map(aCaja)
    },

    async buscarCaja(restauranteId, cajaId) {
      const [fila] = await db
        .select()
        .from(CajaTable)
        .where(and(eq(CajaTable.id, cajaId), eq(CajaTable.restauranteId, restauranteId)))
        .limit(1)
      return fila ? aCaja(fila) : null
    },

    async guardarCaja(restauranteId, datos) {
      const actualizar = async () => {
        await db
          .update(CajaTable)
          .set({
            nombre: datos.nombre,
            mpStoreId: datos.mpStoreId,
            externalPosId: datos.externalPosId,
            qrImagenUrl: datos.qrImagenUrl,
            qrPlantillaUrl: datos.qrPlantillaUrl,
            activo: true,
          })
          .where(and(eq(CajaTable.restauranteId, restauranteId), eq(CajaTable.mpPosId, datos.mpPosId)))
        const [fila] = await db
          .select()
          .from(CajaTable)
          .where(and(eq(CajaTable.restauranteId, restauranteId), eq(CajaTable.mpPosId, datos.mpPosId)))
          .limit(1)
        return aCaja(fila)
      }

      const [existente] = await db
        .select({ id: CajaTable.id })
        .from(CajaTable)
        .where(and(eq(CajaTable.restauranteId, restauranteId), eq(CajaTable.mpPosId, datos.mpPosId)))
        .limit(1)
      if (existente) return actualizar()
      try {
        await db.insert(CajaTable).values({ restauranteId, activo: true, ...datos })
      } catch (error) {
        // Dos altas simultáneas de la misma caja: la segunda sólo actualiza.
        if (!esClaveDuplicada(error)) throw error
      }
      return actualizar()
    },

    async desactivarCaja(restauranteId, cajaId) {
      const [previa] = await db
        .select({ id: CajaTable.id })
        .from(CajaTable)
        .where(and(eq(CajaTable.id, cajaId), eq(CajaTable.restauranteId, restauranteId), eq(CajaTable.activo, true)))
        .limit(1)
      if (!previa) return false
      await db.update(CajaTable).set({ activo: false }).where(and(eq(CajaTable.id, cajaId), eq(CajaTable.restauranteId, restauranteId)))
      return true
    },

    async buscarPedido(restauranteId, pedidoId) {
      const [fila] = await db
        .select(PROYECCION_PEDIDO)
        .from(PedidoTable)
        .where(and(eq(PedidoTable.id, pedidoId), eq(PedidoTable.restauranteId, restauranteId)))
        .limit(1)
      return fila ? aPedido(fila) : null
    },

    async reservarCobro(datos) {
      const { restauranteId, pedidoId, cajaId } = datos
      return db.transaction(async (tx: any) => {
        await tx.execute(sql`SELECT id FROM pedido_unificado WHERE id = ${pedidoId} AND restaurante_id = ${restauranteId} FOR UPDATE`)
        await tx.execute(sql`SELECT id FROM mp_caja_qr WHERE id = ${cajaId} AND restaurante_id = ${restauranteId} FOR UPDATE`)

        const activos: CobroQr[] = (await tx
          .select()
          .from(CobroTable)
          .where(and(
            eq(CobroTable.restauranteId, restauranteId),
            or(eq(CobroTable.cajaId, cajaId), eq(CobroTable.pedidoId, pedidoId)),
            inArray(CobroTable.estado, [...ESTADOS_COBRO_ACTIVOS]),
          ))).map(aCobro)

        // Un `creando` sin orden que nunca avanzó ya no puede estar en Mercado Pago con certeza
        // y no debe bloquear la caja para siempre.
        const vigentes: CobroQr[] = []
        for (const cobro of activos) {
          const abandonado = cobro.estado === 'creando' && !cobro.mpOrderId
            && datos.ahora.getTime() - cobro.createdAt.getTime() > datos.vigenciaCreandoMs
          if (abandonado) {
            await tx.update(CobroTable)
              .set({ estado: 'error', mensaje: 'No se llegó a crear la orden en Mercado Pago', updatedAt: datos.ahora })
              .where(eq(CobroTable.id, cobro.id))
          } else {
            vigentes.push(cobro)
          }
        }

        const deOtroPedido = vigentes.find((c) => c.cajaId === cajaId && c.pedidoId !== pedidoId)
        if (deOtroPedido) return { tipo: 'ocupada' as const, cobro: deOtroPedido }
        const enOtraCaja = vigentes.find((c) => c.pedidoId === pedidoId && c.cajaId !== cajaId)
        if (enOtraCaja) return { tipo: 'ocupada' as const, cobro: enOtraCaja }
        const propio = vigentes.find((c) => c.pedidoId === pedidoId && c.cajaId === cajaId)
        if (propio) return { tipo: 'existente' as const, cobro: propio }

        const insertado = await tx.insert(CobroTable).values({
          restauranteId,
          pedidoId,
          cajaId,
          monto: datos.monto,
          externalReference: datos.referencia,
          estado: 'creando',
          createdAt: datos.ahora,
          updatedAt: datos.ahora,
        })
        const cobro = await leerCobro(tx, Number(insertado[0].insertId))
        return { tipo: 'nuevo' as const, cobro: cobro! }
      })
    },

    async registrarOrden(cobroId, datos) {
      return db.transaction(async (tx: any) => {
        await tx.execute(sql`SELECT id FROM pos_cobro_qr WHERE id = ${cobroId} FOR UPDATE`)
        const actual = await leerCobro(tx, cobroId)
        if (!actual || actual.estado !== 'creando') return null
        await tx.update(CobroTable)
          .set({ mpOrderId: datos.mpOrderId, mpStatus: datos.mpStatus, estado: 'creado', expiraAt: datos.expiraAt, updatedAt: datos.ahora })
          .where(eq(CobroTable.id, cobroId))
        return leerCobro(tx, cobroId)
      })
    },

    async transicionar(cobroId, desde, cambios) {
      return db.transaction(async (tx: any) => {
        await tx.execute(sql`SELECT id FROM pos_cobro_qr WHERE id = ${cobroId} FOR UPDATE`)
        const actual = await leerCobro(tx, cobroId)
        if (!actual || !desde.includes(actual.estado)) return null
        const { ahora, ...resto } = cambios
        await tx.update(CobroTable).set({ ...resto, updatedAt: ahora }).where(eq(CobroTable.id, cobroId))
        return leerCobro(tx, cobroId)
      })
    },

    buscarCobro: (cobroId) => leerCobro(db, cobroId),

    async buscarCobroPorOrdenMp(mpOrderId) {
      const [fila] = await db.select().from(CobroTable).where(eq(CobroTable.mpOrderId, mpOrderId)).limit(1)
      return fila ? aCobro(fila) : null
    },

    async ultimoCobroDePedido(restauranteId, pedidoId) {
      const [fila] = await db
        .select()
        .from(CobroTable)
        .where(and(eq(CobroTable.pedidoId, pedidoId), eq(CobroTable.restauranteId, restauranteId)))
        .orderBy(desc(CobroTable.id))
        .limit(1)
      return fila ? aCobro(fila) : null
    },

    async confirmarPago(datos) {
      return db.transaction(async (tx: any) => {
        const previo = await leerCobro(tx, datos.cobroId)
        if (!previo) throw new Error(`Cobro QR ${datos.cobroId} inexistente`)
        // Mismo orden que `reservarCobro`: primero el pedido, después el cobro.
        await tx.execute(sql`SELECT id FROM pedido_unificado WHERE id = ${previo.pedidoId} FOR UPDATE`)
        await tx.execute(sql`SELECT id FROM pos_cobro_qr WHERE id = ${datos.cobroId} FOR UPDATE`)
        const cobro = (await leerCobro(tx, datos.cobroId))!
        if (!(ESTADOS_COBRO_ACTIVOS as readonly string[]).includes(cobro.estado)) {
          return { aplicado: false, cobro, pedido: null }
        }

        const [pedidoFila] = await tx.select(PROYECCION_PEDIDO).from(PedidoTable).where(eq(PedidoTable.id, cobro.pedidoId)).limit(1)
        await tx.update(CobroTable).set({
          estado: 'pagado',
          mpPaymentId: datos.paymentId,
          montoPagado: datos.montoPagado,
          mpStatus: datos.mpStatus,
          mpStatusDetail: datos.mpStatusDetail,
          mensaje: null,
          pagadoAt: datos.ahora,
          updatedAt: datos.ahora,
        }).where(eq(CobroTable.id, cobro.id))

        if (pedidoFila && !pedidoFila.pagado) {
          await tx.update(PedidoTable).set({ pagado: true, metodoPago: 'mercadopago' }).where(eq(PedidoTable.id, pedidoFila.id))
        }
        if (pedidoFila) {
          await tx.insert(PagoTable).values({
            pedidoUnificadoId: pedidoFila.id,
            metodo: 'mercadopago',
            estado: 'paid',
            monto: datos.montoPagado,
            mpPaymentId: datos.paymentId,
          })
        }

        const pedido = pedidoFila ? aPedido({ ...pedidoFila, pagado: true }) : null
        return { aplicado: true, cobro: (await leerCobro(tx, cobro.id))!, pedido }
      })
    },

    async cancelarPedidoImpago(restauranteId, pedidoId) {
      return db.transaction(async (tx: any) => {
        await tx.execute(sql`SELECT id FROM pedido_unificado WHERE id = ${pedidoId} AND restaurante_id = ${restauranteId} FOR UPDATE`)
        const [fila] = await tx
          .select(PROYECCION_PEDIDO)
          .from(PedidoTable)
          .where(and(eq(PedidoTable.id, pedidoId), eq(PedidoTable.restauranteId, restauranteId)))
          .limit(1)
        if (!fila || fila.pagado || ESTADOS_PEDIDO_CERRADOS.includes(fila.estado)) return null
        await tx.update(PedidoTable).set({ estado: 'cancelled' }).where(eq(PedidoTable.id, pedidoId))
        return aPedido({ ...fila, estado: 'cancelled' })
      })
    },
  }
}

/**
 * Efectos posteriores al commit. Igual que el webhook de pagos de pedidos: acredita puntos y
 * difunde el cambio pidiendo imprimir la comanda (que el POS difirió hasta que el pedido esté pago).
 */
export function crearEfectosCobrosQr(db: any): EfectosCobrosQr {
  return {
    async pagoConfirmado(pedido) {
      void acreditarPuntosPedidoAprobado(db, pedido.id).catch((error) =>
        console.error('Error acreditando puntos tras un cobro QR:', error),
      )
      await emitirEventoPedido(db, {
        restauranteId: pedido.restauranteId,
        pedidoId: pedido.id,
        tipo: pedido.tipo,
        sucursalId: pedido.sucursalId,
        event: 'upsert',
        reason: 'paid',
        shouldPrint: true,
      })
    },

    async pedidoCancelado(pedido) {
      await emitirEventoPedido(db, {
        restauranteId: pedido.restauranteId,
        pedidoId: pedido.id,
        tipo: pedido.tipo,
        sucursalId: pedido.sucursalId,
        event: 'upsert',
        reason: 'estado',
      })
      void revertirPuntosPedidoCancelado(db, pedido.id).catch((error) =>
        console.error('Error revirtiendo puntos al cancelar un cobro QR:', error),
      )
    },
  }
}
