// src/types/websocket.ts
export interface ClienteConectado {
  id: string;
  nombre: string;
  socketId: string;
}

export interface ItemPedidoWS {
  id?: number;
  productoId: number;
  clienteNombre: string;
  cantidad: number;
  precioUnitario: string;
  nombreProducto?: string;
  ingredientesExcluidos?: number[]; // Array de IDs de ingredientes excluidos
}

export interface WebSocketMessage {
  type: 'CLIENTE_CONECTADO' | 'AGREGAR_ITEM' | 'ELIMINAR_ITEM' | 
        'ACTUALIZAR_CANTIDAD' | 'CONFIRMAR_PEDIDO' | 'CERRAR_PEDIDO' | 
        'LLAMAR_MOZO' | 'PAGAR_PEDIDO' | 'ESTADO_INICIAL' |
        'PEDIDO_ACTUALIZADO' | 'PEDIDO_CONFIRMADO' | 'PEDIDO_CERRADO' |
        'CLIENTE_UNIDO' | 'CLIENTE_DESCONECTADO' | 'ERROR' |
        // Admin message types
        'ADMIN_CONECTADO' | 'ADMIN_NOTIFICACION' | 'ADMIN_ESTADO_MESAS';
  payload: any;
}

export interface MesaSession {
  mesaId: number;
  pedidoId: number;
  clientes: ClienteConectado[];
  connections: Set<any>;
}

// Admin notification types
export type AdminNotificationType = 
  | 'NUEVO_PEDIDO'
  | 'PEDIDO_CONFIRMADO' 
  | 'PEDIDO_CERRADO'
  | 'CLIENTE_CONECTADO'
  | 'CLIENTE_DESCONECTADO'
  | 'LLAMADA_MOZO'
  | 'PAGO_RECIBIDO'
  | 'PRODUCTO_AGREGADO';

export interface AdminNotification {
  id: string;
  tipo: AdminNotificationType;
  mesaId: number;
  mesaNombre?: string;
  pedidoId?: number;
  mensaje: string;
  detalles?: string;
  timestamp: string;
  leida: boolean;
}

export interface AdminSession {
  restauranteId: number;
  connections: Set<any>;
}
