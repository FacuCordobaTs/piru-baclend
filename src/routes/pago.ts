// src/routes/pago.ts
// Página de pago por link: SIN autenticación. El token (creado autenticado, enviado por WhatsApp
// al dueño) es la única autorización de ese pago único. Sirve para pagar desde el celular sin
// loguearse. Un mismo token puede ser de DOS cosas (comparten espacio de tokens):
//   • recarga de mensajes  → `recarga_mensajes.token`   (webhook `piru-recarga-{id}`)
//   • factura de suscripción → `pago_suscripcion.token`  (webhook `piru-suscripcion-{id}`)
// Por ahora sólo MercadoPago como medio de pago. El efecto (acreditar saldo / activar suscripción)
// lo aplica el webhook de MP, idéntico al checkout autenticado.
import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { eq } from 'drizzle-orm'
import { pool } from '../db'
import {
  restaurante as RestauranteTable,
  packRecarga as PackRecargaTable,
  recargaMensajes as RecargaMensajesTable,
  pagoSuscripcionItem as PagoSuscripcionItemTable,
} from '../db/schema'
import { getRecargaPorToken, setRecargaPreferencia, listarPacks, getPack } from '../lib/mensajes-wallet'
import { crearPreferenciaRecargaMP, pagosRecargaDisponibles } from '../lib/mp-recarga'
import { getPagoSuscripcionPorToken, setPagoSuscripcionPreferencia } from '../lib/suscripciones'
import { crearPreferenciaSuscripcionMP } from '../lib/mp-suscripcion'

const ADMIN_URL = (process.env.ADMIN_URL || 'https://admin.piru.app').replace(/\/$/, '')

const pagoRoute = new Hono()

type EstadoLink = 'pending' | 'paid' | 'expired'

/** Etiqueta legible del tipo de mensaje que recarga el pack. */
function unidad(categoria: string): string {
  return categoria === 'marketing' ? 'mensajes de campaña' : 'avisos por WhatsApp'
}

function resolverEstado(estadoPago: string, tokenExpiraEn: Date | string | null): EstadoLink {
  if (estadoPago === 'paid') return 'paid'
  const vencido = tokenExpiraEn ? new Date(tokenExpiraEn) < new Date() : false
  return vencido ? 'expired' : 'pending'
}

async function nombreRestaurante(db: ReturnType<typeof drizzle>, restauranteId: number): Promise<string> {
  const [rest] = await db
    .select({ nombre: RestauranteTable.nombre })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)
  return rest?.nombre ?? 'El local'
}

type LinkResuelto =
  | {
      tipo: 'recarga'
      recarga: NonNullable<Awaited<ReturnType<typeof getRecargaPorToken>>>
      restauranteNombre: string
      packNombre: string | null
      estado: EstadoLink
    }
  | {
      tipo: 'suscripcion'
      pago: NonNullable<Awaited<ReturnType<typeof getPagoSuscripcionPorToken>>>
      restauranteNombre: string
      concepto: string
      estado: EstadoLink
    }

/**
 * Resuelve un token contra ambos tipos de pago (recarga primero, luego suscripción) y trae los
 * datos para mostrar + el estado. Devuelve null si el token no existe en ninguna tabla.
 */
async function cargarLink(db: ReturnType<typeof drizzle>, token: string): Promise<LinkResuelto | null> {
  const recarga = await getRecargaPorToken(db, token)
  if (recarga) {
    let packNombre: string | null = null
    if (recarga.packRecargaId) {
      const [pack] = await db
        .select({ nombre: PackRecargaTable.nombre })
        .from(PackRecargaTable)
        .where(eq(PackRecargaTable.id, recarga.packRecargaId))
        .limit(1)
      packNombre = pack?.nombre ?? null
    }
    return {
      tipo: 'recarga',
      recarga,
      restauranteNombre: await nombreRestaurante(db, recarga.restauranteId),
      packNombre,
      estado: resolverEstado(recarga.estado, recarga.tokenExpiraEn),
    }
  }

  const pago = await getPagoSuscripcionPorToken(db, token)
  if (pago) {
    const items = await db
      .select({ tipo: PagoSuscripcionItemTable.tipo, descripcion: PagoSuscripcionItemTable.descripcion })
      .from(PagoSuscripcionItemTable)
      .where(eq(PagoSuscripcionItemTable.pagoSuscripcionId, pago.id))
    const modulos = items.filter((item) => item.tipo === 'modulo').map((item) => item.descripcion)
    const pack = items.find((item) => item.tipo === 'pack_mensajes')?.descripcion
    const conceptoBase = items.find((item) => item.tipo === 'base')?.descripcion ?? 'Suscripción Piru'
    return {
      tipo: 'suscripcion',
      pago,
      restauranteNombre: await nombreRestaurante(db, pago.restauranteId),
      concepto: [conceptoBase, ...modulos, ...(pack ? [pack] : [])].join(' + '),
      estado: resolverEstado(pago.estado, pago.tokenExpiraEn),
    }
  }

  return null
}

/** Info pública del link de pago (para renderizar la página `/pago/:token`). */
pagoRoute.get('/:token', async (c) => {
  const db = drizzle(pool)
  const token = c.req.param('token')

  try {
    const info = await cargarLink(db, token)
    if (!info) return c.json({ message: 'Link de pago no encontrado', success: false }, 404)

    if (info.tipo === 'suscripcion') {
      const cicloTxt = info.pago.ciclo === 'anual' ? 'Anual' : 'Mensual'
      return c.json({
        success: true,
        data: {
          tipo: 'suscripcion',
          estado: info.estado,
          restauranteNombre: info.restauranteNombre,
          concepto: `${info.concepto} · ${cicloTxt}`,
          monto: info.pago.montoTotal ?? info.pago.monto,
        },
      }, 200)
    }

    const { recarga, restauranteNombre, packNombre, estado } = info

    // Link ABIERTO (aviso de saldo bajo por WhatsApp): la recarga nació SIN pack definido.
    // La página muestra los packs de recarga y recién al elegir uno se arma el pago de MP.
    // Hasta que no elige, no hay concepto/monto que mostrar (se fijan en el checkout).
    if (recarga.seleccionPack && !recarga.packRecargaId) {
      const packs = await listarPacks(db, 'utility')
      return c.json({
        success: true,
        data: {
          tipo: 'recarga',
          estado,
          restauranteNombre,
          requiereSeleccionPack: true,
          packs,
          concepto: 'Recarga de avisos por WhatsApp',
          cantidad: null,
          unidad: unidad('utility'),
          monto: null, // sin pack elegido todavía no hay monto
        },
      }, 200)
    }

    return c.json({
      success: true,
      data: {
        tipo: 'recarga',
        estado,
        restauranteNombre,
        concepto: packNombre ?? `${recarga.cantidad} ${unidad(recarga.categoria)}`,
        cantidad: recarga.cantidad,
        categoria: recarga.categoria,
        unidad: unidad(recarga.categoria),
        monto: recarga.monto,
      },
    }, 200)
  } catch (error) {
    console.error('Error obteniendo link de pago:', error)
    return c.json({ message: 'Error al obtener el link de pago', success: false }, 500)
  }
})

/**
 * Inicia el pago del link con MercadoPago: crea la preferencia de Checkout Pro sobre el pago
 * pendiente del token (recarga o suscripción) y devuelve el init_point. Idempotente frente a
 * estados: si ya está pagado o vencido, no cobra de nuevo.
 */
pagoRoute.post('/:token/checkout', async (c) => {
  const db = drizzle(pool)
  const token = c.req.param('token')

  if (!pagosRecargaDisponibles()) {
    console.error('❌ [Pago link] Falta MP_ACCESS_TOKEN para cobrar')
    return c.json({ message: 'Pagos no disponibles temporalmente', success: false }, 503)
  }

  try {
    const info = await cargarLink(db, token)
    if (!info) return c.json({ message: 'Link de pago no encontrado', success: false }, 404)
    if (info.estado === 'paid') {
      return c.json({ message: 'Este pago ya fue realizado', success: false, estado: 'paid' }, 409)
    }
    if (info.estado === 'expired') {
      return c.json({ message: 'El link de pago venció. Pedí uno nuevo desde el panel.', success: false, estado: 'expired' }, 410)
    }

    // En los links ABIERTOS (selección de pack) el dueño elige el pack en la página y lo manda
    // acá recién ahora. En el resto de los links no hay body: el pack ya viene resuelto.
    const body = await c.req.json().catch(() => ({}))
    const packId = body.packId != null ? Number(body.packId) : null

    const backUrl = `${ADMIN_URL}/pago/${token}?estado=success`

    if (info.tipo === 'suscripcion') {
      const cicloTxt = info.pago.ciclo === 'anual' ? 'Anual' : 'Mensual'
      const pref = await crearPreferenciaSuscripcionMP({
        pagoId: info.pago.id,
        titulo: `Piru ${info.concepto} · ${cicloTxt}`,
        precio: parseFloat(String(info.pago.montoTotal ?? info.pago.monto)),
        backUrl,
      })
      if (!pref.ok) {
        return c.json({ message: 'Error al iniciar el pago', success: false }, 502)
      }
      await setPagoSuscripcionPreferencia(db, info.pago.id, pref.preferenceId)
      if (info.pago.recargaMensajesId) await setRecargaPreferencia(db, info.pago.recargaMensajesId, pref.preferenceId)
      return c.json({ success: true, data: { url_pago: pref.initPoint } }, 200)
    }

    const { recarga, packNombre } = info

    // Link ABIERTO: el pack todavía no estaba definido. Sin packId no hay pago posible
    // (el precio SIEMPRE sale del pack en la DB, nunca del cliente). Se fija pack,
    // cantidad y monto sobre la recarga pendiente; el webhook acredita eso mismo.
    let pack = null
    if (recarga.seleccionPack && !recarga.packRecargaId) {
      if (!packId) {
        return c.json({ message: 'Elegí un pack para continuar', success: false }, 400)
      }
      pack = await getPack(db, packId)
      if (!pack) {
        return c.json({ message: 'Pack no encontrado', success: false }, 404)
      }
      await db
        .update(RecargaMensajesTable)
        .set({ packRecargaId: pack.id, cantidad: pack.cantidad, monto: String(pack.precio) })
        .where(eq(RecargaMensajesTable.id, recarga.id))
    }

    const titulo = pack
      ? `${pack.nombre} · ${pack.cantidad} ${unidad(pack.categoria)}`
      : packNombre ?? `${recarga.cantidad} ${unidad(recarga.categoria)}`
    const precio = pack ? parseFloat(String(pack.precio)) : parseFloat(String(recarga.monto))

    const pref = await crearPreferenciaRecargaMP({
      recargaId: recarga.id,
      titulo,
      precio,
      backUrl,
    })
    if (!pref.ok) {
      return c.json({ message: 'Error al iniciar el pago', success: false }, 502)
    }
    await setRecargaPreferencia(db, recarga.id, pref.preferenceId)
    return c.json({ success: true, data: { url_pago: pref.initPoint } }, 200)
  } catch (error) {
    console.error('Error en checkout del link de pago:', error)
    return c.json({ message: 'Error al iniciar el pago', success: false }, 500)
  }
})

export { pagoRoute }
