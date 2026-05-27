import { Hono } from 'hono'
import { pool } from '../db'
import {
  restaurante as RestauranteTable,
  pedidoUnificado as PedidoUnificadoTable,
} from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { authMiddleware } from '../middleware/auth'
import { eq, and, inArray, or } from 'drizzle-orm'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import Afip from '@afipsdk/afip.js'
import { emitirFacturaPedido } from '../services/afip-billing'

const facturacionRoute = new Hono()
  .use('*', authMiddleware)

  // Estado de la configuración AFIP del restaurante
  .get('/estado', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id

    const res = await db
      .select({
        afipHabilitado: RestauranteTable.afipHabilitado,
        afipCuit: RestauranteTable.afipCuit,
        afipPuntoDeVenta: RestauranteTable.afipPuntoDeVenta,
        afipCondicionIva: RestauranteTable.afipCondicionIva,
        afipCert: RestauranteTable.afipCert,
      })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)

    if (!res.length) return c.json({ message: 'Restaurante no encontrado', success: false }, 404)

    const r = res[0]
    return c.json({
      success: true,
      data: {
        habilitado: r.afipHabilitado,
        cuit: r.afipCuit,
        puntoDeVenta: r.afipPuntoDeVenta,
        condicionIva: r.afipCondicionIva,
        tieneCert: Boolean(r.afipCert),
      },
    })
  })

  // Configurar AFIP: crea cert+key via AfipSDK, autoriza wsfe, crea punto de venta
  .post('/configurar', zValidator('json', z.object({
    afipCuit: z.string().length(11),
    afipClaveFiscal: z.string().min(1),
    afipCondicionIva: z.enum(['RI', 'MO']),
  })), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const { afipCuit, afipClaveFiscal, afipCondicionIva } = c.req.valid('json')

    const resRows = await db
      .select({ nombre: RestauranteTable.nombre })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)

    if (!resRows.length) return c.json({ message: 'Restaurante no encontrado', success: false }, 404)

    const nombreFantasia = resRows[0].nombre

    try {
      const afip = new Afip({
        CUIT: Number(afipCuit),
        access_token: process.env.AFIPSDK_ACCESS_TOKEN!,
        production: false,
      })

      // 1. Crear certificado digital
      const certResult = await afip.CreateAutomation(
        'create-cert-prod',
        { cuit: afipCuit, username: afipCuit, password: afipClaveFiscal },
        true
      )
      const cert = (certResult as any).cert
      const key = (certResult as any).key

      // 2. Autorizar web service wsfe
      await afip.CreateAutomation(
        'auth-web-service-prod',
        { cuit: afipCuit, username: afipCuit, password: afipClaveFiscal, wsid: 'wsfe' },
        true
      )

      // 3. Listar puntos de venta existentes
      let puntosExistentes: number[] = []
      try {
        const listResponse = await afip.CreateAutomation(
          'list-sales-points',
          { cuit: afipCuit, username: afipCuit, password: afipClaveFiscal },
          true
        )
        if (Array.isArray(listResponse)) {
          puntosExistentes = listResponse.map((p: any) => Number(p.numero || p.Nro || p.nro))
        }
      } catch {}

      // 4. Elegir próximo número disponible
      let numeroPuntoDeVenta = 1
      while (puntosExistentes.includes(numeroPuntoDeVenta)) {
        numeroPuntoDeVenta++
      }

      const sistema = afipCondicionIva === 'MO' ? 'FEEM' : 'FEEWS'

      await afip.CreateAutomation(
        'create-sales-point',
        {
          cuit: afipCuit,
          username: afipCuit,
          password: afipClaveFiscal,
          numero: numeroPuntoDeVenta,
          sistema,
          nombreFantasia,
        },
        true
      )

      // 5. Guardar todo en la DB
      await db
        .update(RestauranteTable)
        .set({
          afipHabilitado: true,
          afipCuit,
          afipClaveFiscal,
          afipCert: cert,
          afipKeyPrivada: key,
          afipPuntoDeVenta: numeroPuntoDeVenta,
          afipCondicionIva,
        })
        .where(eq(RestauranteTable.id, restauranteId))

      return c.json({
        success: true,
        data: { puntoDeVenta: numeroPuntoDeVenta, sistema },
      })
    } catch (error: any) {
      console.error('[facturacion/configurar] Error:', error)
      return c.json({
        success: false,
        message: error?.message || 'Error al configurar AFIP',
        error: error?.response || error?.message || String(error),
      }, 500)
    }
  })

  // Desactivar facturación AFIP
  .post('/desactivar', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id

    await db
      .update(RestauranteTable)
      .set({ afipHabilitado: false })
      .where(eq(RestauranteTable.id, restauranteId))

    return c.json({ success: true, message: 'Facturación AFIP desactivada' })
  })

  // Facturar un lote de pedidos (max 50) de forma secuencial
  .post('/facturar-batch', zValidator('json', z.object({
    pedidoIds: z.array(z.number().int().positive()).min(1).max(50),
  })), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const { pedidoIds } = c.req.valid('json')

    const resRows = await db
      .select({
        nombre: RestauranteTable.nombre,
        afipHabilitado: RestauranteTable.afipHabilitado,
        afipCuit: RestauranteTable.afipCuit,
        afipClaveFiscal: RestauranteTable.afipClaveFiscal,
        afipCert: RestauranteTable.afipCert,
        afipKeyPrivada: RestauranteTable.afipKeyPrivada,
        afipPuntoDeVenta: RestauranteTable.afipPuntoDeVenta,
        afipCondicionIva: RestauranteTable.afipCondicionIva,
      })
      .from(RestauranteTable)
      .where(eq(RestauranteTable.id, restauranteId))
      .limit(1)

    if (!resRows.length) return c.json({ message: 'Restaurante no encontrado', success: false }, 404)

    const restaurante = resRows[0]

    if (!restaurante.afipHabilitado || !restaurante.afipCert || !restaurante.afipKeyPrivada || !restaurante.afipCuit) {
      return c.json({ message: 'AFIP no configurado correctamente', success: false }, 400)
    }

    const pedidos = await db
      .select({
        id: PedidoUnificadoTable.id,
        total: PedidoUnificadoTable.total,
        nombreCliente: PedidoUnificadoTable.nombreCliente,
      })
      .from(PedidoUnificadoTable)
      .where(and(
        eq(PedidoUnificadoTable.restauranteId, restauranteId),
        inArray(PedidoUnificadoTable.id, pedidoIds),
        eq(PedidoUnificadoTable.afipFacturado, false),
      ))

    const config = {
      cuit: restaurante.afipCuit!,
      claveFiscal: restaurante.afipClaveFiscal!,
      cert: restaurante.afipCert!,
      key: restaurante.afipKeyPrivada!,
      nombreFantasia: restaurante.nombre,
      puntoDeVenta: restaurante.afipPuntoDeVenta ?? undefined,
    }

    const resultados: { pedidoId: number; success: boolean; cae?: string; error?: string }[] = []
    let puntoDeVentaCreado: number | null = null

    for (const pedido of pedidos) {
      try {
        const resultado = await emitirFacturaPedido(config, {
          id: pedido.id,
          total: parseFloat(pedido.total),
          nombreCliente: pedido.nombreCliente,
        })

        await db
          .update(PedidoUnificadoTable)
          .set({
            afipFacturado: true,
            afipCae: resultado.cae,
            afipCaeFchVto: resultado.caeFchVto,
            afipNumeroComprobante: resultado.numeroComprobante,
            afipPuntoDeVenta: resultado.puntoDeVenta,
          })
          .where(eq(PedidoUnificadoTable.id, pedido.id))

        if (!config.puntoDeVenta && resultado.puntoDeVenta) {
          puntoDeVentaCreado = resultado.puntoDeVenta
          config.puntoDeVenta = resultado.puntoDeVenta
        }

        resultados.push({ pedidoId: pedido.id, success: true, cae: resultado.cae })
      } catch (error: any) {
        console.error(`[facturar-batch] Error en pedido ${pedido.id}:`, error)
        resultados.push({ pedidoId: pedido.id, success: false, error: error?.message || String(error) })
      }
    }

    if (puntoDeVentaCreado !== null && !restaurante.afipPuntoDeVenta) {
      await db
        .update(RestauranteTable)
        .set({ afipPuntoDeVenta: puntoDeVentaCreado })
        .where(eq(RestauranteTable.id, restauranteId))
    }

    return c.json({ success: true, data: resultados })
  })

  // Listar pedidos entregados/archivados sin facturar
  .get('/pedidos-sin-facturar', async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id

    const pedidos = await db
      .select({
        id: PedidoUnificadoTable.id,
        tipo: PedidoUnificadoTable.tipo,
        nombreCliente: PedidoUnificadoTable.nombreCliente,
        telefono: PedidoUnificadoTable.telefono,
        total: PedidoUnificadoTable.total,
        estado: PedidoUnificadoTable.estado,
        createdAt: PedidoUnificadoTable.createdAt,
        metodoPago: PedidoUnificadoTable.metodoPago,
      })
      .from(PedidoUnificadoTable)
      .where(and(
        eq(PedidoUnificadoTable.restauranteId, restauranteId),
        eq(PedidoUnificadoTable.afipFacturado, false),
        or(
          eq(PedidoUnificadoTable.estado, 'delivered'),
          eq(PedidoUnificadoTable.estado, 'archived'),
        )
      ))
      .orderBy(PedidoUnificadoTable.createdAt)

    return c.json({ success: true, data: pedidos })
  })

export { facturacionRoute }
