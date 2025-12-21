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
  }
  
  export interface WebSocketMessage {
    type: 'CLIENTE_CONECTADO' | 'AGREGAR_ITEM' | 'ELIMINAR_ITEM' | 
          'ACTUALIZAR_CANTIDAD' | 'CONFIRMAR_PEDIDO' | 'ESTADO_INICIAL' |
          'PEDIDO_ACTUALIZADO' | 'CLIENTE_UNIDO' | 'CLIENTE_DESCONECTADO' |
          'ERROR';
    payload: any;
  }
  
  export interface MesaSession {
    mesaId: number;
    pedidoId: number;
    clientes: ClienteConectado[];
    connections: Set<any>;
  }