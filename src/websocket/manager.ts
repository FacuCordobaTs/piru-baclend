// src/websocket/manager.ts
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, desc } from 'drizzle-orm';
import { pool } from '../db';
import { 
  pedido as PedidoTable, 
  itemPedido as ItemPedidoTable,
  producto as ProductoTable,
  mesa as MesaTable
} from '../db/schema';
import { MesaSession, WebSocketMessage, ItemPedidoWS, AdminSession, AdminNotification, AdminNotificationType } from '../types/websocket';

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

  // Enviar notificación a todos los admins de un restaurante
  notifyAdmins(restauranteId: number, notification: AdminNotification) {
    const session = this.adminSessions.get(restauranteId);
    if (!session) return;

    const message = JSON.stringify({
      type: 'ADMIN_NOTIFICACION',
      payload: notification
    });

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
        items = await this.db
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
          .where(eq(ItemPedidoTable.pedidoId, pedido.id));
      }

      // Get connected clients from session
      const session = this.sessions.get(mesa.id);
      const clientesConectados = session?.clientes.filter(
        c => !c.id.startsWith('admin-') && !c.nombre.includes('Admin')
      ) || [];

      return {
        id: mesa.id,
        nombre: mesa.nombre,
        qrToken: mesa.qrToken,
        pedido,
        items,
        clientesConectados,
        totalItems: items.reduce((sum, item) => sum + (item.cantidad || 1), 0)
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

      // Notificar a admins
      const mesa = await this.db.select().from(MesaTable).where(eq(MesaTable.id, mesaId)).limit(1);
      if (mesa[0]?.restauranteId) {
        this.notifyAdmins(mesa[0].restauranteId, this.createNotification(
          'CLIENTE_CONECTADO',
          mesaId,
          mesa[0].nombre,
          `${nombre} se conectó`,
          `${session.clientes.length} cliente(s) en la mesa`,
          pedidoId
        ));
        this.broadcastEstadoToAdmins(mesaId);
      }
    }

    return session;
  }

  // Remover cliente
  async removeClient(mesaId: number, clienteId: string | undefined, ws: any) {
    const session = this.sessions.get(mesaId);
    if (!session) return;

    session.connections.delete(ws);
    
    // Remover cliente de la lista si existe
    const isAdmin = clienteId?.startsWith('admin-');
    if (clienteId && !isAdmin) {
      const cliente = session.clientes.find(c => c.id === clienteId);
      session.clientes = session.clientes.filter(c => c.id !== clienteId);

      // Notificar a admins
      if (cliente) {
        const mesa = await this.db.select().from(MesaTable).where(eq(MesaTable.id, mesaId)).limit(1);
        if (mesa[0]?.restauranteId) {
          this.notifyAdmins(mesa[0].restauranteId, this.createNotification(
            'CLIENTE_DESCONECTADO',
            mesaId,
            mesa[0].nombre,
            `${cliente.nombre} se desconectó`,
            `${session.clientes.length} cliente(s) en la mesa`
          ));
          this.broadcastEstadoToAdmins(mesaId);
        }
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
        imagenUrl: ProductoTable.imagenUrl
      })
      .from(ItemPedidoTable)
      .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
      .where(eq(ItemPedidoTable.pedidoId, pedidoId));

    const pedidoInfo = await this.db
      .select()
      .from(PedidoTable)
      .where(eq(PedidoTable.id, pedidoId))
      .limit(1);

    return {
      pedido: pedidoInfo[0] || null,
      items: items || []
    };
  }

  // Agregar item al pedido
  async agregarItem(pedidoId: number, mesaId: number, item: ItemPedidoWS) {
    // Insertar en la BD
    const result = await this.db.insert(ItemPedidoTable).values({
      pedidoId,
      productoId: item.productoId,
      clienteNombre: item.clienteNombre,
      cantidad: item.cantidad,
      precioUnitario: item.precioUnitario
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
        imagenUrl: ProductoTable.imagenUrl
      })
      .from(ItemPedidoTable)
      .leftJoin(ProductoTable, eq(ItemPedidoTable.productoId, ProductoTable.id))
      .where(eq(ItemPedidoTable.id, Number(result[0].insertId)))
      .limit(1);

    // Broadcast a toda la mesa
    const estadoActual = await this.getEstadoInicial(pedidoId);
    this.broadcast(mesaId, {
      type: 'PEDIDO_ACTUALIZADO',
      payload: {
        items: estadoActual.items,
        pedido: estadoActual.pedido,
        nuevoItem: itemCompleto[0]
      }
    });

    return itemCompleto[0];
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
    await this.db
      .update(PedidoTable)
      .set({ estado: 'preparing' })
      .where(eq(PedidoTable.id, pedidoId));

    const estadoActual = await this.getEstadoInicial(pedidoId);
    
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
  }

  // Cerrar pedido (cambiar estado a closed)
  async cerrarPedido(pedidoId: number, mesaId: number) {
    const estadoAntes = await this.getEstadoInicial(pedidoId);
    
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
  async pagarPedido(pedidoId: number, mesaId: number, metodo: 'efectivo' | 'mercadopago') {
    // Notificar a admins
    const mesa = await this.db.select().from(MesaTable).where(eq(MesaTable.id, mesaId)).limit(1);
    const estadoActual = await this.getEstadoInicial(pedidoId);
    
    if (mesa[0]?.restauranteId) {
      this.notifyAdmins(mesa[0].restauranteId, this.createNotification(
        'PAGO_RECIBIDO',
        mesaId,
        mesa[0].nombre,
        `Pago ${metodo === 'efectivo' ? 'en efectivo' : 'con MercadoPago'}`,
        `Total: $${estadoActual.pedido?.total || '0.00'}`,
        pedidoId
      ));
    }
    
    return { success: true, message: 'Pago registrado' };
  }

  getSession(mesaId: number) {
    return this.sessions.get(mesaId);
  }

  getAdminSession(restauranteId: number) {
    return this.adminSessions.get(restauranteId);
  }
}

export const wsManager = new WebSocketManager();
