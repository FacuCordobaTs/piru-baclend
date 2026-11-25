// src/routes/whatsapp-vinculado.ts
//
// /api/whatsapp-vinculado: el WhatsApp del local vinculado como dispositivo (ver lib/whatsapp-vinculado.ts).
//   GET  /                 estado para Ajustes (y QR mientras se vincula)
//   POST /vincular         pide un QR al servicio
//   POST /desvincular      cierra la sesión
//   POST /evento           sólo el servicio wa-vinculado (X-Piru-Secret): estado y "Pedido #N"

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/mysql2'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { pool } from '../db'
import { authMiddleware } from '../middleware/auth'
import { pedidoUnificado as PedidoTable, whatsappVinculado as VinculadoTable } from '../db/schema'
import { resolverClienteParaPedido } from '../lib/clientes-identidad'
import { emitirEventoPedido } from '../lib/pedidos-activos'
import {
  decidirConfirmacion,
  guardarEstado,
  LIMITE_DIARIO_VINCULADO,
  llamarServicio,
  secretoValido,
  servicioConfigurado,
  telefonoDelCliente,
  vinculadoAplica,
  type EstadoSesion,
} from '../lib/whatsapp-vinculado'
import { procesarEnviosVinculados } from './recompra-tandas'

const db = drizzle(pool)

const eventoSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('estado'),
    restauranteId: z.number().int().positive(),
    conectado: z.boolean(),
    telefono: z.string().max(32).optional().nullable(),
  }),
  z.object({
    tipo: z.literal('pedido'),
    restauranteId: z.number().int().positive(),
    pedidoId: z.number().int().positive(),
    telefono: z.string().min(8).max(32),
    nombre: z.string().max(120).optional().nullable(),
    mensajeId: z.string().max(255).optional().nullable(),
    at: z.string().optional().nullable(),
  }),
])

export const whatsappVinculadoRoute = new Hono()

whatsappVinculadoRoute.post('/evento', async (c) => {
  if (!secretoValido(c.req.header('X-Piru-Secret'))) return c.json({ success: false }, 401)
  const parsed = eventoSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ success: false }, 400)
  const evento = parsed.data

  if (evento.tipo === 'estado') {
    await guardarEstado(db, evento.restauranteId, evento.conectado, evento.telefono || null)
    if (evento.conectado) void procesarEnviosVinculados(evento.restauranteId)
    return c.json({ success: true })
  }

  // Con avisos automáticos el pedido se confirma por Meta: este canal no aplica.
  if (!(await vinculadoAplica(db, evento.restauranteId))) return c.json({ success: true, ignorado: true })

  const [pedido] = await db.select().from(PedidoTable).where(and(
    eq(PedidoTable.restauranteId, evento.restauranteId), eq(PedidoTable.id, evento.pedidoId),
  )).limit(1)
  const decision = decidirConfirmacion(pedido ?? null, evento.telefono, Date.now())
  if (decision === 'ignorar') return c.json({ success: true, ignorado: true })

  const ahora = new Date()
  if (decision === 'confirmar') {
    await db.update(PedidoTable).set({ whatsappConfirmadoAt: ahora })
      .where(and(eq(PedidoTable.restauranteId, evento.restauranteId), eq(PedidoTable.id, pedido.id)))
  } else {
    // El cliente no dejó su número en el checkout: es el del WhatsApp que mandó el pedido.
    const telefono = await telefonoDelCliente(db, evento.restauranteId, evento.telefono)
    const nombre = pedido.nombreCliente?.trim() || evento.nombre?.trim() || 'Cliente'
    const perfil = await db.transaction((tx) => resolverClienteParaPedido(tx, {
      restauranteId: evento.restauranteId, nombre, telefono,
    }))
    await db.update(PedidoTable).set({
      whatsappConfirmadoAt: ahora,
      telefono,
      ...(pedido.clienteId ? {} : { clienteId: perfil?.id ?? null }),
    }).where(and(eq(PedidoTable.restauranteId, evento.restauranteId), eq(PedidoTable.id, pedido.id)))
  }

  await emitirEventoPedido(db as any, {
    restauranteId: evento.restauranteId,
    pedidoId: pedido.id,
    tipo: pedido.tipo,
    sucursalId: pedido.sucursalId ?? null,
    event: 'upsert',
    reason: 'updated',
  })
  return c.json({ success: true })
})

whatsappVinculadoRoute.use('/', authMiddleware)
whatsappVinculadoRoute.use('/vincular', authMiddleware)
whatsappVinculadoRoute.use('/desvincular', authMiddleware)

async function respuestaEstado(restauranteId: number, sesion?: EstadoSesion) {
  const aplica = await vinculadoAplica(db, restauranteId)
  if (!servicioConfigurado()) return { aplica, disponible: false, estado: 'desvinculado' as const, limiteDiario: LIMITE_DIARIO_VINCULADO }
  const actual = sesion ?? (await llamarServicio<EstadoSesion>(restauranteId, '')).data
  const estado = (actual as any)?.estado ?? 'desvinculado'
  // El estado guardado sigue al servicio aunque se haya perdido un evento.
  const conectado = estado === 'conectado'
  const [fila] = await db.select().from(VinculadoTable).where(eq(VinculadoTable.restauranteId, restauranteId)).limit(1)
  const telefono = (actual as any)?.telefono ?? null
  if ((estado === 'conectado' || estado === 'desvinculado') && (Boolean(fila?.conectado) !== conectado || (fila?.telefono ?? null) !== telefono)) {
    await guardarEstado(db, restauranteId, conectado, telefono)
  }
  return { aplica, disponible: true, ...actual, limiteDiario: LIMITE_DIARIO_VINCULADO }
}

whatsappVinculadoRoute.get('/', async (c: any) => {
  return c.json({ success: true, data: await respuestaEstado(c.user.id) })
})

whatsappVinculadoRoute.post('/vincular', async (c: any) => {
  const restauranteId = c.user.id as number
  if (!(await vinculadoAplica(db, restauranteId))) {
    return c.json({ success: false, code: 'avisos_activos', message: 'Tu local ya tiene los avisos automáticos: los pedidos y las tandas salen por ahí.' }, 409)
  }
  const res = await llamarServicio<EstadoSesion>(restauranteId, 'vincular')
  if (!res.ok) return c.json({ success: false, message: 'No pudimos generar el código. Probá de nuevo en un minuto.' }, 502)
  return c.json({ success: true, data: await respuestaEstado(restauranteId, res.data) })
})

whatsappVinculadoRoute.post('/desvincular', async (c: any) => {
  const restauranteId = c.user.id as number
  await llamarServicio(restauranteId, 'desvincular')
  await guardarEstado(db, restauranteId, false, null)
  return c.json({ success: true, data: await respuestaEstado(restauranteId, { estado: 'desvinculado' }) })
})
