// mesa.ts
import { Hono } from 'hono'
import { pool } from '../db'
import { mesa as MesaTable, pedido as PedidoTable, producto as ProductoTable, itemPedido as ItemPedidoTable, restaurante as RestauranteTable, categoria as CategoriaTable, productoIngrediente as ProductoIngredienteTable, ingrediente as IngredienteTable, pago as PagoTable, pagoSubtotal as PagoSubtotalTable } from '../db/schema'
import { drizzle } from 'drizzle-orm/mysql2'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import UUID = require("uuid-js");
import { authMiddleware } from '../middleware/auth'
import { and, desc, eq, ne, inArray } from 'drizzle-orm'
import { wsManager } from '../websocket/manager'

const createMesaSchema = z.object({
  nombre: z.string().max(255),
})

const mesaRoute = new Hono()


  .post('/create', authMiddleware, zValidator('json', createMesaSchema), async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const { nombre } = c.req.valid('json')
    const mesa = await db.insert(MesaTable).values({
      nombre,
      restauranteId,
      qrToken: UUID.create().toString()
    })
    return c.json({ message: 'Mesa creada correctamente', success: true, data: mesa }, 200)
  })

  .get('/join/:qrToken', async (c) => {
    const db = drizzle(pool)
    const qrToken = c.req.param('qrToken')

    const mesa = await db.select().from(MesaTable).where(eq(MesaTable.qrToken, qrToken))

    if (!mesa || mesa.length === 0) {
      return c.json({ message: 'Mesa no encontrada', success: false }, 404)
    }

    // Obtener información del restaurante (nombre, imagen, estado de MP y modo carrito)
    const restaurante = await db.select({
      id: RestauranteTable.id,
      nombre: RestauranteTable.nombre,
      imagenUrl: RestauranteTable.imagenUrl,
      mpConnected: RestauranteTable.mpConnected,
      esCarrito: RestauranteTable.esCarrito,
    }).from(RestauranteTable).where(eq(RestauranteTable.id, mesa[0].restauranteId!)).limit(1)

    let ultimoPedido = await db.select().
      from(PedidoTable).
      where(eq(PedidoTable.mesaId, mesa[0].id)).
      orderBy(desc(PedidoTable.createdAt))
      .limit(1)

    const productos = await db
      .select({
        id: ProductoTable.id,
        restauranteId: ProductoTable.restauranteId,
        categoriaId: ProductoTable.categoriaId,
        nombre: ProductoTable.nombre,
        descripcion: ProductoTable.descripcion,
        precio: ProductoTable.precio,
        activo: ProductoTable.activo,
        imagenUrl: ProductoTable.imagenUrl,
        createdAt: ProductoTable.createdAt,
        categoria: {
          id: CategoriaTable.id,
          nombre: CategoriaTable.nombre,
        }
      })
      .from(ProductoTable)
      .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
      .where(and(eq(ProductoTable.restauranteId, mesa[0].restauranteId!), eq(ProductoTable.activo, true)))

    // Obtener ingredientes para cada producto
    const productosConIngredientes = await Promise.all(
      productos.map(async (p) => {
        const ingredientes = await db
          .select({
            id: IngredienteTable.id,
            nombre: IngredienteTable.nombre,
          })
          .from(ProductoIngredienteTable)
          .innerJoin(IngredienteTable, eq(ProductoIngredienteTable.ingredienteId, IngredienteTable.id))
          .where(eq(ProductoIngredienteTable.productoId, p.id))

        return {
          ...p,
          categoria: p.categoria?.nombre || null,
          ingredientes: ingredientes,
        }
      })
    )

    let pedidoActual = ultimoPedido[0];

    if (!pedidoActual) {
      // No hay pedidos, crear uno nuevo
      const nuevoPedido = await db.insert(PedidoTable).values({
        mesaId: mesa[0].id,
        restauranteId: mesa[0].restauranteId,
        estado: 'pending',
        total: '0.00'
      })

      // Obtener el pedido recién creado
      ultimoPedido = await db.select().from(PedidoTable).
        where(eq(PedidoTable.id, Number(nuevoPedido[0].insertId))).
        orderBy(desc(PedidoTable.createdAt))
        .limit(1)

      pedidoActual = ultimoPedido[0];
    } else if (pedidoActual.estado === 'closed') {
      // El último pedido está cerrado, verificar si todos pagaron
      const items = await db
        .select({
          clienteNombre: ItemPedidoTable.clienteNombre,
          cantidad: ItemPedidoTable.cantidad,
          precioUnitario: ItemPedidoTable.precioUnitario,
        })
        .from(ItemPedidoTable)
        .where(eq(ItemPedidoTable.pedidoId, pedidoActual.id));

      let todosPagaron = false;

      if (items.length === 0) {
        // Si no hay items, no hay nada que pagar
        todosPagaron = true;
      } else {
        // Calcular subtotal por cliente
        const subtotalesPorCliente: Record<string, number> = {};
        for (const item of items) {
          if (!subtotalesPorCliente[item.clienteNombre]) {
            subtotalesPorCliente[item.clienteNombre] = 0;
          }
          subtotalesPorCliente[item.clienteNombre] += parseFloat(item.precioUnitario) * (item.cantidad || 1);
        }

        // Obtener todos los pagos de subtotales pagados
        const pagosSubtotales = await db
          .select()
          .from(PagoSubtotalTable)
          .where(and(
            eq(PagoSubtotalTable.pedidoId, pedidoActual.id),
            eq(PagoSubtotalTable.estado, 'paid')
          ));

        // Calcular total pagado por cliente
        const pagadoPorCliente: Record<string, number> = {};
        for (const pago of pagosSubtotales) {
          if (!pagadoPorCliente[pago.clienteNombre]) {
            pagadoPorCliente[pago.clienteNombre] = 0;
          }
          pagadoPorCliente[pago.clienteNombre] += parseFloat(pago.monto);
        }

        // Verificar que cada cliente haya pagado al menos su subtotal
        todosPagaron = true;
        for (const [clienteNombre, subtotal] of Object.entries(subtotalesPorCliente)) {
          const pagado = pagadoPorCliente[clienteNombre] || 0;
          // Permitir pequeña diferencia por redondeo (0.01)
          if (pagado < subtotal - 0.01) {
            todosPagaron = false;
            break;
          }
        }
      }

      if (todosPagaron) {
        // Todos pagaron, crear nuevo pedido
        const nuevoPedido = await db.insert(PedidoTable).values({
          mesaId: mesa[0].id,
          restauranteId: mesa[0].restauranteId,
          estado: 'pending',
          total: '0.00'
        })

        // Obtener el pedido recién creado
        ultimoPedido = await db.select().from(PedidoTable).
          where(eq(PedidoTable.id, Number(nuevoPedido[0].insertId))).
          orderBy(desc(PedidoTable.createdAt))
          .limit(1)

        pedidoActual = ultimoPedido[0];
      }
      // Si no todos pagaron, usar el pedido cerrado actual
    }

    return c.json({
      message: 'Mesa encontrada correctamente',
      success: true,
      data: {
        mesa: mesa[0],
        pedido: {
          ...ultimoPedido[0],
          nombrePedido: ultimoPedido[0]?.nombrePedido || null
        },
        productos: productosConIngredientes,
        restaurante: restaurante[0] || null
      }
    }, 200)
  })

  .get('/list', authMiddleware, async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const mesas = await db.select()
      .from(MesaTable)
      .where(eq(MesaTable.restauranteId, restauranteId))

    return c.json({ message: 'Mesas encontradas correctamente', success: true, data: mesas }, 200)
  })

  .delete('/delete/:id', authMiddleware, async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const id = Number(c.req.param('id'))

    // Verificar que la mesa existe y pertenece al restaurante
    const mesa = await db.select()
      .from(MesaTable)
      .where(and(eq(MesaTable.id, id), eq(MesaTable.restauranteId, restauranteId)))

    if (!mesa || mesa.length === 0) {
      return c.json({ message: 'Mesa no encontrada', success: false }, 404)
    }
    // Obtener todos los pedidos de la mesa (incluidos los cerrados) para eliminar items y pagos
    const todosLosPedidos = await db.select()
      .from(PedidoTable)
      .where(eq(PedidoTable.mesaId, id))

    // Si hay pedidos, obtener sus IDs para eliminar pagos e items asociados
    if (todosLosPedidos.length > 0) {
      const pedidoIds = todosLosPedidos.map(pedido => pedido.id)

      // Eliminar pagos asociados a estos pedidos
      await db.delete(PagoTable).where(inArray(PagoTable.pedidoId, pedidoIds))

      // Eliminar items de pedido asociados
      await db.delete(ItemPedidoTable).where(inArray(ItemPedidoTable.pedidoId, pedidoIds))
    }

    // Eliminar pedidos asociados
    await db.delete(PedidoTable).where(eq(PedidoTable.mesaId, id))

    // Eliminar la mesa
    await db.delete(MesaTable).where(and(eq(MesaTable.id, id), eq(MesaTable.restauranteId, restauranteId)))

    return c.json({ message: 'Mesa eliminada correctamente', success: true }, 200)
  })

  // Obtener todas las mesas con su pedido actual (para el admin)
  .get('/list-with-pedidos', authMiddleware, async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id

    // Obtener todas las mesas del restaurante
    const mesas = await db.select()
      .from(MesaTable)
      .where(eq(MesaTable.restauranteId, restauranteId))

    if (mesas.length === 0) {
      return c.json({
        message: 'Mesas encontradas correctamente',
        success: true,
        data: []
      }, 200)
    }

    // Para cada mesa, obtener el último pedido con sus items
    const mesasConPedidos = await Promise.all(mesas.map(async (mesa) => {
      // Obtener el último pedido de esta mesa
      const ultimoPedido = await db.select()
        .from(PedidoTable)
        .where(eq(PedidoTable.mesaId, mesa.id))
        .orderBy(desc(PedidoTable.createdAt))
        .limit(1)

      let pedidoActual = ultimoPedido[0] || null
      let items: any[] = []

      // Si hay pedido, obtener sus items con info del producto
      if (pedidoActual) {
        const itemsRaw = await db
          .select({
            id: ItemPedidoTable.id,
            productoId: ItemPedidoTable.productoId,
            clienteNombre: ItemPedidoTable.clienteNombre,
            cantidad: ItemPedidoTable.cantidad,
            precioUnitario: ItemPedidoTable.precioUnitario,
            nombreProducto: ProductoTable.nombre,
            imagenUrl: ProductoTable.imagenUrl,
            ingredientesExcluidos: ItemPedidoTable.ingredientesExcluidos
          })
          .from(ItemPedidoTable)
          .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
          .where(eq(ItemPedidoTable.pedidoId, pedidoActual.id))

        // Helper para parsear JSON si viene como string
        const parseJsonField = (value: any): number[] | null => {
          if (!value) return null
          if (Array.isArray(value)) return value
          if (typeof value === 'string') {
            try {
              const parsed = JSON.parse(value)
              return Array.isArray(parsed) ? parsed : null
            } catch {
              return null
            }
          }
          return null
        }

        // Obtener nombres de ingredientes excluidos para cada item
        items = await Promise.all(
          itemsRaw.map(async (item) => {
            let ingredientesExcluidosNombres: string[] = []
            const ingredientesExcluidosParsed = parseJsonField(item.ingredientesExcluidos)

            if (ingredientesExcluidosParsed && ingredientesExcluidosParsed.length > 0) {
              const ingredientes = await db
                .select({
                  id: IngredienteTable.id,
                  nombre: IngredienteTable.nombre,
                })
                .from(IngredienteTable)
                .where(inArray(IngredienteTable.id, ingredientesExcluidosParsed))

              ingredientesExcluidosNombres = ingredientes.map(ing => ing.nombre)
            }

            return {
              ...item,
              ingredientesExcluidos: ingredientesExcluidosParsed || [],
              ingredientesExcluidosNombres
            }
          })
        )
      }

      return {
        ...mesa,
        pedidoActual,
        items,
        itemsCount: items.length,
        totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0)
      }
    }))

    return c.json({
      message: 'Mesas con pedidos encontradas correctamente',
      success: true,
      data: mesasConPedidos
    }, 200)
  })

  // Obtener detalle de una mesa específica con su pedido actual
  .get('/:id/pedido', authMiddleware, async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const mesaId = Number(c.req.param('id'))

    // Verificar que la mesa existe y pertenece al restaurante
    const mesa = await db.select()
      .from(MesaTable)
      .where(and(eq(MesaTable.id, mesaId), eq(MesaTable.restauranteId, restauranteId)))

    if (!mesa || mesa.length === 0) {
      return c.json({ message: 'Mesa no encontrada', success: false }, 404)
    }

    // Obtener el último pedido de esta mesa
    const ultimoPedido = await db.select()
      .from(PedidoTable)
      .where(eq(PedidoTable.mesaId, mesaId))
      .orderBy(desc(PedidoTable.createdAt))
      .limit(1)

    let pedidoActual = ultimoPedido[0] || null
    let items: any[] = []

    // Si hay pedido, obtener sus items con info del producto
    if (pedidoActual) {
      items = await db
        .select({
          id: ItemPedidoTable.id,
          productoId: ItemPedidoTable.productoId,
          clienteNombre: ItemPedidoTable.clienteNombre,
          cantidad: ItemPedidoTable.cantidad,
          precioUnitario: ItemPedidoTable.precioUnitario,
          nombreProducto: ProductoTable.nombre,
          imagenUrl: ProductoTable.imagenUrl
        })
        .from(ItemPedidoTable)
        .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
        .where(eq(ItemPedidoTable.pedidoId, pedidoActual.id))
    }

    return c.json({
      message: 'Pedido de mesa encontrado correctamente',
      success: true,
      data: {
        mesa: mesa[0],
        pedido: pedidoActual,
        items
      }
    }, 200)
  })

  // Resetear mesa: cierra el pedido actual y crea uno nuevo vacío
  .post('/:id/reset', authMiddleware, async (c) => {
    const db = drizzle(pool)
    const restauranteId = (c as any).user.id
    const mesaId = Number(c.req.param('id'))

    // Verificar que la mesa existe y pertenece al restaurante
    const mesa = await db.select()
      .from(MesaTable)
      .where(and(eq(MesaTable.id, mesaId), eq(MesaTable.restauranteId, restauranteId)))

    if (!mesa || mesa.length === 0) {
      return c.json({ message: 'Mesa no encontrada', success: false }, 404)
    }

    // Obtener el último pedido de esta mesa
    const ultimoPedido = await db.select()
      .from(PedidoTable)
      .where(eq(PedidoTable.mesaId, mesaId))
      .orderBy(desc(PedidoTable.createdAt))
      .limit(1)

    let pedidoAnteriorId: number | null = null

    // Si hay un pedido activo (no cerrado), cerrarlo
    if (ultimoPedido[0] && ultimoPedido[0].estado !== 'closed') {
      pedidoAnteriorId = ultimoPedido[0].id

      await db
        .update(PedidoTable)
        .set({
          estado: 'closed',
          closedAt: new Date()
        })
        .where(eq(PedidoTable.id, ultimoPedido[0].id))

      console.log(`🔒 Pedido ${ultimoPedido[0].id} cerrado por reset de mesa`)
    }

    // Crear nuevo pedido vacío
    const nuevoPedido = await db.insert(PedidoTable).values({
      mesaId,
      restauranteId,
      estado: 'pending',
      total: '0.00'
    })

    const nuevoPedidoId = Number(nuevoPedido[0].insertId)
    console.log(`🆕 Nuevo pedido ${nuevoPedidoId} creado para mesa ${mesaId}`)

    // Notificar a clientes conectados via WebSocket
    wsManager.broadcast(mesaId, {
      type: 'MESA_RESETEADA',
      payload: {
        pedidoAnteriorId,
        nuevoPedidoId,
        mensaje: 'La mesa ha sido reseteada por el administrador'
      }
    })

    // Notificar a admins
    wsManager.broadcastEstadoToAdmins(mesaId)

    return c.json({
      message: 'Mesa reseteada correctamente',
      success: true,
      data: {
        pedidoAnteriorId,
        nuevoPedidoId
      }
    }, 200)
  })

export { mesaRoute }