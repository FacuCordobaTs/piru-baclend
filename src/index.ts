import 'dotenv/config';
import { createSign } from 'node:crypto';
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRoute } from './routes/auth'
import { restauranteRoute } from './routes/restaruante'
import { mesaRoute } from './routes/mesa';
import { productoRoute } from './routes/producto';
import { pedidoRoute } from './routes/pedido';
import { categoriaRoute } from './routes/categoria';
import { ingredienteRoute } from './routes/ingrediente';
import { mercadopagoRoute } from './routes/mercadopago';
import { notificacionRoute } from './routes/notificacion';
import { wsManager } from './websocket/manager';
import type { WebSocketMessage } from './types/websocket';
import { drizzle } from 'drizzle-orm/mysql2';
import { pool } from './db';
import { mesa as MesaTable, pedido as PedidoTable } from './db/schema';
import { eq, desc } from 'drizzle-orm';
import { createBunWebSocket } from "hono/bun";
import type { ServerWebSocket } from "bun";
import { verifyToken } from './libs/jwt';

// Destructure upgradeWebSocket and websocket from the helper function's return
const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

// Usar Map normal con ID único por conexión en lugar de WeakMap
interface WsConnectionData {
  mesaId: number;
  pedidoId: number;
  qrToken: string;
  clienteId?: string;
}
const wsConnections = new Map<string, WsConnectionData>();
let connectionCounter = 0;

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

app.post('/qz/sign', async (c) => {
  try {
    // 1. LIMPIEZA: Usamos .trim() para borrar espacios/enters al final
    const requestData = (await c.req.text()).trim();
    const rawKey = await Bun.file('private-key.pem').text();
    const privateKey = rawKey.trim();

    if (!requestData) {
      return c.text("Empty body", 400);
    }

    const signer = createSign('SHA512');
    signer.update(requestData);
    signer.end();

    const signature = signer.sign(privateKey, 'base64');

    // Devolvemos solo la firma
    return c.text(signature);
  } catch (error) {
    console.error("ERROR CRÍTICO QZ:", error);
    return c.text("Error signing message", 500);
  }
});

// API Routes
app.basePath('/api')
  .route('/auth', authRoute)
  .route('/restaurante', restauranteRoute)
  .route('/mesa', mesaRoute)
  .route('/producto', productoRoute)
  .route('/pedido', pedidoRoute)
  .route('/categoria', categoriaRoute)
  .route('/ingrediente', ingredienteRoute)
  .route('/mp', mercadopagoRoute)
  .route('/notificacion', notificacionRoute)

// IMPORTANT: Admin WebSocket endpoint MUST come BEFORE /ws/:qrToken
// because :qrToken would match "admin" as a token
app.get(
  '/ws/admin',
  upgradeWebSocket(async (c: any) => {
    const token = c.req.query('token');
    let restauranteId: number | null = null;

    // Verify JWT token
    if (token) {
      try {
        const decoded = await verifyToken(token);
        restauranteId = decoded.id;
        console.log(`🔑 Admin token válido - Restaurante ID: ${restauranteId}`);
      } catch (error) {
        console.error('❌ Invalid admin token:', error);
      }
    }

    if (!restauranteId) {
      return {
        async onOpen(event: any, ws: any) {
          console.error('❌ Admin connection without valid token');
          ws.close(1008, 'Token inválido o no proporcionado');
        },
        async onMessage(event: any, ws: any) { },
        async onClose(event: any, ws: any) { },
        async onError(event: any, ws: any) { }
      };
    }

    const adminConnectionId = `admin-${restauranteId}-${Date.now()}`;

    return {
      async onOpen(event: any, ws: any) {
        console.log(`🔑 Admin WebSocket conectado - Restaurante: ${restauranteId}`);
        wsManager.addAdminConnection(restauranteId!, ws);

        // Send initial state of all mesas
        try {
          const estadoMesas = await wsManager.getEstadoMesasRestaurante(restauranteId!);
          ws.send(JSON.stringify({
            type: 'ADMIN_ESTADO_MESAS',
            payload: { mesas: estadoMesas }
          }));
          console.log(`📊 Estado inicial enviado: ${estadoMesas.length} mesas`);

          // Send saved notifications from database
          const notificaciones = await wsManager.getNotificacionesRestaurante(restauranteId!);
          ws.send(JSON.stringify({
            type: 'ADMIN_NOTIFICACIONES_INICIAL',
            payload: { notificaciones }
          }));
          console.log(`🔔 Notificaciones iniciales enviadas: ${notificaciones.length}`);
        } catch (error) {
          console.error('Error sending initial admin state:', error);
        }
      },

      async onMessage(event: any, ws: any) {
        try {
          const messageStr = typeof event.data === 'string' ? event.data : event.data.toString();
          const data = JSON.parse(messageStr);

          console.log(`📨 Admin [${adminConnectionId}]:`, data.type);

          switch (data.type) {
            case 'PING':
              ws.send(JSON.stringify({ type: 'PONG' }));
              break;

            case 'REFRESH_MESAS':
              const estadoMesas = await wsManager.getEstadoMesasRestaurante(restauranteId!);
              ws.send(JSON.stringify({
                type: 'ADMIN_ESTADO_MESAS',
                payload: { mesas: estadoMesas }
              }));
              break;

            case 'MARCAR_PEDIDO_LISTO':
              // Modo carrito: marcar pedido como listo para retirar
              const { pedidoId, mesaId } = data.payload;
              if (pedidoId && mesaId) {
                await wsManager.marcarPedidoListo(pedidoId, mesaId);
                ws.send(JSON.stringify({
                  type: 'PEDIDO_LISTO_CONFIRMADO',
                  payload: { pedidoId, mesaId }
                }));
              }
              break;
          }
        } catch (error) {
          console.error('Error processing admin message:', error);
        }
      },

      async onClose(event: any, ws: any) {
        console.log(`🔓 Admin WebSocket desconectado - Restaurante: ${restauranteId}`);
        wsManager.removeAdminConnection(restauranteId!, ws);
      },

      async onError(event: any, ws: any) {
        console.error('❌ Admin WebSocket error:', event);
      }
    };
  })
)

// WebSocket endpoint for mesa clients (must come AFTER /ws/admin)
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

      // Buscar último pedido
      const ultimoPedido = await db.select()
        .from(PedidoTable)
        .where(eq(PedidoTable.mesaId, mesaId))
        .orderBy(desc(PedidoTable.createdAt))
        .limit(1);

      if (!ultimoPedido || ultimoPedido.length === 0) {
        // No hay pedidos, crear uno nuevo
        const nuevoPedido = await db.insert(PedidoTable).values({
          mesaId: mesaId,
          restauranteId: mesa[0].restauranteId!,
          estado: 'pending',
          total: '0.00'
        });
        pedidoId = Number(nuevoPedido[0].insertId);
      } else if (ultimoPedido[0].estado === 'closed') {
        // El último pedido está cerrado, verificar si todos pagaron
        const todosPagaron = await wsManager.verificarTodosPagaron(ultimoPedido[0].id);

        if (todosPagaron) {
          // Todos pagaron, crear nuevo pedido
          const nuevoPedido = await db.insert(PedidoTable).values({
            mesaId: mesaId,
            restauranteId: mesa[0].restauranteId!,
            estado: 'pending',
            total: '0.00'
          });
          pedidoId = Number(nuevoPedido[0].insertId);
        } else {
          // Aún falta pagar, usar el pedido cerrado
          pedidoId = ultimoPedido[0].id;
        }
      } else {
        // Hay un pedido activo (pending, preparing, delivered)
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
        async onClose(event: any, ws: any) { },
        async onError(event: any, ws: any) {
          console.error('❌ WebSocket error:', event);
        }
      };
    }

    // Generar ID único para esta conexión en el closure
    const connectionId = `conn-${++connectionCounter}-${Date.now()}`;

    // Retornar los handlers de WebSocket
    return {
      async onOpen(event: any, ws: any) {
        // Guardar datos usando el ID de conexión del closure
        wsConnections.set(connectionId, {
          mesaId: mesaId!,
          pedidoId: pedidoId!,
          qrToken
        });

        console.log(`✅ Cliente conectado [${connectionId}] - QR: ${qrToken}, Mesa: ${mesaId}, Pedido: ${pedidoId}`);
      },

      async onMessage(event: any, ws: any) {
        try {
          const messageStr = typeof event.data === 'string' ? event.data : event.data.toString();
          const data: WebSocketMessage = JSON.parse(messageStr);

          // Usar el ID de conexión del closure para obtener los datos
          let wsData = wsConnections.get(connectionId);

          // Si no existe, crear con los valores del closure
          if (!wsData) {
            wsData = { mesaId: mesaId!, pedidoId: pedidoId!, qrToken };
            wsConnections.set(connectionId, wsData);
          }

          const currentMesaId = wsData.mesaId;
          const currentPedidoId = wsData.pedidoId;

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

          console.log(`📨 [${connectionId}] Mesa ${currentMesaId}:`, data.type);

          switch (data.type) {
            case 'CLIENTE_CONECTADO':
              // Actualizar clienteId en los datos de conexión
              wsData.clienteId = data.payload.clienteId;
              wsConnections.set(connectionId, wsData);

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
              // Mantener compatibilidad: si solo hay un cliente, confirmar directamente
              const sessionForConfirm = wsManager.getSession(currentMesaId);
              if (sessionForConfirm && sessionForConfirm.clientes.length <= 1) {
                console.log(`✅ Confirmando pedido ${currentPedidoId} (cliente único)`);
                await wsManager.confirmarPedido(currentPedidoId, currentMesaId);
              } else {
                console.log(`⚠️ CONFIRMAR_PEDIDO ignorado - usar INICIAR_CONFIRMACION para múltiples clientes`);
              }
              break;

            case 'INICIAR_CONFIRMACION':
              console.log(`🔔 Iniciando confirmación grupal - Mesa ${currentMesaId}, Cliente: ${data.payload.clienteNombre}`);
              wsManager.iniciarConfirmacion(currentMesaId, data.payload.clienteId, data.payload.clienteNombre);
              break;

            case 'USUARIO_CONFIRMO':
              console.log(`✅ Usuario confirmó - Mesa ${currentMesaId}, Cliente: ${data.payload.clienteId}`);
              wsManager.usuarioConfirma(currentMesaId, data.payload.clienteId);
              break;

            case 'USUARIO_CANCELO':
              console.log(`❌ Usuario canceló - Mesa ${currentMesaId}, Cliente: ${data.payload.clienteNombre}`);
              wsManager.usuarioCancela(currentMesaId, data.payload.clienteId, data.payload.clienteNombre);
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
              console.log(`💳 Pagando pedido ${currentPedidoId} - Método: ${data.payload.metodo}, Total del cliente: ${data.payload.total || 'no enviado'}`);
              await wsManager.pagarPedido(currentPedidoId, currentMesaId, data.payload.metodo, data.payload.total);
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
        const wsData = wsConnections.get(connectionId);

        if (wsData) {
          const { mesaId: closingMesaId, clienteId } = wsData;

          console.log(`👋 [${connectionId}] Cliente desconectado - Mesa: ${closingMesaId}, Cliente: ${clienteId || 'desconocido'}`);

          wsManager.removeClient(closingMesaId, clienteId, ws);

          // Notificar a otros clientes
          const session = wsManager.getSession(closingMesaId);
          if (session) {
            wsManager.broadcast(closingMesaId, {
              type: 'CLIENTE_DESCONECTADO',
              payload: {
                clienteId: clienteId,
                clientes: session.clientes
              }
            });
          }

          // Limpiar datos del Map
          wsConnections.delete(connectionId);
        } else {
          console.log(`👋 [${connectionId}] Conexión cerrada (sin datos de sesión)`);
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
console.log(`🔑 Admin WebSocket disponible en ws://localhost:${process.env.PORT || 3000}/ws/admin?token=JWT_TOKEN`);