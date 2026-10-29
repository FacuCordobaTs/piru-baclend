import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/mysql2'
import { pool } from '../db'
import {
  mensajeWhatsapp as MensajeWhatsappTable,
  pedidoUnificado as PedidoUnificadoTable,
  restaurante as RestauranteTable,
  zonaEspecial as ZonaEspecialTable,
} from '../db/schema'
import { authMiddleware } from '../middleware/auth'
import { requireModulo } from '../middleware/modulo'
import { MODULE_KEYS } from '../lib/modulos'
import { avisarSaldoBajoSiCorresponde, consumirMensaje, estadoEnvioUtility } from '../lib/mensajes-wallet'
import { resolverCredsRestaurante, sendZonaEspecialLlegadaWhatsApp } from '../services/whatsapp'
import {
  estadoVentanaZona,
  horarioValido,
  mensajeLlegadaZona,
  normalizarHora,
  telefonoWaMe,
  urlWaMe,
} from '../lib/zonas-especiales'

const zonaEspecialRoute = new Hono()

// Toda la capacidad —configuración, pre-pedidos y avisos— vive detrás del
// módulo de avisos automáticos por WhatsApp, que es el que paga la plantilla de
// utilidad de Meta. No se crea un módulo comercial nuevo.
zonaEspecialRoute.use('*', authMiddleware, requireModulo(MODULE_KEYS.AVISOS_AUTOMATICOS_WHATSAPP))

const horaSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Usá el formato HH:mm')

const createZonaSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre es requerido').max(255),
  precio: z.union([z.string(), z.number()]),
  horaInicio: horaSchema,
  horaFin: horaSchema,
  activa: z.boolean().optional().default(true),
})

const updateZonaSchema = z.object({
  nombre: z.string().trim().min(1).max(255).optional(),
  precio: z.union([z.string(), z.number()]).optional(),
  horaInicio: horaSchema.optional(),
  horaFin: horaSchema.optional(),
  activa: z.boolean().optional(),
})

const ESTADOS_PENDIENTES = ['pending', 'preparing', 'ready', 'received', 'dispatched'] as const

type Destinatario = {
  pedidoId: number
  nombre: string
  telefono: string
  telefonoWaMe: string | null
  mensaje: string
  waLink: string | null
  createdAt: Date
}

async function cargarDestinatarios(
  db: any,
  restauranteId: number,
  zona: { id: number; nombre: string },
  nombreLocal: string,
): Promise<Destinatario[]> {
  const pedidos = await db
    .select({
      id: PedidoUnificadoTable.id,
      nombreCliente: PedidoUnificadoTable.nombreCliente,
      telefono: PedidoUnificadoTable.telefono,
      createdAt: PedidoUnificadoTable.createdAt,
    })
    .from(PedidoUnificadoTable)
    .where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId),
      eq(PedidoUnificadoTable.zonaEspecialId, zona.id),
      eq(PedidoUnificadoTable.tipo, 'delivery'),
      inArray(PedidoUnificadoTable.estado, ESTADOS_PENDIENTES as any),
    ))
    .orderBy(desc(PedidoUnificadoTable.createdAt))

  // Un cliente con dos pedidos en la misma zona recibe un solo aviso: la
  // llegada es del viaje, no de la cantidad de comandas.
  const vistos = new Set<string>()
  const destinatarios: Destinatario[] = []
  for (const pedido of pedidos) {
    const telefono = pedido.telefono?.trim() ?? ''
    if (!telefono) continue
    const clave = telefono.replace(/\D/g, '')
    if (!clave || vistos.has(clave)) continue
    vistos.add(clave)

    const mensaje = mensajeLlegadaZona({
      nombreCliente: pedido.nombreCliente,
      nombreZona: zona.nombre,
      nombreLocal,
    })
    const numero = telefonoWaMe(telefono)
    destinatarios.push({
      pedidoId: pedido.id,
      nombre: pedido.nombreCliente?.trim() || 'Cliente',
      telefono,
      telefonoWaMe: numero,
      mensaje,
      waLink: numero ? urlWaMe(numero, mensaje) : null,
      createdAt: pedido.createdAt,
    })
  }
  return destinatarios
}

async function cargarRestaurante(db: any, restauranteId: number) {
  const [restaurante] = await db
    .select({
      nombre: RestauranteTable.nombre,
      whatsappPhoneId: RestauranteTable.whatsappPhoneId,
      whatsappAccessToken: RestauranteTable.whatsappAccessToken,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)
  return restaurante ?? null
}

// GET /zonas-especiales — listado con estado de ventana y pedidos pendientes.
zonaEspecialRoute.get('/', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  try {
    const zonas = await db
      .select()
      .from(ZonaEspecialTable)
      .where(eq(ZonaEspecialTable.restauranteId, restauranteId))
      .orderBy(ZonaEspecialTable.nombre, ZonaEspecialTable.id)

    const pendientes = await db
      .select({
        zonaEspecialId: PedidoUnificadoTable.zonaEspecialId,
        telefono: PedidoUnificadoTable.telefono,
      })
      .from(PedidoUnificadoTable)
      .where(and(
        eq(PedidoUnificadoTable.restauranteId, restauranteId),
        eq(PedidoUnificadoTable.tipo, 'delivery'),
        inArray(PedidoUnificadoTable.estado, ESTADOS_PENDIENTES as any),
      ))

    const porZona = new Map<number, Set<string>>()
    for (const pedido of pendientes) {
      if (pedido.zonaEspecialId == null) continue
      const clave = (pedido.telefono ?? '').replace(/\D/g, '')
      if (!clave) continue
      const set = porZona.get(pedido.zonaEspecialId) ?? new Set<string>()
      set.add(clave)
      porZona.set(pedido.zonaEspecialId, set)
    }

    const ahora = new Date()
    return c.json({
      success: true,
      data: zonas.map((zona) => {
        const estado = horarioValido(zona)
          ? estadoVentanaZona(zona, ahora)
          : null
        return {
          ...zona,
          enVentana: estado?.enVentana ?? false,
          proximaVentana: estado?.ventana.etiqueta ?? null,
          pedidosPendientes: porZona.get(zona.id)?.size ?? 0,
        }
      }),
    }, 200)
  } catch (error) {
    console.error('Error listando zonas especiales:', error)
    return c.json({ success: false, message: 'No se pudieron cargar las zonas especiales' }, 500)
  }
})

// PUT /zonas-especiales/habilitadas — interruptor maestro de la tienda.
// Va antes de /:id para que "habilitadas" no se lea como un id.
zonaEspecialRoute.put('/habilitadas', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  try {
    const [actual] = await db
      .select({ habilitadas: RestauranteTable.zonasEspecialesHabilitadas })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)
    if (!actual) return c.json({ success: false, message: 'Local no encontrado' }, 404)

    const nuevo = !actual.habilitadas
    await db
      .update(RestauranteTable)
      .set({ zonasEspecialesHabilitadas: nuevo })
      .where(eq(RestauranteTable.id, restauranteId))

    return c.json({ success: true, zonasEspecialesHabilitadas: nuevo }, 200)
  } catch (error) {
    console.error('Error actualizando el interruptor de zonas especiales:', error)
    return c.json({ success: false, message: 'No se pudo guardar la opción' }, 500)
  }
})

// PUT /zonas-especiales/prepedidos — toggle del permiso de pre-pedidos.
zonaEspecialRoute.put('/prepedidos', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  try {
    const [actual] = await db
      .select({ permitir: RestauranteTable.permitirPrePedidosZonasEspeciales })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)
    if (!actual) return c.json({ success: false, message: 'Local no encontrado' }, 404)

    const nuevo = !actual.permitir
    await db
      .update(RestauranteTable)
      .set({ permitirPrePedidosZonasEspeciales: nuevo })
      .where(eq(RestauranteTable.id, restauranteId))

    return c.json({ success: true, permitirPrePedidosZonasEspeciales: nuevo }, 200)
  } catch (error) {
    console.error('Error actualizando pre-pedidos de zonas especiales:', error)
    return c.json({ success: false, message: 'No se pudo guardar la opción' }, 500)
  }
})

zonaEspecialRoute.post('/create', zValidator('json', createZonaSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const data = c.req.valid('json')

  const precio = Number(data.precio)
  if (!Number.isFinite(precio) || precio < 0) {
    return c.json({ success: false, message: 'El precio de envío no es válido' }, 400)
  }
  if (data.horaFin === data.horaInicio) {
    return c.json({ success: false, message: 'La hora de fin debe ser distinta a la de inicio' }, 400)
  }

  try {
    const result = await db.insert(ZonaEspecialTable).values({
      restauranteId,
      nombre: data.nombre.trim(),
      precio: precio.toFixed(2),
      horaInicio: normalizarHora(data.horaInicio)!,
      horaFin: normalizarHora(data.horaFin)!,
      activa: data.activa,
    })
    const [zona] = await db
      .select()
      .from(ZonaEspecialTable)
      .where(eq(ZonaEspecialTable.id, Number(result[0].insertId)))
      .limit(1)
    return c.json({ success: true, data: zona, message: 'Zona especial creada' }, 201)
  } catch (error) {
    console.error('Error creando zona especial:', error)
    return c.json({ success: false, message: 'No se pudo crear la zona especial' }, 500)
  }
})

zonaEspecialRoute.put('/:id', zValidator('json', updateZonaSchema), async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const zonaId = Number(c.req.param('id'))
  if (!Number.isInteger(zonaId) || zonaId <= 0) {
    return c.json({ success: false, message: 'Zona inválida' }, 400)
  }

  const data = c.req.valid('json')
  const [existente] = await db
    .select()
    .from(ZonaEspecialTable)
    .where(and(eq(ZonaEspecialTable.id, zonaId), eq(ZonaEspecialTable.restauranteId, restauranteId)))
    .limit(1)
  if (!existente) return c.json({ success: false, message: 'Zona no encontrada' }, 404)

  const update: Record<string, unknown> = {}
  if (data.nombre !== undefined) update.nombre = data.nombre.trim()
  if (data.precio !== undefined) {
    const precio = Number(data.precio)
    if (!Number.isFinite(precio) || precio < 0) {
      return c.json({ success: false, message: 'El precio de envío no es válido' }, 400)
    }
    update.precio = precio.toFixed(2)
  }
  if (data.horaInicio !== undefined) update.horaInicio = normalizarHora(data.horaInicio)!
  if (data.horaFin !== undefined) update.horaFin = normalizarHora(data.horaFin)!
  if (data.activa !== undefined) update.activa = data.activa

  const horaInicioFinal = (update.horaInicio as string | undefined) ?? existente.horaInicio
  const horaFinFinal = (update.horaFin as string | undefined) ?? existente.horaFin
  if (horaInicioFinal === horaFinFinal) {
    return c.json({ success: false, message: 'La hora de fin debe ser distinta a la de inicio' }, 400)
  }

  if (Object.keys(update).length === 0) {
    return c.json({ success: false, message: 'No hay datos para actualizar' }, 400)
  }

  try {
    await db.update(ZonaEspecialTable).set(update).where(eq(ZonaEspecialTable.id, zonaId))
    const [zona] = await db.select().from(ZonaEspecialTable).where(eq(ZonaEspecialTable.id, zonaId)).limit(1)
    return c.json({ success: true, data: zona, message: 'Zona especial actualizada' }, 200)
  } catch (error) {
    console.error('Error actualizando zona especial:', error)
    return c.json({ success: false, message: 'No se pudo actualizar la zona especial' }, 500)
  }
})

zonaEspecialRoute.delete('/:id', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const zonaId = Number(c.req.param('id'))
  if (!Number.isInteger(zonaId) || zonaId <= 0) {
    return c.json({ success: false, message: 'Zona inválida' }, 400)
  }

  try {
    const [existente] = await db
      .select({ id: ZonaEspecialTable.id })
      .from(ZonaEspecialTable)
      .where(and(eq(ZonaEspecialTable.id, zonaId), eq(ZonaEspecialTable.restauranteId, restauranteId)))
      .limit(1)
    if (!existente) return c.json({ success: false, message: 'Zona no encontrada' }, 404)

    const [pendiente] = await db
      .select({ id: PedidoUnificadoTable.id })
      .from(PedidoUnificadoTable)
      .where(and(
        eq(PedidoUnificadoTable.restauranteId, restauranteId),
        eq(PedidoUnificadoTable.zonaEspecialId, zonaId),
        eq(PedidoUnificadoTable.tipo, 'delivery'),
        inArray(PedidoUnificadoTable.estado, ESTADOS_PENDIENTES as any),
      ))
      .limit(1)
    if (pendiente) {
      return c.json({
        success: false,
        message: 'Hay pedidos pendientes en esta zona. Desactivala o esperá a entregarlos antes de eliminarla.',
      }, 409)
    }

    await db.delete(ZonaEspecialTable).where(eq(ZonaEspecialTable.id, zonaId))
    return c.json({ success: true, message: 'Zona especial eliminada' }, 200)
  } catch (error) {
    console.error('Error eliminando zona especial:', error)
    return c.json({ success: false, message: 'No se pudo eliminar la zona especial' }, 500)
  }
})

// GET /zonas-especiales/:id/destinatarios — preview para el diálogo de avisos.
zonaEspecialRoute.get('/:id/destinatarios', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const zonaId = Number(c.req.param('id'))
  if (!Number.isInteger(zonaId) || zonaId <= 0) {
    return c.json({ success: false, message: 'Zona inválida' }, 400)
  }

  try {
    const [zona] = await db
      .select()
      .from(ZonaEspecialTable)
      .where(and(eq(ZonaEspecialTable.id, zonaId), eq(ZonaEspecialTable.restauranteId, restauranteId)))
      .limit(1)
    if (!zona) return c.json({ success: false, message: 'Zona no encontrada' }, 404)

    const restaurante = await cargarRestaurante(db, restauranteId)
    const destinatarios = await cargarDestinatarios(
      db,
      restauranteId,
      { id: zona.id, nombre: zona.nombre },
      restaurante?.nombre || 'El local',
    )

    return c.json({
      success: true,
      data: {
        zona: { id: zona.id, nombre: zona.nombre, horaInicio: zona.horaInicio, horaFin: zona.horaFin },
        destinatarios,
        total: destinatarios.length,
      },
    }, 200)
  } catch (error) {
    console.error('Error cargando destinatarios de zona especial:', error)
    return c.json({ success: false, message: 'No se pudieron cargar los pedidos de la zona' }, 500)
  }
})

// POST /zonas-especiales/:id/enviar-llegada — plantilla utility de Meta a
// todos los pedidos pendientes de la zona (un aviso por teléfono).
zonaEspecialRoute.post('/:id/enviar-llegada', async (c) => {
  const db = drizzle(pool)
  const restauranteId = (c as any).user.id
  const zonaId = Number(c.req.param('id'))
  if (!Number.isInteger(zonaId) || zonaId <= 0) {
    return c.json({ success: false, message: 'Zona inválida' }, 400)
  }

  try {
    const [zona] = await db
      .select()
      .from(ZonaEspecialTable)
      .where(and(eq(ZonaEspecialTable.id, zonaId), eq(ZonaEspecialTable.restauranteId, restauranteId)))
      .limit(1)
    if (!zona) return c.json({ success: false, message: 'Zona no encontrada' }, 404)
    if (!zona.activa) {
      return c.json({ success: false, message: 'La zona especial está desactivada' }, 400)
    }

    const restaurante = await cargarRestaurante(db, restauranteId)
    if (!restaurante) return c.json({ success: false, message: 'Local no encontrado' }, 404)

    const destinatarios = await cargarDestinatarios(
      db,
      restauranteId,
      { id: zona.id, nombre: zona.nombre },
      restaurante.nombre || 'El local',
    )
    if (destinatarios.length === 0) {
      return c.json({
        success: true,
        message: 'No hay pedidos pendientes en esta zona',
        data: { enviados: 0, errores: 0, total: 0 },
      }, 200)
    }

    // Modo gracia del wallet utility: si el local agotó el techo de deuda, el
    // aviso no sale por Meta. La operación manual sigue disponible desde el
    // diálogo con los links de WhatsApp. Fail-open ante un error de contabilidad.
    try {
      const gate = await estadoEnvioUtility(db, restauranteId)
      if (!gate.permitido) {
        return c.json({
          success: false,
          saldoAgotado: true,
          message: 'El envío automático está pausado por falta de saldo. Podés avisar a cada cliente abriendo su WhatsApp.',
        }, 402)
      }
    } catch (error) {
      console.error('⚠️ [Zona especial] Error evaluando el wallet, se envía igual:', error)
    }

    try {
      await avisarSaldoBajoSiCorresponde(db, restauranteId)
    } catch (error) {
      console.error('⚠️ [Zona especial] Error evaluando aviso de saldo bajo:', error)
    }

    const creds = resolverCredsRestaurante(restaurante)
    let enviados = 0
    const errores: Array<{ pedidoId: number; message: string }> = []

    for (const destinatario of destinatarios) {
      const resultado = await sendZonaEspecialLlegadaWhatsApp(c, {
        phone: destinatario.telefono.replace(/\D/g, ''),
        customerName: destinatario.nombre,
        nombreZona: zona.nombre,
        restaurantName: restaurante.nombre || 'El local',
      }, creds)

      if (!resultado.success) {
        errores.push({
          pedidoId: destinatario.pedidoId,
          message: 'Meta no aceptó el mensaje',
        })
        continue
      }

      enviados += 1

      await db.insert(MensajeWhatsappTable).values({
        pedidoUnificadoId: destinatario.pedidoId,
        restauranteId,
        telefono: destinatario.telefono,
        tipo: 'zona_especial_llegada',
      }).catch((error) => {
        console.error('Error registrando aviso de zona especial:', error)
      })

      try {
        await consumirMensaje(db, restauranteId, {
          categoria: 'utility',
          tipoMensaje: 'zona_especial_llegada',
          motivo: 'aviso_llegada_zona_especial',
          pedidoUnificadoId: destinatario.pedidoId,
        })
      } catch (error) {
        // La contabilidad nunca invalida un aviso ya enviado.
        console.error('⚠️ [Zona especial] Error descontando mensaje:', error)
      }
    }

    return c.json({
      success: errores.length < destinatarios.length,
      message: enviados > 0
        ? `Aviso enviado a ${enviados} ${enviados === 1 ? 'cliente' : 'clientes'}${errores.length > 0 ? `; ${errores.length} falló` : ''}`
        : 'No se pudo enviar ningún aviso',
      data: { enviados, errores: errores.length, total: destinatarios.length },
    }, 200)
  } catch (error) {
    console.error('Error enviando avisos de zona especial:', error)
    return c.json({ success: false, message: 'No se pudieron enviar los avisos' }, 500)
  }
})

export { zonaEspecialRoute }
