// src/websocket/manager.ts
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, and } from 'drizzle-orm';
import { pool } from '../db';
import { 
  pedido as PedidoTable, 
  itemPedido as ItemPedidoTable,
  producto as ProductoTable 
} from '../db/schema';
import { MesaSession, WebSocketMessage, ItemPedidoWS } from '../types/websocket';

class WebSocketManager {
  private sessions: Map<number, MesaSession> = new Map();
  private db = drizzle(pool);

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

    // Agregar cliente si no existe
    if (!session.clientes.find(c => c.id === clienteId)) {
      session.clientes.push({
        id: clienteId,
        nombre,
        socketId: clienteId
      });
    }

    return session;
  }

  // Remover cliente
  removeClient(mesaId: number, clienteId: string | undefined, ws: any) {
    const session = this.sessions.get(mesaId);
    if (!session) return;

    session.connections.delete(ws);
    
    // Remover cliente de la lista si existe
    if (clienteId) {
      session.clientes = session.clientes.filter(c => c.id !== clienteId);
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
  }

  // Cerrar pedido (cambiar estado a closed)
  async cerrarPedido(pedidoId: number, mesaId: number) {
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
  }

  // Llamar al mozo (solo notificación, no cambia estado)
  llamarMozo(mesaId: number, clienteNombre: string) {
    // Esto solo notifica al restaurante, no necesita broadcast a todos los clientes
    // Por ahora solo retornamos éxito
    return { success: true, message: 'Mozo notificado' };
  }

  // Pagar pedido
  async pagarPedido(pedidoId: number, mesaId: number, metodo: 'efectivo' | 'mercadopago') {
    // Aquí se podría crear un registro de pago en la tabla pago
    // Por ahora solo retornamos éxito
    return { success: true, message: 'Pago registrado' };
  }

  getSession(mesaId: number) {
    return this.sessions.get(mesaId);
  }
}

export const wsManager = new WebSocketManager();