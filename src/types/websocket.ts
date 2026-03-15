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
  agregados?: Array<{ id: number, nombre: string, precio: string }>; // Array de agregados sumados
}

export interface WebSocketMessage {
  type: 'CLIENTE_CONECTADO' | 'AGREGAR_ITEM' | 'ELIMINAR_ITEM' |
  'ACTUALIZAR_CANTIDAD' | 'CONFIRMAR_PEDIDO' | 'CERRAR_PEDIDO' |
  'LLAMAR_MOZO' | 'PAGAR_PEDIDO' | 'ESTADO_INICIAL' |
  'PEDIDO_ACTUALIZADO' | 'PEDIDO_CONFIRMADO' | 'PEDIDO_CERRADO' |
  'PEDIDO_PAGADO' | 'SUBTOTALES_ACTUALIZADOS' |
  'CLIENTE_UNIDO' | 'CLIENTE_DESCONECTADO' | 'ERROR' |
  // Pedido management
  'PEDIDO_ELIMINADO' | 'MESA_RESETEADA' |
  // Modo Carrito
  'NOMBRE_PEDIDO_ASIGNADO' | 'PEDIDO_LISTO_PARA_RETIRAR' |
  // Confirmación grupal
  'INICIAR_CONFIRMACION' | 'USUARIO_CONFIRMO' | 'USUARIO_CANCELO' |
  'CONFIRMACION_INICIADA' | 'CONFIRMACION_ACTUALIZADA' | 'CONFIRMACION_CANCELADA' |
  // Checkout grupal (sala)
  'INICIAR_EDICION_CHECKOUT' | 'MODIFICAR_CHECKOUT' | 'CANCELAR_EDICION_CHECKOUT' | 'ACEPTAR_EDICION_CHECKOUT' |
  'CHECKOUT_EDITANDO' | 'CHECKOUT_DATOS_ACTUALIZADOS' |
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

// Datos de checkout grupal (sala) - delivery/takeaway
export interface CheckoutDeliveryData {
  tipoPedido: 'delivery' | 'takeaway';
  nombre: string;
  telefono: string;
  direccion: string;
  lat: number | null;
  lng: number | null;
  notas: string;
  deliveryFee: number;
  zonaNombre: string | null;
  itemsTotal: string;
  total: string;
  codigoDescuentoId?: number | null;
  montoDescuento?: number;
}

// Semáforo: quién está editando el checkout
export interface CheckoutEditSemaphore {
  clienteId: string;
  clienteNombre: string;
}

export interface MesaSession {
  mesaId: number;
  pedidoId: number;
  clientes: ClienteConectado[];
  connections: Set<any>;
  confirmacionGrupal?: ConfirmacionGrupal;
  // Checkout grupal (sala)
  checkoutDeliveryData?: CheckoutDeliveryData;
  checkoutEditSemaphore?: CheckoutEditSemaphore;
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
