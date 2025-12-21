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
    'https://piru.app', // Production domain
    'https://www.piru.app', // Production domain with www
    'https://landing.piru.app', // Landing page subdomain
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

    // Retornar los handlers de WebSocket
    return {
      async onOpen(event: any, ws: any) {
        if (!mesaId || !pedidoId) {
          console.error('❌ No se pudo establecer mesaId o pedidoId');
          ws.close(1008, 'Mesa o pedido no encontrado');
          return;
        }

        // Guardar datos en el WebSocket
        (ws as any).mesaId = mesaId;
        (ws as any).pedidoId = pedidoId;
        (ws as any).qrToken = qrToken;
        
        console.log(`✅ Cliente conectado - QR: ${qrToken}, Mesa: ${mesaId}, Pedido: ${pedidoId}`);
      },

      async onMessage(event: any, ws: any) {
        try {
          const messageStr = typeof event.data === 'string' ? event.data : event.data.toString();
          const data: WebSocketMessage = JSON.parse(messageStr);
          const mesaId = (ws as any).mesaId;
          const pedidoId = (ws as any).pedidoId;

          if (!mesaId || !pedidoId) {
            console.error('❌ WebSocket sin mesaId o pedidoId');
            return;
          }
          
          console.log(`📨 Mensaje recibido - Mesa ${mesaId}:`, data.type);
          
          switch(data.type) {
            case 'CLIENTE_CONECTADO':
              const session = await wsManager.addClient(
                mesaId,
                pedidoId,
                ws,
                data.payload.clienteId,
                data.payload.nombre
              );
              
              // Enviar estado inicial
              const estadoInicial = await wsManager.getEstadoInicial(pedidoId);
              ws.send(JSON.stringify({
                type: 'ESTADO_INICIAL',
                payload: {
                  ...estadoInicial,
                  clientes: session.clientes,
                  mesaId,
                  pedidoId
                }
              }));
              
              console.log(`👤 Cliente "${data.payload.nombre}" unido a mesa ${mesaId}`);
              
              // Notificar a otros clientes
              wsManager.broadcast(mesaId, {
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
              await wsManager.agregarItem(pedidoId, mesaId, data.payload);
              break;
              
            case 'ELIMINAR_ITEM':
              console.log(`➖ Eliminando item ${data.payload.itemId}`);
              await wsManager.eliminarItem(data.payload.itemId, pedidoId, mesaId);
              break;
              
            case 'ACTUALIZAR_CANTIDAD':
              console.log(`🔄 Actualizando cantidad - Item ${data.payload.itemId}: ${data.payload.cantidad}`);
              await wsManager.actualizarCantidad(
                data.payload.itemId,
                data.payload.cantidad,
                pedidoId,
                mesaId
              );
              break;
              
            case 'CONFIRMAR_PEDIDO':
              console.log(`✅ Confirmando pedido ${pedidoId}`);
              await wsManager.confirmarPedido(pedidoId, mesaId);
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
        const mesaId = (ws as any).mesaId;
        const clienteId = (ws as any).clienteId;
        
        console.log(`👋 Cliente desconectado - Mesa: ${mesaId}`);
        
        wsManager.removeClient(ws);
        
        // Notificar a otros clientes
        const session = wsManager.getSession(mesaId);
        if (session) {
          wsManager.broadcast(mesaId, {
            type: 'CLIENTE_DESCONECTADO',
            payload: {
              clienteId,
              clientes: session.clientes
            }
          });
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