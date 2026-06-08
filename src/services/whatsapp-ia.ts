// Backend/src/services/whatsapp-ia.ts
// Agente IA que maneja conversaciones de pedidos por WhatsApp

import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and } from 'drizzle-orm'
import { pool } from '../db'
import {
  whatsappConversacion as WhatsappConversacionTable,
  restaurante as RestauranteTable,
  producto as ProductoTable,
  categoria as CategoriaTable,
  ingrediente as IngredienteTable,
  agregado as AgregadoTable,
  productoIngrediente as ProductoIngredienteTable,
  productoAgregado as ProductoAgregadoTable,
  varianteProducto as VarianteProductoTable,
  pedidoUnificado as PedidoUnificadoTable,
  itemPedidoUnificado as ItemPedidoUnificadoTable,
  accountPool as AccountPoolTable,
  cliente as ClienteTable,
} from '../db/schema'
import { sendWhatsAppText } from './whatsapp'
import { asignarAliasAPedido } from './cucuru'
import { wsManager } from '../websocket/manager'
import { emitirEventoPedido } from '../lib/pedidos-activos'
import { rowToPagoRow, resolverMetodoPagoPedido, proveedorTransferenciaDinamica } from '../lib/metodos-pago'

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface MensajeHistorial {
  role: 'user' | 'assistant'
  content: string
}

interface ItemDraft {
  productoId: number
  nombre: string
  cantidad: number
  precio: number          // precio unitario ya calculado (con variante si aplica)
  varianteId?: number
  varianteNombre?: string
  agregados?: { id: number; nombre: string; precio: string }[]
  notas?: string
}

interface PedidoDraft {
  items: ItemDraft[]
  tipo?: 'delivery' | 'takeaway'
  direccion?: string
  notas?: string
}

interface ProcesarMensajeParams {
  restauranteId: number
  telefono: string
  texto: string
  phoneNumberId: string
  token: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Construye el contexto del menú formateado para el system prompt.
 * Lo más compacto posible — Claude no necesita URLs ni campos irrelevantes.
 */
async function obtenerMenuParaPrompt(db: any, restauranteId: number): Promise<string> {
  const productos = await db
    .select({
      id: ProductoTable.id,
      nombre: ProductoTable.nombre,
      descripcion: ProductoTable.descripcion,
      precio: ProductoTable.precio,
      activo: ProductoTable.activo,
      categoriaNombre: CategoriaTable.nombre,
    })
    .from(ProductoTable)
    .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
    .where(and(
      eq(ProductoTable.restauranteId, restauranteId),
      eq(ProductoTable.activo, true)
    ))

  if (productos.length === 0) return 'Sin productos disponibles.'

  // Agrupar por categoría
  const porCategoria = new Map<string, typeof productos>()
  for (const p of productos) {
    const cat = p.categoriaNombre ?? 'Sin categoría'
    if (!porCategoria.has(cat)) porCategoria.set(cat, [])
    porCategoria.get(cat)!.push(p)
  }

  const lineas: string[] = []
  for (const [cat, prods] of porCategoria) {
    lineas.push(`\n**${cat}**`)
    for (const p of prods) {
      // Obtener ingredientes y agregados
      const ingredientes = await db
        .select({ nombre: IngredienteTable.nombre })
        .from(ProductoIngredienteTable)
        .innerJoin(IngredienteTable, eq(ProductoIngredienteTable.ingredienteId, IngredienteTable.id))
        .where(eq(ProductoIngredienteTable.productoId, p.id))

      const agregados = await db
        .select({ id: AgregadoTable.id, nombre: AgregadoTable.nombre, precio: AgregadoTable.precio })
        .from(ProductoAgregadoTable)
        .innerJoin(AgregadoTable, eq(ProductoAgregadoTable.agregadoId, AgregadoTable.id))
        .where(eq(ProductoAgregadoTable.productoId, p.id))

      const variantes = await db
        .select({ id: VarianteProductoTable.id, nombre: VarianteProductoTable.nombre, precio: VarianteProductoTable.precio })
        .from(VarianteProductoTable)
        .where(eq(VarianteProductoTable.productoId, p.id))

      let linea = `- [ID:${p.id}] ${p.nombre} — $${p.precio}`
      if (p.descripcion) linea += ` (${p.descripcion})`
      if (ingredientes.length > 0) linea += ` | Ingredientes: ${ingredientes.map((i: any) => i.nombre).join(', ')}`
      if (variantes.length > 0) linea += ` | Variantes: ${variantes.map((v: any) => `${v.nombre} $${v.precio} [VID:${v.id}]`).join(', ')}`
      if (agregados.length > 0) linea += ` | Extras: ${agregados.map((a: any) => `${a.nombre} +$${a.precio} [AID:${a.id}]`).join(', ')}`
      lineas.push(linea)
    }
  }

  return lineas.join('\n')
}

/**
 * Construye el system prompt completo para el agente.
 */
async function buildSystemPrompt(db: any, restauranteId: number): Promise<string> {
  const [restaurante] = await db
    .select({
      nombre: RestauranteTable.nombre,
      deliveryEnabled: RestauranteTable.deliveryEnabled,
      takeawayEnabled: RestauranteTable.takeawayEnabled,
      deliveryFee: RestauranteTable.deliveryFee,
      proveedorPago: RestauranteTable.proveedorPago,
      cucuruConfigurado: RestauranteTable.cucuruConfigurado,
      cucuruEnabled: RestauranteTable.cucuruEnabled,
      mpConnected: RestauranteTable.mpConnected,
      mpPublicKey: RestauranteTable.mpPublicKey,
      metodosPagoConfig: RestauranteTable.metodosPagoConfig,
      cardsPaymentsEnabled: RestauranteTable.cardsPaymentsEnabled,
      transferenciaAlias: RestauranteTable.transferenciaAlias,
      taloClientId: RestauranteTable.taloClientId,
      taloClientSecret: RestauranteTable.taloClientSecret,
      taloUserId: RestauranteTable.taloUserId,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  const menu = await obtenerMenuParaPrompt(db, restauranteId)

  const tiposDisponibles = []
  if (restaurante.deliveryEnabled) tiposDisponibles.push('delivery (el cliente da su dirección)')
  if (restaurante.takeawayEnabled) tiposDisponibles.push('takeaway (retira en el local)')

  const pagoRow = rowToPagoRow(restaurante)
  const metodos: string[] = []
  if (restaurante.mpConnected) metodos.push('mercadopago (se le envía link de pago)')
  if (restaurante.cucuruConfigurado && restaurante.cucuruEnabled) metodos.push('transferencia (alias único generado automáticamente)')
  if (restaurante.transferenciaAlias) metodos.push('transferencia manual (alias fijo del local)')

  return `Sos el asistente de pedidos de ${restaurante.nombre} por WhatsApp. Tu trabajo es tomar pedidos de los clientes de forma simple y directa, como lo haría una persona.

REGLAS FUNDAMENTALES:
- Hablá en español argentino, informal, como un humano. Sin formalismos ni frases robóticas.
- Mensajes CORTOS y directos. Sin asteriscos para negritas, sin guiones para listas, sin emojis, sin separadores. Texto plano solamente.
- Nunca uses markdown: nada de **, *, -, --, ni emojis.
- Nunca mencionás que sos una IA o un sistema. Sos el asistente del local.
- Si el cliente pregunta algo que no está en el menú o no entendés, pedís que aclare brevemente.
- No inventés precios ni productos que no están en el menú.

CUANDO EL CLIENTE PIDE EL MENÚ:
Mandá el listado directamente, sin "Dale, acá va el menú:" ni ninguna introducción. Sin "¿Qué te llama la atención?" ni ningún cierre. Solo el listado de productos con precio, en texto plano, agrupado por categoría.

MÉTODO DE PAGO TRANSFERENCIA:
Cuando el cliente elige transferencia, NO le preguntés nada más. NO le explicés qué es un alias único. Simplemente incluí METODO_ELEGIDO:"cucuru" en tu respuesta y el sistema le manda los datos automáticamente. Tu mensaje al cliente puede ser algo como "Perfecto, te mando los datos para transferir." y nada más.

FLUJO DEL PEDIDO:
1. Saludar y preguntar qué quiere pedir (o mostrar el menú si lo pide)
2. Confirmar los items con el cliente (cantidad, variantes, extras si hay)
3. Preguntar si es delivery o takeaway${restaurante.deliveryEnabled && restaurante.takeawayEnabled ? '' : ` (solo está disponible: ${tiposDisponibles.join(' y ')})`}
4. Si es delivery: pedirle la dirección
5. Mostrar el resumen del pedido con el total y preguntar el método de pago
6. Según el método elegido: enviar link de MP o alias de transferencia
7. Cuando se confirme el pago, avisarle que el pedido fue registrado

TIPOS DE PEDIDO DISPONIBLES: ${tiposDisponibles.join(', ')}

MÉTODOS DE PAGO DISPONIBLES: ${metodos.join(', ')}
${restaurante.deliveryFee && parseFloat(restaurante.deliveryFee) > 0 ? `\nCOSTO DE DELIVERY: $${restaurante.deliveryFee} (se suma al total)` : ''}

MENÚ ACTUAL:
${menu}

INSTRUCCIONES TÉCNICAS PARA CREAR EL PEDIDO:
Cuando el cliente confirme los items y estés listo para proceder al pago, tu respuesta DEBE incluir un bloque JSON al final con este formato exacto (después de tu mensaje al cliente):

PEDIDO_JSON:{"tipo":"delivery"|"takeaway","direccion":"...solo si es delivery...","nombreCliente":"...si lo dijo...","items":[{"productoId":123,"nombre":"...","cantidad":1,"varianteId":456,"agregados":[{"id":1,"nombre":"...","precio":"500.00"}]}]}

Este bloque es solo para el sistema, el cliente no lo ve. Solo incluirlo cuando el cliente haya confirmado todo y esté listo para pagar.

Cuando debas preguntar el método de pago, incluir al final:
PEDIR_METODO_PAGO:true

Cuando el cliente elija el método de pago, incluir al final:
METODO_ELEGIDO:"mercadopago"|"cucuru"|"transferencia_manual"`
}

// ─── Función principal ────────────────────────────────────────────────────────

export async function procesarMensajeIA(params: ProcesarMensajeParams): Promise<void> {
  const { restauranteId, telefono, texto, phoneNumberId, token } = params
  const db = drizzle(pool)

  // 1. Buscar o crear conversación
  const conversaciones = await db
    .select()
    .from(WhatsappConversacionTable)
    .where(and(
      eq(WhatsappConversacionTable.restauranteId, restauranteId),
      eq(WhatsappConversacionTable.telefono, telefono)
    ))
    .limit(1)

  let conversacion = conversaciones[0] ?? null
  let mensajes: MensajeHistorial[] = []
  let pedidoDraft: PedidoDraft = { items: [] }

  if (conversacion) {
    mensajes = (conversacion.mensajes as MensajeHistorial[]) ?? []
    pedidoDraft = (conversacion.pedidoDraft as PedidoDraft) ?? { items: [] }

    // Si la conversación ya terminó, iniciar una nueva
    if (conversacion.estado === 'finalizado' || conversacion.estado === 'pagado') {
      mensajes = []
      pedidoDraft = { items: [] }
      await db.update(WhatsappConversacionTable)
        .set({ mensajes: [], pedidoDraft: null, estado: 'conversando', pedidoUnificadoId: null, updatedAt: new Date() })
        .where(eq(WhatsappConversacionTable.id, conversacion.id))
    }

    // Resetear si la conversación tiene más de 2 horas de inactividad
    const dosHoras = 2 * 60 * 60 * 1000
    const ultimaActividad = new Date(conversacion.updatedAt).getTime()
    if (Date.now() - ultimaActividad > dosHoras) {
      mensajes = []
      pedidoDraft = { items: [] }
      await db.update(WhatsappConversacionTable)
        .set({ mensajes: [], pedidoDraft: null, estado: 'conversando', pedidoUnificadoId: null, updatedAt: new Date() })
        .where(eq(WhatsappConversacionTable.id, conversacion.id))
    }
  } else {
    // Nueva conversación
    const insert = await db.insert(WhatsappConversacionTable).values({
      restauranteId,
      telefono,
      mensajes: [],
      pedidoDraft: null,
      estado: 'conversando',
    })
    const id = Number(insert[0].insertId)
    const [conv] = await db.select().from(WhatsappConversacionTable).where(eq(WhatsappConversacionTable.id, id)).limit(1)
    conversacion = conv
  }

  // 2. Palabra clave de reset (solo para el operador)
  const RESET_KEYWORD = process.env.WHATSAPP_RESET_KEYWORD ?? 'REINICIAR'
  if (texto.trim().toUpperCase() === RESET_KEYWORD) {
    await db.update(WhatsappConversacionTable)
      .set({ mensajes: [], pedidoDraft: null, estado: 'conversando', pedidoUnificadoId: null, updatedAt: new Date() })
      .where(eq(WhatsappConversacionTable.id, conversacion.id))
    await sendWhatsAppText(token, phoneNumberId, {
      phone: telefono,
      text: 'Conversación reiniciada.',
    })
    return
  }

  // 3. Agregar el mensaje del usuario al historial
  mensajes.push({ role: 'user', content: texto })

  // 4. Construir el system prompt con el menú actual
  const systemPrompt = await buildSystemPrompt(db, restauranteId)

  // 4. Llamar a la API de Anthropic
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: mensajes,
    }),
  })

  if (!response.ok) {
    console.error('❌ [WhatsApp IA] Error Anthropic API:', await response.text())
    await sendWhatsAppText(token, phoneNumberId, {
      phone: telefono,
      text: 'Disculpá, tuve un problema técnico. Intentá de nuevo en un momento 🙏',
    })
    return
  }

  const data = await response.json() as any
  const respuestaCompleta: string = data.content?.[0]?.text ?? ''

  // 5. Parsear instrucciones del sistema embebidas en la respuesta
  let mensajeParaCliente = respuestaCompleta
  let pedidoJsonStr: string | null = null
  let pedirMetodoPago = false
  let metodoElegido: string | null = null

  // Extraer PEDIDO_JSON si existe
  const pedidoMatch = respuestaCompleta.match(/PEDIDO_JSON:(\{.+?\})(?:\n|$)/s)
  if (pedidoMatch) {
    pedidoJsonStr = pedidoMatch[1]
    mensajeParaCliente = mensajeParaCliente.replace(pedidoMatch[0], '').trim()
  }

  // Extraer PEDIR_METODO_PAGO si existe
  if (respuestaCompleta.includes('PEDIR_METODO_PAGO:true')) {
    pedirMetodoPago = true
    mensajeParaCliente = mensajeParaCliente.replace('PEDIR_METODO_PAGO:true', '').trim()
  }

  // Extraer METODO_ELEGIDO si existe
  const metodoMatch = respuestaCompleta.match(/METODO_ELEGIDO:"([^"]+)"/)
  if (metodoMatch) {
    metodoElegido = metodoMatch[1]
    mensajeParaCliente = mensajeParaCliente.replace(metodoMatch[0], '').trim()
  }

  console.log('🤖 [IA raw]', JSON.stringify(respuestaCompleta))
  console.log('🔍 [IA parse] pedidoJson:', pedidoJsonStr, '| metodoPago:', pedirMetodoPago, '| metodoElegido:', metodoElegido)

  // 6. Agregar respuesta al historial
  mensajes.push({ role: 'assistant', content: mensajeParaCliente })

  // 7. Procesar acciones según lo que indicó la IA

  // 7a. Si la IA confirmó el pedido → crear en DB y pasar a esperando_pago
  if (pedidoJsonStr) {
    try {
      const pedidoData = JSON.parse(pedidoJsonStr) as {
        tipo: 'delivery' | 'takeaway'
        direccion?: string
        nombreCliente?: string
        items: { productoId: number; nombre: string; cantidad: number; varianteId?: number; agregados?: { id: number; nombre: string; precio: string }[] }[]
      }
      pedidoDraft = {
        tipo: pedidoData.tipo,
        direccion: pedidoData.direccion,
        notas: undefined,
        items: pedidoData.items.map(i => ({
          productoId: i.productoId,
          nombre: i.nombre,
          cantidad: i.cantidad,
          precio: 0, // se recalcula al crear el pedido
          varianteId: i.varianteId,
          agregados: i.agregados,
        })),
      }

      await db.update(WhatsappConversacionTable)
        .set({
          mensajes,
          pedidoDraft,
          nombreCliente: pedidoData.nombreCliente ?? conversacion.nombreCliente,
          updatedAt: new Date(),
        })
        .where(eq(WhatsappConversacionTable.id, conversacion.id))

    } catch (err) {
      console.error('❌ [WhatsApp IA] Error parseando PEDIDO_JSON:', err)
    }
  }

  // 7b. Si el cliente eligió método de pago → crear pedido real y enviar datos de pago
  if (metodoElegido && pedidoDraft.tipo) {
    try {
      const resultado = await crearPedidoYObtenerPago(db, restauranteId, telefono, pedidoDraft, metodoElegido, conversacion.nombreCliente)

      if (resultado.success && resultado.pedidoId) {
        // Marcar conversación como esperando pago
        await db.update(WhatsappConversacionTable)
          .set({
            mensajes,
            estado: 'esperando_pago',
            pedidoUnificadoId: resultado.pedidoId,
            updatedAt: new Date(),
          })
          .where(eq(WhatsappConversacionTable.id, conversacion.id))

        // Enviar primero el mensaje de la IA
        await sendWhatsAppText(token, phoneNumberId, { phone: telefono, text: mensajeParaCliente })

        // Luego enviar los datos de pago
        if (resultado.linkPago) {
          await sendWhatsAppText(token, phoneNumberId, {
            phone: telefono,
            text: `💳 *Link de pago MercadoPago:*\n${resultado.linkPago}`,
          })
        } else if (resultado.alias) {
          await sendWhatsAppText(token, phoneNumberId, {
            phone: telefono,
            text: `Alias: ${resultado.alias}\nMonto: $${resultado.total}`,
          })
        }
        return // Ya enviamos los mensajes
      }
    } catch (err) {
      console.error('❌ [WhatsApp IA] Error creando pedido:', err)
    }
  }

  // 8. Guardar estado actualizado de la conversación
  await db.update(WhatsappConversacionTable)
    .set({
      mensajes,
      pedidoDraft: Object.keys(pedidoDraft).length > 1 || pedidoDraft.items.length > 0 ? pedidoDraft : conversacion.pedidoDraft,
      updatedAt: new Date(),
    })
    .where(eq(WhatsappConversacionTable.id, conversacion.id))

  // 9. Enviar respuesta al cliente
  if (mensajeParaCliente.trim()) {
    await sendWhatsAppText(token, phoneNumberId, { phone: telefono, text: mensajeParaCliente.trim() })
  }
}

// ─── Crear pedido en DB ───────────────────────────────────────────────────────

async function crearPedidoYObtenerPago(
  db: any,
  restauranteId: number,
  telefono: string,
  draft: PedidoDraft,
  metodoElegido: string,
  nombreCliente: string | null
): Promise<{ success: boolean; pedidoId?: number; linkPago?: string; alias?: string; total?: string; error?: string }> {

  if (!draft.tipo || draft.items.length === 0) {
    return { success: false, error: 'Pedido incompleto' }
  }

  const { inArray } = await import('drizzle-orm')

  // Obtener precios actuales de los productos (no confiar en el draft)
  const productoIds = [...new Set(draft.items.map(i => i.productoId))]
  const productosRaw = await db
    .select()
    .from(ProductoTable)
    .where(and(
      inArray(ProductoTable.id, productoIds),
      eq(ProductoTable.restauranteId, restauranteId)
    ))
  const productosMap = new Map(productosRaw.map((p: any) => [p.id, p]))

  const varianteIds = draft.items.map(i => i.varianteId).filter(Boolean) as number[]
  let variantesMap = new Map()
  if (varianteIds.length > 0) {
    const variantesRaw = await db
      .select()
      .from(VarianteProductoTable)
      .where(inArray(VarianteProductoTable.id, varianteIds))
    variantesMap = new Map(variantesRaw.map((v: any) => [v.id, v]))
  }

  // Calcular total
  let total = 0
  const itemsConPrecio = draft.items.map(item => {
    const prod = productosMap.get(item.productoId) as any
    if (!prod) throw new Error(`Producto ${item.productoId} no encontrado`)
    let precio = parseFloat(prod.precio)
    if (item.varianteId && variantesMap.has(item.varianteId)) {
      precio = parseFloat(variantesMap.get(item.varianteId).precio)
    }
    if (item.agregados?.length) {
      for (const ag of item.agregados) precio += parseFloat(ag.precio)
    }
    total += precio * item.cantidad
    return { ...item, precio }
  })

  // Delivery fee (flat, sin zonas por ahora — el agente no valida coordenadas)
  const [resData] = await db
    .select({
      id: RestauranteTable.id,
      deliveryFee: RestauranteTable.deliveryFee,
      username: RestauranteTable.username,
      cucuruConfigurado: RestauranteTable.cucuruConfigurado,
      cucuruEnabled: RestauranteTable.cucuruEnabled,
      cucuruApiKey: RestauranteTable.cucuruApiKey,
      cucuruCollectorId: RestauranteTable.cucuruCollectorId,
      mpConnected: RestauranteTable.mpConnected,
      mpPublicKey: RestauranteTable.mpPublicKey,
      mpAccessToken: RestauranteTable.mpAccessToken,
      proveedorPago: RestauranteTable.proveedorPago,
      transferenciaAlias: RestauranteTable.transferenciaAlias,
      metodosPagoConfig: RestauranteTable.metodosPagoConfig,
      cardsPaymentsEnabled: RestauranteTable.cardsPaymentsEnabled,
      taloClientId: RestauranteTable.taloClientId,
      taloClientSecret: RestauranteTable.taloClientSecret,
      taloUserId: RestauranteTable.taloUserId,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  if (draft.tipo === 'delivery' && resData.deliveryFee) {
    total += parseFloat(resData.deliveryFee)
  }

  // Resolver método de pago
  const pagoRow = rowToPagoRow(resData)

  // Mapear selección del usuario a método interno
  const metodoMapeado = metodoElegido === 'mercadopago' ? 'mercadopago_checkout'
    : metodoElegido === 'cucuru' ? 'transferencia_automatica_cucuru'
    : metodoElegido === 'transferencia_manual' ? 'manual_transfer'
    : metodoElegido

  const resolved = resolverMetodoPagoPedido(metodoMapeado, pagoRow)
  console.log('🔍 [Cucuru debug] metodoMapeado:', metodoMapeado, '| resolved:', resolved, '| pagoRow.cucuruConfigurado:', pagoRow.cucuruConfigurado, '| proveedorPago:', pagoRow.proveedorPago)
  if (resolved.error || !resolved.metodo) {
    return { success: false, error: resolved.error || 'Método de pago no disponible' }
  }

  // Crear el pedido
  const nuevoPedido = await db.insert(PedidoUnificadoTable).values({
    restauranteId,
    tipo: draft.tipo,
    direccion: draft.direccion ?? null,
    nombreCliente: nombreCliente ?? null,
    telefono,
    notas: draft.notas ?? null,
    metodoPago: resolved.metodo,
    estado: 'pending',
    total: total.toFixed(2),
    pagado: false,
    grupal: false,
  })

  const pedidoId = Number(nuevoPedido[0].insertId)

  // Insertar items
  for (const item of itemsConPrecio) {
    await db.insert(ItemPedidoUnificadoTable).values({
      pedidoId,
      productoId: item.productoId,
      varianteId: item.varianteId ?? null,
      varianteNombre: item.varianteId && variantesMap.has(item.varianteId)
        ? variantesMap.get(item.varianteId).nombre
        : null,
      cantidad: item.cantidad,
      precioUnitario: item.precio.toFixed(2),
      ingredientesExcluidos: null,
      agregados: item.agregados?.length ? item.agregados : null,
      esCanjePuntos: false,
    })
  }

  // Notificar al admin via WebSocket
  const mesaNombre = draft.tipo === 'delivery' ? 'Delivery' : 'Take Away'
  const notifId = `notif-${Date.now()}-${Math.floor(Math.random() * 10000)}`
  wsManager.notifyAdmins(restauranteId, {
    id: notifId,
    tipo: 'NUEVO_PEDIDO_PENDIENTE_PAGO',
    mesaId: 0,
    mesaNombre,
    mensaje: `Nuevo pedido por WhatsApp (${mesaNombre})`,
    detalles: `${nombreCliente ?? telefono} — $${total.toFixed(2)}`,
    timestamp: new Date().toISOString(),
    leida: false,
    pedidoId,
  })

  await emitirEventoPedido(db, {
    restauranteId,
    pedidoId,
    tipo: draft.tipo,
    sucursalId: null,
    event: 'upsert',
    reason: 'created',
    shouldPrint: false,
  })

  // Generar datos de pago según método
  const proveedor = proveedorTransferenciaDinamica(resolved.metodo, pagoRow)

  if (proveedor === 'cucuru' && resData.cucuruConfigurado) {
    try {
      const cuentaCucuru = await asignarAliasAPedido({
        db,
        restaurante: resData,
        pedidoId,
        slug: resData.username!,
        tipoPedido: draft.tipo,
      })
      const alias = (cuentaCucuru as any)?.alias ?? resData.transferenciaAlias
      return { success: true, pedidoId, alias, total: total.toFixed(2) }
    } catch (err) {
      console.error('❌ [WhatsApp IA] Error Cucuru:', err)
      return { success: true, pedidoId, alias: resData.transferenciaAlias ?? undefined, total: total.toFixed(2) }
    }
  }

  if (resolved.metodo === 'manual_transfer') {
    return { success: true, pedidoId, alias: resData.transferenciaAlias ?? undefined, total: total.toFixed(2) }
  }

  // MercadoPago — generar preferencia
  if (resData.mpConnected && resData.mpAccessToken) {
    try {
      const mpBody = {
        items: itemsConPrecio.map(i => ({
          title: i.nombre,
          quantity: i.cantidad,
          unit_price: i.precio,
          currency_id: 'ARS',
        })),
        back_urls: {
          success: `https://piru.app/pedido/${pedidoId}`,
          failure: `https://piru.app/pedido/${pedidoId}`,
        },
        auto_return: 'approved',
        external_reference: String(pedidoId),
      }
      const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resData.mpAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(mpBody),
      })
      const mpData = await mpRes.json() as any
      if (mpData.init_point) {
        return { success: true, pedidoId, linkPago: mpData.init_point, total: total.toFixed(2) }
      }
    } catch (err) {
      console.error('❌ [WhatsApp IA] Error MP:', err)
    }
  }

  return { success: true, pedidoId, total: total.toFixed(2) }
}

/**
 * Notifica al cliente por WhatsApp que su pago fue confirmado.
 * Busca la conversación activa por teléfono y restaurante, manda el mensaje,
 * y marca la conversación como 'pagado'.
 * Se llama desde los webhooks de Cucuru y MercadoPago.
 */
export async function notificarPagoConfirmadoWhatsApp({
  restauranteId,
  pedidoId,
  telefono,
}: {
  restauranteId: number
  pedidoId: number
  telefono: string | null
}): Promise<void> {
  if (!telefono) return

  const db = drizzle(pool)

  const conversaciones = await db
    .select()
    .from(WhatsappConversacionTable)
    .where(and(
      eq(WhatsappConversacionTable.restauranteId, restauranteId),
      eq(WhatsappConversacionTable.telefono, telefono),
      eq(WhatsappConversacionTable.pedidoUnificadoId, pedidoId)
    ))
    .limit(1)

  if (conversaciones.length === 0) return

  const conversacion = conversaciones[0]

  const restaurantes = await db
    .select({
      whatsappPhoneId: RestauranteTable.whatsappPhoneId,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  if (!restaurantes[0]?.whatsappPhoneId) return

  const token = process.env.WHATSAPP_API_TOKEN!
  const phoneNumberId = restaurantes[0].whatsappPhoneId

  await sendWhatsAppText(token, phoneNumberId, {
    phone: telefono,
    text: 'Ahi recibimos tu pago, ya estamos preparando tu pedido',
  })

  await db.update(WhatsappConversacionTable)
    .set({ estado: 'pagado', updatedAt: new Date() })
    .where(eq(WhatsappConversacionTable.id, conversacion.id))

  console.log(`✅ [WhatsApp IA] Pago confirmado notificado al cliente ${telefono} (pedido #${pedidoId})`)
}