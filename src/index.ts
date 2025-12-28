import 'dotenv/config';
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRoute } from './routes/auth'
import { restauranteRoute } from './routes/restaruante'
import { mesaRoute } from './routes/mesa';
import { productoRoute } from './routes/producto';
import { wsManager } from './websocket/manager';
import type { WebSocketMessage } from './types/websocket';
import { drizzle } from 'drizzle-orm/mysql2';
import { pool } from './db';
import { mesa as MesaTable, pedido as PedidoTable } from './db/schema';
import { eq, desc } from 'drizzle-orm';
import { createBunWebSocket } from "hono/bun"; 
import type { ServerWebSocket } from "bun";

// Destructure upgradeWebSocket and websocket from the helper function's return
const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

// Map para almacenar datos de cada conexión WebSocket
const wsDataMap = new WeakMap<any, { mesaId: number; pedidoId: number; qrToken: string; clienteId?: string }>();

// Validate required environment variables
const requiredEnvVars = [
  'DB_USER',
  'DB_PASSWORD', 
  'DB_NAME',
  'JWT_SECRET'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

console.log('✅ All required environment variables are present');

const app = new Hono()

// Configure CORS
app.use('*', cors({
  origin: [
    'http://localhost:4321', // Astro dev server
    'http://localhost:3000', // Alternative dev port
    'http://localhost:5173', // Vite dev server
    'https://piru.app', // landing domain
    'https://admin.piru.app', // Admin domain
    'https://my.piru.app', // My domain
    'https://www.piru.app', // Production domain with www
  ],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))

app.get('/', (c) => {
  return c.text('Piru API - Servidor corriendo correctamente')
})

// API Routes
app.basePath('/api')
  .route('/auth', authRoute)
  .route('/restaurante', restauranteRoute)
  .route('/mesa', mesaRoute)
  .route('/producto', productoRoute)

// WebSocket endpoint usando upgradeWebSocket
app.get(
  '/ws/:qrToken',
  upgradeWebSocket(async (c: any) => {
    const db = drizzle(pool);
    const qrToken = c.req.param('qrToken');
    
    // Buscar mesa y pedido antes de establecer la conexión
    let mesaId: number | null = null;
    let pedidoId: number | null = null;
    
    try {
      const mesa = await db.select()
        .from(MesaTable)
        .where(eq(MesaTable.qrToken, qrToken))
        .limit(1);

      if (!mesa || mesa.length === 0) {
        throw new Error('Mesa no encontrada');
      }

      mesaId = mesa[0].id;

      // Buscar o crear pedido activo
      const ultimoPedido = await db.select()
        .from(PedidoTable)
        .where(eq(PedidoTable.mesaId, mesaId))
        .orderBy(desc(PedidoTable.createdAt))
        .limit(1);

      if (!ultimoPedido || ultimoPedido.length === 0 || ultimoPedido[0].estado === 'closed') {
        // Crear nuevo pedido
        const nuevoPedido = await db.insert(PedidoTable).values({
          mesaId: mesaId,
          restauranteId: mesa[0].restauranteId!,
          estado: 'pending',
          total: '0.00'
        });
        pedidoId = Number(nuevoPedido[0].insertId);
      } else {
        pedidoId = ultimoPedido[0].id;
      }
    } catch (error) {
      console.error('Error al buscar mesa/pedido:', error);
    }

    // Validar que tenemos mesaId y pedidoId antes de crear los handlers
    if (!mesaId || !pedidoId) {
      // Retornar handlers que rechazan la conexión
      return {
        async onOpen(event: any, ws: any) {
          console.error('❌ No se pudo establecer mesaId o pedidoId');
          ws.close(1008, 'Mesa o pedido no encontrado');
        },
        async onMessage(event: any, ws: any) {
          ws.close(1008, 'Mesa o pedido no encontrado');
        },
        async onClose(event: any, ws: any) {},
        async onError(event: any, ws: any) {
          console.error('❌ WebSocket error:', event);
        }
      };
    }

    // Retornar los handlers de WebSocket
    return {
      async onOpen(event: any, ws: any) {
        // Guardar datos en el Map usando WeakMap para evitar memory leaks
        wsDataMap.set(ws, { mesaId: mesaId!, pedidoId: pedidoId!, qrToken });
        
        console.log(`✅ Cliente conectado - QR: ${qrToken}, Mesa: ${mesaId}, Pedido: ${pedidoId}`);
      },

      async onMessage(event: any, ws: any) {
        try {
          const messageStr = typeof event.data === 'string' ? event.data : event.data.toString();
          console.log('Mensaje recibido:', messageStr);
          const data: WebSocketMessage = JSON.parse(messageStr);
          
          // Obtener mesaId y pedidoId del Map, o usar los del closure como fallback
          let currentMesaId = mesaId!;
          let currentPedidoId = pedidoId!;
          
          const wsData = wsDataMap.get(ws);
          if (wsData) {
            currentMesaId = wsData.mesaId;
            currentPedidoId = wsData.pedidoId;
          } else {
            // Si no está en el Map, usar los valores del closure y guardarlos
            console.log('⚠️ WebSocket no encontrado en Map, usando valores del closure');
            wsDataMap.set(ws, { mesaId: currentMesaId, pedidoId: currentPedidoId, qrToken });
          }
          
          if (!currentMesaId || !currentPedidoId) {
            console.error('❌ No se pudo obtener mesaId o pedidoId');
            ws.send(JSON.stringify({
              type: 'ERROR',
              payload: { 
                message: 'Conexión no inicializada correctamente'
              }
            }));
            return;
          }

          console.log(`📨 Mensaje recibido - Mesa ${currentMesaId}:`, data.type);
          
          switch(data.type) {
            case 'CLIENTE_CONECTADO':
              // Asegurarse de que el WebSocket esté en el Map antes de actualizar
              let updatedWsData = wsDataMap.get(ws);
              if (!updatedWsData) {
                updatedWsData = { mesaId: currentMesaId, pedidoId: currentPedidoId, qrToken };
                wsDataMap.set(ws, updatedWsData);
              }
              // Actualizar clienteId
              updatedWsData.clienteId = data.payload.clienteId;
              wsDataMap.set(ws, updatedWsData);
              
              const session = await wsManager.addClient(
                currentMesaId,
                currentPedidoId,
                ws,
                data.payload.clienteId,
                data.payload.nombre
              );
              
              // Enviar estado inicial
              const estadoInicial = await wsManager.getEstadoInicial(currentPedidoId);
              ws.send(JSON.stringify({
                type: 'ESTADO_INICIAL',
                payload: {
                  items: estadoInicial.items || [],
                  pedido: estadoInicial.pedido,
                  total: estadoInicial.pedido?.total || '0.00',
                  estado: estadoInicial.pedido?.estado || 'pending',
                  clientes: session.clientes,
                  mesaId: currentMesaId,
                  pedidoId: currentPedidoId
                }
              }));
              
              console.log(`👤 Cliente "${data.payload.nombre}" unido a mesa ${currentMesaId}`);
              
              // Notificar a otros clientes
              wsManager.broadcast(currentMesaId, {
                type: 'CLIENTE_UNIDO',
                payload: {
                  cliente: {
                    id: data.payload.clienteId,
                    nombre: data.payload.nombre
                  },
                  clientes: session.clientes
                }
              }, ws);
              break;
              
            case 'AGREGAR_ITEM':
              console.log(`➕ Agregando item - Cliente: ${data.payload.clienteNombre}`);
              await wsManager.agregarItem(currentPedidoId, currentMesaId, data.payload);
              break;
              
            case 'ELIMINAR_ITEM':
              console.log(`➖ Eliminando item ${data.payload.itemId}`);
              await wsManager.eliminarItem(data.payload.itemId, currentPedidoId, currentMesaId);
              break;
              
            case 'ACTUALIZAR_CANTIDAD':
              console.log(`🔄 Actualizando cantidad - Item ${data.payload.itemId}: ${data.payload.cantidad}`);
              await wsManager.actualizarCantidad(
                data.payload.itemId,
                data.payload.cantidad,
                currentPedidoId,
                currentMesaId
              );
              break;
              
            case 'CONFIRMAR_PEDIDO':
              console.log(`✅ Confirmando pedido ${currentPedidoId}`);
              await wsManager.confirmarPedido(currentPedidoId, currentMesaId);
              break;

            case 'CERRAR_PEDIDO':
              console.log(`🔒 Cerrando pedido ${currentPedidoId}`);
              await wsManager.cerrarPedido(currentPedidoId, currentMesaId);
              break;

            case 'LLAMAR_MOZO':
              console.log(`🔔 Llamando al mozo - Mesa ${currentMesaId}`);
              wsManager.llamarMozo(currentMesaId, data.payload.clienteNombre || 'Cliente');
              // Responder solo al cliente que llamó
              ws.send(JSON.stringify({
                type: 'MOZO_NOTIFICADO',
                payload: { message: 'Mozo notificado' }
              }));
              break;

            case 'PAGAR_PEDIDO':
              console.log(`💳 Pagando pedido ${currentPedidoId} - Método: ${data.payload.metodo}`);
              await wsManager.pagarPedido(currentPedidoId, currentMesaId, data.payload.metodo);
              break;
              
            default:
              console.warn(`⚠️ Tipo de mensaje desconocido: ${data.type}`);
          }
        } catch (error) {
          console.error('❌ Error procesando mensaje WebSocket:', error);
          
          try {
            ws.send(JSON.stringify({
              type: 'ERROR',
              payload: { 
                message: 'Error procesando solicitud',
                error: error instanceof Error ? error.message : 'Unknown error'
              }
            }));
          } catch (sendError) {
            console.error('❌ Error enviando mensaje de error:', sendError);
          }
        }
      },

      async onClose(event: any, ws: any) {
        const wsData = wsDataMap.get(ws);
        
        // Si no está en el Map, intentar usar los valores del closure como fallback
        let mesaId: number | null = null;
        let clienteId: string | undefined = undefined;
        
        if (wsData) {
          mesaId = wsData.mesaId;
          clienteId = wsData.clienteId;
        } else {
          // Usar valores del closure como fallback
          console.warn('⚠️ WebSocket no encontrado en Map en onClose, usando valores del closure');
          mesaId = mesaId || null;
        }

        if (mesaId) {
          console.log(`👋 Cliente desconectado - Mesa: ${mesaId}, Cliente: ${clienteId || 'desconocido'}`);
          
          wsManager.removeClient(mesaId, clienteId, ws);
          
          // Notificar a otros clientes
          const session = wsManager.getSession(mesaId);
          if (session) {
            wsManager.broadcast(mesaId, {
              type: 'CLIENTE_DESCONECTADO',
              payload: {
                clienteId: clienteId,
                clientes: session.clientes
              }
            });
          }
        }
        
        // Limpiar datos del Map si existían
        if (wsData) {
          wsDataMap.delete(ws);
        }
      },

      async onError(event: any, ws: any) {
        console.error('❌ WebSocket error:', event);
      }
    }
  })
)

export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
  websocket, // Exportar el handler de websocket de Hono
}

console.log(`🚀 Servidor iniciado en puerto ${process.env.PORT || 3000}`);
console.log(`📡 WebSocket disponible en ws://localhost:${process.env.PORT || 3000}/ws/:qrToken`);