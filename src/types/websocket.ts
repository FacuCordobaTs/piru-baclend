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
        'PEDIDO_PAGADO' | 'SUBTOTALES_ACTUALIZADOS' |
        'CLIENTE_UNIDO' | 'CLIENTE_DESCONECTADO' | 'ERROR' |
        // Confirmación grupal
        'INICIAR_CONFIRMACION' | 'USUARIO_CONFIRMO' | 'USUARIO_CANCELO' |
        'CONFIRMACION_INICIADA' | 'CONFIRMACION_ACTUALIZADA' | 'CONFIRMACION_CANCELADA' |
        // Admin message types
        'ADMIN_CONECTADO' | 'ADMIN_NOTIFICACION' | 'ADMIN_ESTADO_MESAS' | 'ADMIN_SUBTOTALES_ACTUALIZADOS';
  payload: any;
}

// Estado de confirmación de cada cliente
export interface ConfirmacionCliente {
  clienteId: string;
  nombre: string;
  confirmado: boolean;
}

// Estado del proceso de confirmación grupal
export interface ConfirmacionGrupal {
  activa: boolean;
  iniciadaPor: string; // clienteId del que inició
  iniciadaPorNombre: string;
  confirmaciones: ConfirmacionCliente[];
  timestamp: string;
}

export interface MesaSession {
  mesaId: number;
  pedidoId: number;
  clientes: ClienteConectado[];
  connections: Set<any>;
  confirmacionGrupal?: ConfirmacionGrupal;
}

// Admin notification types (debe coincidir con el enum en schema.ts)
export type AdminNotificationType = 
  | 'NUEVO_PEDIDO'
  | 'PEDIDO_CONFIRMADO' 
  | 'PEDIDO_CERRADO'
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
