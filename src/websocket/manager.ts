// src/websocket/manager.ts
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, desc, and } from 'drizzle-orm';
import { pool } from '../db';
import {
  pedido as PedidoTable,
  itemPedido as ItemPedidoTable,
  producto as ProductoTable,
  mesa as MesaTable,
  ingrediente as IngredienteTable,
  notificacion as NotificacionTable,
  pagoSubtotal as PagoSubtotalTable
} from '../db/schema';
import { MesaSession, WebSocketMessage, ItemPedidoWS, AdminSession, AdminNotification, AdminNotificationType } from '../types/websocket';

// Definir tipo para estado de item
type ItemEstado = 'pending' | 'preparing' | 'delivered' | 'served' | 'cancelled';

class WebSocketManager {
  private sessions: Map<number, MesaSession> = new Map();
  private adminSessions: Map<number, AdminSession> = new Map(); // restauranteId -> AdminSession
  private mesaToRestaurante: Map<number, number> = new Map(); // mesaId -> restauranteId
  private db = drizzle(pool);

  // ==================== ADMIN METHODS ====================

  // Registrar conexión de admin
  addAdminConnection(restauranteId: number, ws: any) {
    let session = this.adminSessions.get(restauranteId);

    if (!session) {
      session = {
        restauranteId,
        connections: new Set()
      };
      this.adminSessions.set(restauranteId, session);
    }

    session.connections.add(ws);
    console.log(`🔑 Admin conectado - Restaurante: ${restauranteId}, Total conexiones: ${session.connections.size}`);

    return session;
  }

  // Remover conexión de admin
  removeAdminConnection(restauranteId: number, ws: any) {
    const session = this.adminSessions.get(restauranteId);
    if (!session) return;

    session.connections.delete(ws);
    console.log(`🔓 Admin desconectado - Restaurante: ${restauranteId}, Total conexiones: ${session.connections.size}`);

    if (session.connections.size === 0) {
      this.adminSessions.delete(restauranteId);
    }
  }

  // Enviar notificación a todos los admins de un restaurante y guardar en BD
  async notifyAdmins(restauranteId: number, notification: AdminNotification) {
    // Guardar notificación en la base de datos
    try {
      await this.db.insert(NotificacionTable).values({
        id: notification.id,
        restauranteId,
        tipo: notification.tipo as 'NUEVO_PEDIDO' | 'PEDIDO_CONFIRMADO' | 'PEDIDO_CERRADO' | 'LLAMADA_MOZO' | 'PAGO_RECIBIDO' | 'PRODUCTO_AGREGADO',
        mesaId: notification.mesaId,
        mesaNombre: notification.mesaNombre,
        pedidoId: notification.pedidoId,
        mensaje: notification.mensaje,
        detalles: notification.detalles,
        leida: false
      });
      console.log(`💾 Notificación guardada en BD: ${notification.id}`);
    } catch (error) {
      console.error('Error guardando notificación en BD:', error);
    }

    // Enviar a admins conectados
    const session = this.adminSessions.get(restauranteId);
    if (!session || session.connections.size === 0) return;

    const message = JSON.stringify({
      type: 'ADMIN_NOTIFICACION',
      payload: notification
    });

    console.log(`🔔 Enviando notificación a ${session.connections.size} admin(s): ${notification.tipo} - ${notification.mensaje}`);

    session.connections.forEach((client) => {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(message);
        } catch (error) {
          console.error('Error enviando notificación a admin:', error);
        }
      }
    });
  }

  // Obtener notificaciones del restaurante desde la BD
  async getNotificacionesRestaurante(restauranteId: number) {
    const notificaciones = await this.db
      .select()
      .from(NotificacionTable)
      .where(eq(NotificacionTable.restauranteId, restauranteId))
      .orderBy(desc(NotificacionTable.timestamp))
      .limit(100);

    return notificaciones;
  }

  // Crear notificación helper
  private createNotification(
    tipo: AdminNotificationType,
    mesaId: number,
    mesaNombre: string,
    mensaje: string,
    detalles?: string,
    pedidoId?: number
  ): AdminNotification {
    return {
      id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      tipo,
      mesaId,
      mesaNombre,
      pedidoId,
      mensaje,
      detalles,
      timestamp: new Date().toISOString(),
      leida: false
    };
  }

  // Obtener estado de todas las mesas de un restaurante
  async getEstadoMesasRestaurante(restauranteId: number) {
    const mesas = await this.db.select()
      .from(MesaTable)
      .where(eq(MesaTable.restauranteId, restauranteId));

    const mesasConPedido = await Promise.all(mesas.map(async (mesa) => {
      // Cache mesaId -> restauranteId
      this.mesaToRestaurante.set(mesa.id, restauranteId);

      const ultimoPedido = await this.db.select()
        .from(PedidoTable)
        .where(eq(PedidoTable.mesaId, mesa.id))
        .orderBy(desc(PedidoTable.createdAt))
        .limit(1);

      const pedido = ultimoPedido[0] || null;
      let items: any[] = [];

      if (pedido) {
        const itemsRaw = await this.db
          .select({
            id: ItemPedidoTable.id,
            productoId: ItemPedidoTable.productoId,
            clienteNombre: ItemPedidoTable.clienteNombre,
            cantidad: ItemPedidoTable.cantidad,
            precioUnitario: ItemPedidoTable.precioUnitario,
            nombreProducto: ProductoTable.nombre,
            imagenUrl: ProductoTable.imagenUrl,
            ingredientesExcluidos: ItemPedidoTable.ingredientesExcluidos,
            postConfirmacion: ItemPedidoTable.postConfirmacion,
            estado: ItemPedidoTable.estado
          })
          .from(ItemPedidoTable)
          .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
          .where(eq(ItemPedidoTable.pedidoId, pedido.id));

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
              const { inArray } = await import('drizzle-orm')
              const ingredientes = await this.db
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
              ingredientesExcluidosNombres,
              postConfirmacion: item.postConfirmacion || false,
              estado: item.estado || 'pending'
            }
          })
        )
      }

      // Get connected clients from session
      const session = this.sessions.get(mesa.id);
      const clientesConectados = session?.clientes.filter(
        c => !c.id.startsWith('admin-') && !c.nombre.includes('Admin')
      ) || [];

      // Si el pedido está cerrado, verificar si todos pagaron
      let todosPagaron = false;
      if (pedido && pedido.estado === 'closed') {
        todosPagaron = await this.verificarTodosPagaron(pedido.id);
      }

      return {
        id: mesa.id,
        nombre: mesa.nombre,
        qrToken: mesa.qrToken,
        pedido: pedido ? {
          ...pedido,
          nombrePedido: pedido.nombrePedido || null
        } : null,
        items,
        clientesConectados,
        totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0),
        todosPagaron // Información adicional para el admin
      };
    }));

    return mesasConPedido;
  }

  // Broadcast estado actualizado a admins
  async broadcastEstadoToAdmins(mesaId: number) {
    let restauranteId = this.mesaToRestaurante.get(mesaId);

    if (!restauranteId) {
      // Buscar en BD
      const mesa = await this.db.select()
        .from(MesaTable)
        .where(eq(MesaTable.id, mesaId))
        .limit(1);

      if (mesa[0]?.restauranteId) {
        restauranteId = mesa[0].restauranteId;
        this.mesaToRestaurante.set(mesaId, restauranteId);
      }
    }

    if (!restauranteId) return;

    const session = this.adminSessions.get(restauranteId);
    if (!session || session.connections.size === 0) return;

    const estadoMesas = await this.getEstadoMesasRestaurante(restauranteId);

    const message = JSON.stringify({
      type: 'ADMIN_ESTADO_MESAS',
      payload: { mesas: estadoMesas }
    });

    session.connections.forEach((client) => {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (error) {
          console.error('Error enviando estado a admin:', error);
        }
      }
    });
  }

  // ==================== MESA/CLIENT METHODS ====================

  // Agregar cliente a la sesión de la mesa
  async addClient(mesaId: number, pedidoId: number, ws: any, clienteId: string, nombre: string) {
    let session = this.sessions.get(mesaId);

    if (!session) {
      session = {
        mesaId,
        pedidoId,
        clientes: [],
        connections: new Set()
      };
      this.sessions.set(mesaId, session);
    }

    // Actualizar pedidoId si es diferente (nuevo pedido creado)
    session.pedidoId = pedidoId;

    session.connections.add(ws);

    // Agregar cliente si no existe (y no es admin)
    const isAdmin = clienteId.startsWith('admin-') || nombre.includes('Admin');
    if (!isAdmin && !session.clientes.find(c => c.id === clienteId)) {
      session.clientes.push({
        id: clienteId,
        nombre,
        socketId: clienteId
      });

      // Verificar si es modo carrito y asignar nombrePedido si es el primer cliente
      await this.asignarNombrePedidoSiCarrito(mesaId, pedidoId, nombre);

      // Solo actualizar estado de mesas para admins (sin notificación)
      // Las conexiones/desconexiones de clientes no generan notificaciones
      this.broadcastEstadoToAdmins(mesaId);
    }

    return session;
  }

  // Asignar nombre al pedido si es modo carrito y aún no tiene nombre
  private async asignarNombrePedidoSiCarrito(mesaId: number, pedidoId: number, nombreCliente: string) {
    try {
      // Obtener la mesa para saber el restaurante
      const mesa = await this.db.select()
        .from(MesaTable)
        .where(eq(MesaTable.id, mesaId))
        .limit(1);

      if (!mesa[0]?.restauranteId) return;

      // Importamos restaurante table
      const { restaurante: RestauranteTable } = await import('../db/schema');

      // Verificar si el restaurante está en modo carrito
      const restaurante = await this.db.select({
        esCarrito: RestauranteTable.esCarrito
      })
        .from(RestauranteTable)
        .where(eq(RestauranteTable.id, mesa[0].restauranteId))
        .limit(1);

      if (!restaurante[0]?.esCarrito) return;

      // Verificar si el pedido ya tiene nombre asignado
      const pedido = await this.db.select({
        nombrePedido: PedidoTable.nombrePedido
      })
        .from(PedidoTable)
        .where(eq(PedidoTable.id, pedidoId))
        .limit(1);

      if (pedido[0]?.nombrePedido) return; // Ya tiene nombre

      // Asignar el nombre del primer cliente al pedido
      await this.db.update(PedidoTable)
        .set({ nombrePedido: nombreCliente })
        .where(eq(PedidoTable.id, pedidoId));

      console.log(`🛒 [Carrito] Pedido ${pedidoId} asignado a "${nombreCliente}"`);

      // Notificar a todos los clientes conectados sobre el nombre del pedido
      this.broadcast(mesaId, {
        type: 'NOMBRE_PEDIDO_ASIGNADO',
        payload: {
          nombrePedido: nombreCliente,
          pedidoId
        }
      } as any);

    } catch (error) {
      console.error('Error asignando nombre de pedido en modo carrito:', error);
    }
  }

  // Marcar pedido como listo para retirar (modo carrito)
  async marcarPedidoListo(pedidoId: number, mesaId: number) {
    try {
      console.log(`🛒 [Carrito] Pedido ${pedidoId} marcado como LISTO para retirar`);

      // Broadcast a todos los clientes conectados
      this.broadcast(mesaId, {
        type: 'PEDIDO_LISTO_PARA_RETIRAR',
        payload: {
          pedidoId
        }
      } as any);

      // También notificar a los admins
      this.broadcastEstadoToAdmins(mesaId);

    } catch (error) {
      console.error('Error marcando pedido como listo:', error);
    }
  }

  // Remover cliente
  removeClient(mesaId: number, clienteId: string | undefined, ws: any) {
    const session = this.sessions.get(mesaId);
    if (!session) return;

    session.connections.delete(ws);

    // Remover cliente de la lista si existe
    const isAdmin = clienteId?.startsWith('admin-');
    if (clienteId && !isAdmin) {
      const clienteExistia = session.clientes.some(c => c.id === clienteId);
      session.clientes = session.clientes.filter(c => c.id !== clienteId);

      // Si hay una confirmación grupal activa, actualizar
      if (clienteExistia && session.confirmacionGrupal?.activa) {
        this.actualizarConfirmacionPorDesconexion(mesaId, clienteId);
      }

      // Solo actualizar estado de mesas para admins (sin notificación)
      if (clienteExistia) {
        this.broadcastEstadoToAdmins(mesaId);
      }
    }

    // Si no quedan conexiones, limpiar la sesión
    if (session.connections.size === 0) {
      this.sessions.delete(mesaId);
    }
  }

  // Broadcast a todos los clientes de una mesa
  broadcast(mesaId: number, message: WebSocketMessage, excludeWs?: any) {
    const session = this.sessions.get(mesaId);
    if (!session) return;

    const messageStr = JSON.stringify(message);

    session.connections.forEach((client) => {
      if (client !== excludeWs && client.readyState === 1) { // 1 = OPEN
        try {
          client.send(messageStr);
        } catch (error) {
          console.error('Error sending message:', error);
        }
      }
    });
  }

  // Obtener estado inicial del pedido
  async getEstadoInicial(pedidoId: number) {
    const items = await this.db
      .select({
        id: ItemPedidoTable.id,
        productoId: ItemPedidoTable.productoId,
        clienteNombre: ItemPedidoTable.clienteNombre,
        cantidad: ItemPedidoTable.cantidad,
        precioUnitario: ItemPedidoTable.precioUnitario,
        nombreProducto: ProductoTable.nombre,
        imagenUrl: ProductoTable.imagenUrl,
        ingredientesExcluidos: ItemPedidoTable.ingredientesExcluidos,
        postConfirmacion: ItemPedidoTable.postConfirmacion,
        estado: ItemPedidoTable.estado
      })
      .from(ItemPedidoTable)
      .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
      .where(eq(ItemPedidoTable.pedidoId, pedidoId));

    // Obtener nombres de ingredientes excluidos para cada item
    const itemsConIngredientes = await Promise.all(
      (items || []).map(async (item) => {
        let ingredientesExcluidosNombres: string[] = []

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

        const ingredientesExcluidosParsed = parseJsonField(item.ingredientesExcluidos)

        if (ingredientesExcluidosParsed && ingredientesExcluidosParsed.length > 0) {
          const { inArray } = await import('drizzle-orm')
          const ingredientes = await this.db
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
          ingredientesExcluidosNombres,
          postConfirmacion: item.postConfirmacion || false,
          estado: item.estado || 'pending'
        }
      })
    )

    const pedidoInfo = await this.db
      .select()
      .from(PedidoTable)
      .where(eq(PedidoTable.id, pedidoId))
      .limit(1);

    return {
      pedido: pedidoInfo[0] || null,
      items: itemsConIngredientes || []
    };
  }

  // Agregar item al pedido
  async agregarItem(pedidoId: number, mesaId: number, item: ItemPedidoWS) {
    // Verificar estado del pedido para determinar si es post-confirmación
    const pedidoActual = await this.db
      .select({ estado: PedidoTable.estado })
      .from(PedidoTable)
      .where(eq(PedidoTable.id, pedidoId))
      .limit(1);

    const isPostConfirmacion = ['preparing', 'delivered', 'served'].includes(pedidoActual[0]?.estado || '');

    // Insertar en la BD
    const result = await this.db.insert(ItemPedidoTable).values({
      pedidoId,
      productoId: item.productoId,
      clienteNombre: item.clienteNombre,
      cantidad: item.cantidad,
      precioUnitario: item.precioUnitario,
      ingredientesExcluidos: item.ingredientesExcluidos || null,
      postConfirmacion: isPostConfirmacion,
      estado: isPostConfirmacion ? 'preparing' : 'pending'
    });

    // Recalcular total del pedido
    await this.recalcularTotal(pedidoId);

    // Obtener el item completo con info del producto
    const itemCompleto = await this.db
      .select({
        id: ItemPedidoTable.id,
        productoId: ItemPedidoTable.productoId,
        clienteNombre: ItemPedidoTable.clienteNombre,
        cantidad: ItemPedidoTable.cantidad,
        precioUnitario: ItemPedidoTable.precioUnitario,
        nombreProducto: ProductoTable.nombre,
        imagenUrl: ProductoTable.imagenUrl,
        ingredientesExcluidos: ItemPedidoTable.ingredientesExcluidos,
        postConfirmacion: ItemPedidoTable.postConfirmacion,
        estado: ItemPedidoTable.estado
      })
      .from(ItemPedidoTable)
      .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
      .where(eq(ItemPedidoTable.id, Number(result[0].insertId)))
      .limit(1);

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

    // Obtener nombres de ingredientes excluidos
    let ingredientesExcluidosNombres: string[] = []
    const ingredientesExcluidosParsed = parseJsonField(itemCompleto[0].ingredientesExcluidos)

    if (ingredientesExcluidosParsed && ingredientesExcluidosParsed.length > 0) {
      const { inArray } = await import('drizzle-orm')
      const ingredientes = await this.db
        .select({
          id: IngredienteTable.id,
          nombre: IngredienteTable.nombre,
        })
        .from(IngredienteTable)
        .where(inArray(IngredienteTable.id, ingredientesExcluidosParsed))

      ingredientesExcluidosNombres = ingredientes.map(ing => ing.nombre)
    }

    const itemCompletoConNombres = {
      ...itemCompleto[0],
      ingredientesExcluidos: ingredientesExcluidosParsed || [],
      ingredientesExcluidosNombres,
      postConfirmacion: itemCompleto[0].postConfirmacion || false,
      estado: itemCompleto[0].estado || 'pending'
    }

    // Broadcast a toda la mesa
    const estadoActual = await this.getEstadoInicial(pedidoId);
    this.broadcast(mesaId, {
      type: 'PEDIDO_ACTUALIZADO',
      payload: {
        items: estadoActual.items,
        pedido: estadoActual.pedido,
        nuevoItem: itemCompletoConNombres
      }
    });

    // Obtener info de la mesa para notificar admins
    const mesa = await this.db.select().from(MesaTable).where(eq(MesaTable.id, mesaId)).limit(1);

    // Si el pedido está confirmado (preparing o delivered), enviar notificación push
    if (estadoActual.pedido && ['preparing', 'delivered', 'served'].includes(estadoActual.pedido.estado || '')) {
      if (mesa[0]?.restauranteId) {
        const nombreProducto = itemCompletoConNombres.nombreProducto || 'Producto';
        const cantidad = itemCompletoConNombres.cantidad || 1;
        const clienteNombre = itemCompletoConNombres.clienteNombre || 'Cliente';

        this.notifyAdmins(mesa[0].restauranteId, this.createNotification(
          'PRODUCTO_AGREGADO',
          mesaId,
          mesa[0].nombre,
          `Nuevo producto agregado`,
          `${clienteNombre} agregó ${cantidad}x ${nombreProducto}`,
          pedidoId
        ));
      }
    }

    // SIEMPRE actualizar estado de mesas para admins (incluyendo pedidos pending)
    this.broadcastEstadoToAdmins(mesaId);

    return itemCompletoConNombres;
  }

  // Eliminar item del pedido
  async eliminarItem(itemId: number, pedidoId: number, mesaId: number) {
    await this.db
      .delete(ItemPedidoTable)
      .where(eq(ItemPedidoTable.id, itemId));

    await this.recalcularTotal(pedidoId);

    const estadoActual = await this.getEstadoInicial(pedidoId);
    this.broadcast(mesaId, {
      type: 'PEDIDO_ACTUALIZADO',
      payload: {
        items: estadoActual.items,
        pedido: estadoActual.pedido,
        itemEliminadoId: itemId
      }
    });

    // Notificar a admins
    this.broadcastEstadoToAdmins(mesaId);
  }

  // Actualizar cantidad de un item
  async actualizarCantidad(itemId: number, cantidad: number, pedidoId: number, mesaId: number) {
    if (cantidad <= 0) {
      await this.eliminarItem(itemId, pedidoId, mesaId);
      return;
    }

    await this.db
      .update(ItemPedidoTable)
      .set({ cantidad })
      .where(eq(ItemPedidoTable.id, itemId));

    await this.recalcularTotal(pedidoId);

    const estadoActual = await this.getEstadoInicial(pedidoId);
    this.broadcast(mesaId, {
      type: 'PEDIDO_ACTUALIZADO',
      payload: {
        items: estadoActual.items,
        pedido: estadoActual.pedido
      }
    });

    // Notificar a admins
    this.broadcastEstadoToAdmins(mesaId);
  }

  // Actualizar estado de un item
  async actualizarEstadoItem(itemId: number, estado: string, pedidoId: number, mesaId: number) {
    if (mesaId) {
      if (!this.mesaToRestaurante.has(mesaId)) {
        const restauranteId = await this.getRestauranteIdFromMesa(mesaId);
        if (restauranteId) this.mesaToRestaurante.set(mesaId, restauranteId);
      }
    }

    await this.db
      .update(ItemPedidoTable)
      .set({ estado: estado as any })
      .where(eq(ItemPedidoTable.id, itemId));

    const estadoActual = await this.getEstadoInicial(pedidoId);
    this.broadcast(mesaId, {
      type: 'PEDIDO_ACTUALIZADO',
      payload: {
        items: estadoActual.items,
        pedido: estadoActual.pedido,
        itemActualizadoId: itemId
      }
    });

    // Notificar admin
    this.broadcastEstadoToAdmins(mesaId);
  }

  // Método auxiliar para obtener restauranteId
  private async getRestauranteIdFromMesa(mesaId: number): Promise<number | null> {
    const mesa = await this.db.select().from(MesaTable).where(eq(MesaTable.id, mesaId)).limit(1);
    return mesa[0]?.restauranteId || null;
  }

  // Recalcular el total del pedido
  private async recalcularTotal(pedidoId: number) {
    const items = await this.db
      .select()
      .from(ItemPedidoTable)
      .where(eq(ItemPedidoTable.pedidoId, pedidoId));

    const total = items.reduce((sum, item) => {
      return sum + (Number(item.precioUnitario) * (item.cantidad || 1));
    }, 0);

    await this.db
      .update(PedidoTable)
      .set({ total: total.toFixed(2) })
      .where(eq(PedidoTable.id, pedidoId));
  }

  // Confirmar pedido (cambiar estado a preparing)
  async confirmarPedido(pedidoId: number, mesaId: number) {
    console.log(`✅ [confirmarPedido] INICIO - pedidoId=${pedidoId}, mesaId=${mesaId}`);

    await this.db
      .update(PedidoTable)
      .set({ estado: 'preparing' })
      .where(eq(PedidoTable.id, pedidoId));

    // También actualizar el estado de todos los items pendientes a preparing
    await this.db
      .update(ItemPedidoTable)
      .set({ estado: 'preparing' })
      .where(and(
        eq(ItemPedidoTable.pedidoId, pedidoId),
        eq(ItemPedidoTable.estado, 'pending')
      ));

    const estadoActual = await this.getEstadoInicial(pedidoId);
    console.log(`✅ [confirmarPedido] Estado actual: total=${estadoActual.pedido?.total}, items=${estadoActual.items.length}`);

    // Enviar mensaje específico de confirmación
    this.broadcast(mesaId, {
      type: 'PEDIDO_CONFIRMADO',
      payload: {
        items: estadoActual.items,
        pedido: estadoActual.pedido
      }
    });

    // Notificar a admins
    const mesa = await this.db.select().from(MesaTable).where(eq(MesaTable.id, mesaId)).limit(1);
    if (mesa[0]?.restauranteId) {
      console.log(`✅ [confirmarPedido] Enviando notificación a restaurante ${mesa[0].restauranteId}`);
      this.notifyAdmins(mesa[0].restauranteId, this.createNotification(
        'PEDIDO_CONFIRMADO',
        mesaId,
        mesa[0].nombre,
        `Nuevo pedido confirmado`,
        `Total: $${estadoActual.pedido?.total || '0.00'} - ${estadoActual.items.length} productos`,
        pedidoId
      ));
      this.broadcastEstadoToAdmins(mesaId);
    }

    console.log(`✅ [confirmarPedido] FIN`);
  }

  // Cerrar pedido (cambiar estado a closed)
  async cerrarPedido(pedidoId: number, mesaId: number) {
    console.log(`🔒 [cerrarPedido] INICIO - pedidoId=${pedidoId}, mesaId=${mesaId}`);

    const estadoAntes = await this.getEstadoInicial(pedidoId);
    console.log(`🔒 [cerrarPedido] Estado antes: total=${estadoAntes.pedido?.total}`);

    await this.db
      .update(PedidoTable)
      .set({
        estado: 'closed',
        closedAt: new Date()
      })
      .where(eq(PedidoTable.id, pedidoId));

    const estadoActual = await this.getEstadoInicial(pedidoId);

    this.broadcast(mesaId, {
      type: 'PEDIDO_CERRADO',
      payload: {
        items: estadoActual.items,
        pedido: estadoActual.pedido
      }
    });

    // Notificar a admins
    const mesa = await this.db.select().from(MesaTable).where(eq(MesaTable.id, mesaId)).limit(1);
    if (mesa[0]?.restauranteId) {
      console.log(`🔒 [cerrarPedido] Enviando notificación a restaurante ${mesa[0].restauranteId}`);
      this.notifyAdmins(mesa[0].restauranteId, this.createNotification(
        'PEDIDO_CERRADO',
        mesaId,
        mesa[0].nombre,
        `Pedido cerrado`,
        `Total: $${estadoAntes.pedido?.total || '0.00'}`,
        pedidoId
      ));
      this.broadcastEstadoToAdmins(mesaId);
    }

    console.log(`🔒 [cerrarPedido] FIN`);
  }

  // Llamar al mozo (solo notificación)
  async llamarMozo(mesaId: number, clienteNombre: string) {
    // Notificar a admins
    const mesa = await this.db.select().from(MesaTable).where(eq(MesaTable.id, mesaId)).limit(1);
    if (mesa[0]?.restauranteId) {
      this.notifyAdmins(mesa[0].restauranteId, this.createNotification(
        'LLAMADA_MOZO',
        mesaId,
        mesa[0].nombre,
        `¡Llamada de mozo!`,
        `${clienteNombre} necesita asistencia`
      ));
    }

    return { success: true, message: 'Mozo notificado' };
  }

  // Pagar pedido
  async pagarPedido(pedidoId: number, mesaId: number, metodo: 'efectivo' | 'mercadopago', totalFromClient?: string) {
    console.log(`💳 [pagarPedido] pedidoId=${pedidoId}, mesaId=${mesaId}, metodo=${metodo}, totalFromClient=${totalFromClient}`);

    // Obtener el estado actual del pedido
    const estadoActual = await this.getEstadoInicial(pedidoId);

    // Obtener el total: primero del cliente, luego del pedido en BD
    let total = totalFromClient;
    let pedidoIdParaNotificacion = pedidoId; // ID del pedido para la notificación

    if (!total || total === '0.00' || total === '0') {
      total = estadoActual.pedido?.total || '0.00';
      console.log(`💳 [pagarPedido] Total from DB: ${total}`);
    }

    // Si aún es 0, buscar el último pedido cerrado de esta mesa
    // (esto pasa cuando el cliente se reconectó y tiene el pedidoId del nuevo pedido vacío)
    if (!total || total === '0.00' || total === '0') {
      const ultimosPedidos = await this.db
        .select()
        .from(PedidoTable)
        .where(eq(PedidoTable.mesaId, mesaId))
        .orderBy(desc(PedidoTable.createdAt))
        .limit(2); // Obtener los 2 últimos (el actual vacío y el anterior cerrado)

      // Buscar el pedido cerrado con total > 0
      const pedidoConTotal = ultimosPedidos.find(p =>
        parseFloat(p.total || '0') > 0
      );
      if (pedidoConTotal) {
        total = pedidoConTotal.total || '0.00';
        pedidoIdParaNotificacion = pedidoConTotal.id; // Usar el ID del pedido correcto
        console.log(`💳 [pagarPedido] Total from last closed order ${pedidoConTotal.id}: ${total}`);
      }
    }

    console.log(`💳 [pagarPedido] Final total: ${total}, pedidoId para notificación: ${pedidoIdParaNotificacion}`);

    // Broadcast a todos los clientes de la mesa para redirigir a factura
    this.broadcast(mesaId, {
      type: 'PEDIDO_PAGADO',
      payload: {
        items: estadoActual.items,
        pedido: estadoActual.pedido,
        metodo: metodo,
        total: total
      }
    });

    // Notificar a admins
    const mesa = await this.db.select().from(MesaTable).where(eq(MesaTable.id, mesaId)).limit(1);
    if (mesa[0]?.restauranteId) {
      this.notifyAdmins(mesa[0].restauranteId, this.createNotification(
        'PAGO_RECIBIDO',
        mesaId,
        mesa[0].nombre,
        `Pago ${metodo === 'efectivo' ? 'en efectivo' : 'con MercadoPago'}`,
        `Total: $${total}`,
        pedidoIdParaNotificacion // Usar el ID del pedido correcto
      ));
      this.broadcastEstadoToAdmins(mesaId);
    }

    return { success: true, message: 'Pago registrado' };
  }

  // ==================== CONFIRMACIÓN GRUPAL ====================

  // Iniciar proceso de confirmación grupal
  iniciarConfirmacion(mesaId: number, clienteId: string, clienteNombre: string) {
    const session = this.sessions.get(mesaId);
    if (!session) {
      console.error('❌ [iniciarConfirmacion] Sesión no encontrada para mesa:', mesaId);
      return null;
    }

    // Si ya hay una confirmación activa, no iniciar otra
    if (session.confirmacionGrupal?.activa) {
      console.log('⚠️ [iniciarConfirmacion] Ya hay una confirmación activa');
      return session.confirmacionGrupal;
    }

    // Crear estado de confirmación para cada cliente conectado
    const confirmaciones = session.clientes.map(c => ({
      clienteId: c.id,
      nombre: c.nombre,
      confirmado: c.id === clienteId // El que inicia ya confirma automáticamente
    }));

    session.confirmacionGrupal = {
      activa: true,
      iniciadaPor: clienteId,
      iniciadaPorNombre: clienteNombre,
      confirmaciones,
      timestamp: new Date().toISOString()
    };

    console.log(`🔔 [iniciarConfirmacion] ${clienteNombre} inició confirmación en mesa ${mesaId}`);
    console.log(`   Clientes: ${confirmaciones.map(c => `${c.nombre}(${c.confirmado ? '✓' : '○'})`).join(', ')}`);

    // Notificar a todos los clientes
    this.broadcast(mesaId, {
      type: 'CONFIRMACION_INICIADA',
      payload: {
        confirmacionGrupal: session.confirmacionGrupal
      }
    });

    // Verificar si solo hay un cliente (confirmar automáticamente)
    this.verificarConfirmacionCompleta(mesaId);

    return session.confirmacionGrupal;
  }

  // Usuario confirma su parte
  usuarioConfirma(mesaId: number, clienteId: string) {
    const session = this.sessions.get(mesaId);
    if (!session || !session.confirmacionGrupal?.activa) {
      console.error('❌ [usuarioConfirma] No hay confirmación activa');
      return null;
    }

    const confirmacion = session.confirmacionGrupal.confirmaciones.find(c => c.clienteId === clienteId);
    if (confirmacion) {
      confirmacion.confirmado = true;
      console.log(`✅ [usuarioConfirma] ${confirmacion.nombre} confirmó en mesa ${mesaId}`);
    }

    // Notificar actualización a todos
    this.broadcast(mesaId, {
      type: 'CONFIRMACION_ACTUALIZADA',
      payload: {
        confirmacionGrupal: session.confirmacionGrupal
      }
    });

    // Verificar si todos confirmaron
    this.verificarConfirmacionCompleta(mesaId);

    return session.confirmacionGrupal;
  }

  // Usuario cancela (cancela para todos)
  usuarioCancela(mesaId: number, clienteId: string, clienteNombre: string) {
    const session = this.sessions.get(mesaId);
    if (!session || !session.confirmacionGrupal?.activa) {
      console.error('❌ [usuarioCancela] No hay confirmación activa');
      return;
    }

    console.log(`❌ [usuarioCancela] ${clienteNombre} canceló la confirmación en mesa ${mesaId}`);

    // Limpiar estado de confirmación
    session.confirmacionGrupal = undefined;

    // Notificar a todos que se canceló
    this.broadcast(mesaId, {
      type: 'CONFIRMACION_CANCELADA',
      payload: {
        canceladoPor: clienteNombre
      }
    });
  }

  // Verificar si todos confirmaron
  private async verificarConfirmacionCompleta(mesaId: number) {
    const session = this.sessions.get(mesaId);
    if (!session || !session.confirmacionGrupal?.activa) return;

    const { confirmaciones } = session.confirmacionGrupal;
    const todosConfirmaron = confirmaciones.every(c => c.confirmado);

    console.log(`🔍 [verificarConfirmacion] Mesa ${mesaId}: ${confirmaciones.filter(c => c.confirmado).length}/${confirmaciones.length} confirmaron`);

    if (todosConfirmaron) {
      console.log(`🎉 [verificarConfirmacion] ¡Todos confirmaron! Confirmando pedido...`);

      // Limpiar estado de confirmación
      session.confirmacionGrupal = undefined;

      // Confirmar el pedido
      await this.confirmarPedido(session.pedidoId, mesaId);
    }
  }

  // Cuando un cliente se desconecta, actualizar la confirmación grupal
  actualizarConfirmacionPorDesconexion(mesaId: number, clienteId: string) {
    const session = this.sessions.get(mesaId);
    if (!session || !session.confirmacionGrupal?.activa) return;

    // Remover al cliente de las confirmaciones pendientes
    session.confirmacionGrupal.confirmaciones = session.confirmacionGrupal.confirmaciones.filter(
      c => c.clienteId !== clienteId
    );

    console.log(`👋 [actualizarConfirmacionPorDesconexion] Cliente ${clienteId} removido de confirmación`);

    // Si no quedan clientes, cancelar la confirmación
    if (session.confirmacionGrupal.confirmaciones.length === 0) {
      session.confirmacionGrupal = undefined;
      this.broadcast(mesaId, {
        type: 'CONFIRMACION_CANCELADA',
        payload: {
          canceladoPor: 'Sistema (sin clientes)'
        }
      });
      return;
    }

    // Notificar actualización
    this.broadcast(mesaId, {
      type: 'CONFIRMACION_ACTUALIZADA',
      payload: {
        confirmacionGrupal: session.confirmacionGrupal
      }
    });

    // Verificar si los restantes ya confirmaron
    this.verificarConfirmacionCompleta(mesaId);
  }

  // Notificar subtotales pagados (split payment)
  async notificarSubtotalesPagados(
    pedidoId: number,
    mesaId: number,
    clientesPagados: string[],
    todosSubtotales: Array<{
      clienteNombre: string
      monto: string
      estado: string
      metodo: string | null
    }>
  ) {
    console.log(`💳 [notificarSubtotalesPagados] pedidoId=${pedidoId}, mesaId=${mesaId}, clientes=${clientesPagados.join(', ')}`);

    // Broadcast a todos los clientes de la mesa
    this.broadcast(mesaId, {
      type: 'SUBTOTALES_ACTUALIZADOS',
      payload: {
        pedidoId,
        clientesPagados,
        todosSubtotales
      }
    });

    // Notificar a admins
    const mesa = await this.db.select().from(MesaTable).where(eq(MesaTable.id, mesaId)).limit(1);
    if (mesa[0]?.restauranteId) {
      // Calcular el total pagado
      const totalPagado = todosSubtotales
        .filter(s => s.estado === 'paid')
        .reduce((sum, s) => sum + parseFloat(s.monto), 0);

      const metodo = todosSubtotales.find(s =>
        clientesPagados.includes(s.clienteNombre) && s.estado === 'paid'
      )?.metodo || 'efectivo';

      this.notifyAdmins(mesa[0].restauranteId, this.createNotification(
        'PAGO_RECIBIDO',
        mesaId,
        mesa[0].nombre,
        `Pago parcial ${metodo === 'efectivo' ? 'en efectivo' : 'con MercadoPago'}`,
        `${clientesPagados.join(', ')} pagó su parte. Total pagado: $${totalPagado.toFixed(2)}`,
        pedidoId
      ));

      // También enviar actualización específica de subtotales a admins
      const session = this.adminSessions.get(mesa[0].restauranteId);
      if (session && session.connections.size > 0) {
        const message = JSON.stringify({
          type: 'ADMIN_SUBTOTALES_ACTUALIZADOS',
          payload: {
            pedidoId,
            mesaId,
            mesaNombre: mesa[0].nombre,
            clientesPagados,
            todosSubtotales
          }
        });

        session.connections.forEach((client) => {
          if (client.readyState === 1) {
            try {
              client.send(message);
            } catch (error) {
              console.error('Error enviando actualización de subtotales a admin:', error);
            }
          }
        });
      }

      this.broadcastEstadoToAdmins(mesaId);
    }

    return { success: true, message: 'Subtotales notificados' };
  }

  getSession(mesaId: number) {
    return this.sessions.get(mesaId);
  }

  getAdminSession(restauranteId: number) {
    return this.adminSessions.get(restauranteId);
  }

  // Verificar si todos los clientes de un pedido cerrado ya pagaron
  async verificarTodosPagaron(pedidoId: number): Promise<boolean> {
    try {
      // Obtener todos los items del pedido para calcular subtotales por cliente
      const items = await this.db
        .select({
          clienteNombre: ItemPedidoTable.clienteNombre,
          cantidad: ItemPedidoTable.cantidad,
          precioUnitario: ItemPedidoTable.precioUnitario,
        })
        .from(ItemPedidoTable)
        .where(eq(ItemPedidoTable.pedidoId, pedidoId)) as any;

      if (items.length === 0) {
        // Si no hay items, no hay nada que pagar, así que "todos pagaron"
        return true;
      }

      // Calcular subtotal por cliente
      const subtotalesPorCliente: Record<string, number> = {};
      for (const item of items) {
        // Para items de Mozo, usamos el ID único del item como clave
        // Para otros clientes, usamos el nombre del cliente
        let key = item.clienteNombre;
        if (key === 'Mozo') {
          // IMPORTANTE: Esta clave debe coincidir con la usada en crear-preferencia y pago-efectivo
          key = `Mozo:item:${item.id}`; // Nota: id del ItemPedido
        }

        if (!subtotalesPorCliente[key]) {
          subtotalesPorCliente[key] = 0;
        }
        subtotalesPorCliente[key] += parseFloat(item.precioUnitario) * (item.cantidad || 1);
      }

      // Obtener todos los pagos de subtotales pagados para este pedido
      const pagosSubtotales = await this.db
        .select()
        .from(PagoSubtotalTable)
        .where(and(
          eq(PagoSubtotalTable.pedidoId, pedidoId),
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

      // Verificar que cada cliente haya pagado al menos su subtotal (con margen de redondeo)
      for (const [clienteNombre, subtotal] of Object.entries(subtotalesPorCliente)) {
        const pagado = pagadoPorCliente[clienteNombre] || 0;
        // Permitir pequeña diferencia por redondeo (0.01)
        if (pagado < subtotal - 0.01) {
          return false; // Al menos un cliente no pagó completamente
        }
      }

      return true; // Todos pagaron
    } catch (error) {
      console.error('Error verificando si todos pagaron:', error);
      return false; // En caso de error, asumir que no todos pagaron
    }
  }
}

export const wsManager = new WebSocketManager();
