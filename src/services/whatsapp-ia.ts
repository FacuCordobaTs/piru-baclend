// Backend/src/services/whatsapp-ia.ts
// Agente IA que maneja conversaciones de pedidos por WhatsApp

import { drizzle } from 'drizzle-orm/mysql2'
import { eq, and, gte, desc } from 'drizzle-orm'
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
  horarioRestaurante as HorarioRestauranteTable,
  mensajeWhatsapp as MensajeWhatsappTable,
} from '../db/schema'
import { sendWhatsAppText } from './whatsapp'
import { geocodificarYValidarZona } from './geocoding'
import { asignarAliasAPedido } from './cucuru'
import { wsManager } from '../websocket/manager'
import { emitirEventoPedido } from '../lib/pedidos-activos'
import { rowToPagoRow, resolverMetodoPagoPedido, proveedorTransferenciaDinamica } from '../lib/metodos-pago'

const WHATSAPP_IA_ENABLED = false

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
  precioDelivery?: string
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
 * Construye el mensaje de carta estructurado para WhatsApp.
 * Agrupa productos por categoría con variantes, ingredientes y extras.
 */
async function construirMensajeCarta(db: any, restauranteId: number): Promise<string> {
  const productos = await db
    .select({
      id: ProductoTable.id,
      nombre: ProductoTable.nombre,
      descripcion: ProductoTable.descripcion,
      precio: ProductoTable.precio,
      categoriaNombre: CategoriaTable.nombre,
    })
    .from(ProductoTable)
    .leftJoin(CategoriaTable, eq(ProductoTable.categoriaId, CategoriaTable.id))
    .where(and(
      eq(ProductoTable.restauranteId, restauranteId),
      eq(ProductoTable.activo, true)
    ))

  if (productos.length === 0) return 'No hay productos disponibles por el momento.'

  const porCategoria = new Map<string, typeof productos>()
  for (const p of productos) {
    const cat = p.categoriaNombre ?? 'Otros'
    if (!porCategoria.has(cat)) porCategoria.set(cat, [])
    porCategoria.get(cat)!.push(p)
  }

  const lineas: string[] = []
  for (const [cat, prods] of porCategoria) {
    if (lineas.length > 0) lineas.push('')
    lineas.push(`*${cat.toUpperCase()}*`)

    for (const p of prods) {
      const ingredientes = await db
        .select({ nombre: IngredienteTable.nombre })
        .from(ProductoIngredienteTable)
        .innerJoin(IngredienteTable, eq(ProductoIngredienteTable.ingredienteId, IngredienteTable.id))
        .where(eq(ProductoIngredienteTable.productoId, p.id))

      const variantes = await db
        .select({ nombre: VarianteProductoTable.nombre, precio: VarianteProductoTable.precio })
        .from(VarianteProductoTable)
        .where(eq(VarianteProductoTable.productoId, p.id))

      const agregados = await db
        .select({ nombre: AgregadoTable.nombre, precio: AgregadoTable.precio })
        .from(ProductoAgregadoTable)
        .innerJoin(AgregadoTable, eq(ProductoAgregadoTable.agregadoId, AgregadoTable.id))
        .where(eq(ProductoAgregadoTable.productoId, p.id))

      const precioBase = variantes.length > 0
        ? `desde $${Math.min(...variantes.map((v: any) => parseFloat(v.precio))).toFixed(0)}`
        : `$${p.precio}`

      lineas.push(`${p.nombre} — ${precioBase}`)
      if (p.descripcion) lineas.push(p.descripcion)
      if (ingredientes.length > 0) lineas.push(`Ingredientes: ${ingredientes.map((i: any) => i.nombre).join(', ')}`)
      if (variantes.length > 0) lineas.push(`Variantes: ${variantes.map((v: any) => `${v.nombre} $${v.precio}`).join(' | ')}`)
      if (agregados.length > 0) lineas.push(`Extras: ${agregados.map((a: any) => `${a.nombre} +$${a.precio}`).join(' | ')}`)
    }
  }

  return lineas.join('\n')
}

const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

interface HorarioInfo {
  estaAbierto: boolean
  textoHorarios: string
}

async function obtenerHorarioInfo(db: any, restauranteId: number): Promise<HorarioInfo> {
  const horarios = await db
    .select()
    .from(HorarioRestauranteTable)
    .where(eq(HorarioRestauranteTable.restauranteId, restauranteId))

  if (horarios.length === 0) {
    return { estaAbierto: true, textoHorarios: '' }
  }

  // Agrupar franjas por día
  const porDia = new Map<number, { apertura: string; cierre: string }[]>()
  for (const h of horarios) {
    if (!porDia.has(h.diaSemana)) porDia.set(h.diaSemana, [])
    porDia.get(h.diaSemana)!.push({ apertura: h.horaApertura, cierre: h.horaCierre })
  }

  // Construir texto legible de horarios
  const lineas: string[] = []
  for (let dia = 0; dia < 7; dia++) {
    const franjas = porDia.get(dia)
    if (!franjas || franjas.length === 0) {
      lineas.push(`${DIAS_SEMANA[dia]}: cerrado`)
    } else {
      const franjasTexto = franjas.map(f => `${f.apertura} a ${f.cierre}`).join(' y ')
      lineas.push(`${DIAS_SEMANA[dia]}: ${franjasTexto}`)
    }
  }
  const textoHorarios = lineas.join('\n')

  // Calcular si está abierto ahora (hora de Argentina, UTC-3)
  const ahora = new Date()
  const ahoraAr = new Date(ahora.getTime() - 3 * 60 * 60 * 1000)
  const diaActual = ahoraAr.getUTCDay() // 0=Dom...6=Sáb
  const horaActual = ahoraAr.getUTCHours()
  const minActual = ahoraAr.getUTCMinutes()
  const minutosActuales = horaActual * 60 + minActual

  const franjasHoy = porDia.get(diaActual) ?? []
  const estaAbierto = franjasHoy.some(f => {
    const [ah, am] = f.apertura.split(':').map(Number)
    const [ch, cm] = f.cierre.split(':').map(Number)
    const minApertura = ah * 60 + am
    let minCierre = ch * 60 + cm
    // Si el cierre es antes de la apertura, cruza la medianoche
    if (minCierre <= minApertura) minCierre += 24 * 60
    return minutosActuales >= minApertura && minutosActuales < minCierre
  })

  return { estaAbierto, textoHorarios }
}

/**
 * Construye el system prompt completo para el agente.
 */
async function buildSystemPrompt(db: any, restauranteId: number, inactivoPorTiempo = false): Promise<{ prompt: string; direccionTexto: string | null }> {
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
      direccionTexto: RestauranteTable.direccionTexto,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  const menu = await obtenerMenuParaPrompt(db, restauranteId)
  const { estaAbierto, textoHorarios } = await obtenerHorarioInfo(db, restauranteId)

  const tiposDisponibles = []
  if (restaurante.deliveryEnabled) tiposDisponibles.push('delivery (el cliente da su dirección)')
  if (restaurante.takeawayEnabled) tiposDisponibles.push('takeaway (retira en el local)')

  const pagoRow = rowToPagoRow(restaurante)
  const metodos: string[] = []
  if (restaurante.mpConnected) metodos.push('mercadopago (se le envía link de pago)')
  if (restaurante.cucuruConfigurado && restaurante.cucuruEnabled) metodos.push('transferencia (alias único generado automáticamente)')
  if (restaurante.transferenciaAlias) metodos.push('transferencia manual (alias fijo del local)')

  const notaInactividad = inactivoPorTiempo
    ? `\nNOTA DE CONTEXTO: Han pasado más de 2 horas desde la última interacción con este cliente. Al responder, preguntale amablemente si quiere hacer un nuevo pedido o si quiere continuar con lo que estaban hablando antes.\n`
    : ''

  const notaUbicacion = restaurante.direccionTexto
    ? `UBICACIÓN DEL RESTAURANTE: ${restaurante.direccionTexto}\nCuando el cliente dé una dirección sin especificar ciudad, asumir que es en la misma ciudad que el restaurante. No preguntar la localidad.\n`
    : ''

  const notaEstadoApertura = textoHorarios
    ? `ESTADO ACTUAL DEL LOCAL: ${estaAbierto ? 'ABIERTO' : 'CERRADO'}
HORARIOS DE ATENCIÓN:
${textoHorarios}
Si el local está CERRADO y el cliente intenta hacer un pedido, informale amablemente que en este momento están cerrados y mencioná cuándo vuelven a abrir según los horarios. Si el cliente solo pregunta los horarios, respondé con los días y horarios en texto plano, sin markdown.\n`
    : ''

  const prompt = `${notaInactividad}${notaUbicacion}${notaEstadoApertura}Sos el asistente de pedidos de ${restaurante.nombre} por WhatsApp. Tu trabajo es tomar pedidos de los clientes de forma simple y directa, como lo haría una persona.

REGLAS FUNDAMENTALES:
- Hablá en español argentino, informal, como un humano. Sin formalismos ni frases robóticas.
- Mensajes CORTOS y directos. Sin asteriscos para negritas, sin guiones para listas, sin emojis, sin separadores. Texto plano solamente.
- Nunca uses markdown: nada de **, *, -, --, ni emojis.
- Nunca mencionás que sos una IA o un sistema. Sos el asistente del local.
- No inventés precios ni productos que no están en el menú.
- Nunca uses "—" ni ningún separador entre el nombre del producto y el precio. Si necesitás listar items, escribilos en texto corrido o en líneas simples sin separadores.
- NO mandes resumen del pedido antes de mandar el alias o el link de pago. Cuando ya tenés todo confirmado, tu único mensaje es una frase corta como "Perfecto, te mando los datos." y nada más. El sistema manda el alias aparte.
- NO repitas lo que el cliente ya dijo. Si ya confirmó los items, tipo y método de pago, no los enumeres de vuelta. Avanzá directamente al siguiente paso.
- NO mandes resumen del pedido antes de mandar el alias. Cuando el cliente elige transferencia, tu único mensaje es una frase corta del tipo "Perfecto, te mando los datos." El alias y monto los manda el sistema aparte.
- Nunca muestres el total antes de mandar el alias. El sistema ya lo incluye.

CUANDO EL CLIENTE PIDE EL MENÚ O LA CARTA:
Respondé ÚNICAMENTE con una frase corta de saludo, como "Hola! te paso la carta" o "Dale, acá va". NO listés los productos vos — el sistema los manda automáticamente. Incluí ENVIAR_CARTA:true en tu respuesta y nada más.

MÉTODO DE PAGO TRANSFERENCIA:
Cuando el cliente elige transferencia, NO le preguntés nada más. NO le explicés qué es un alias único. Simplemente incluí METODO_ELEGIDO:"cucuru" en tu respuesta y el sistema le manda los datos automáticamente. Tu mensaje al cliente puede ser algo como "Perfecto, te mando los datos para transferir." y nada más.

TOOL DE HISTORIAL DE PEDIDOS:
Cuando el cliente pregunte por sus pedidos anteriores, quiera saber el estado de un pedido, o quiera repetir un pedido anterior, llamá al tool buscar_pedidos_cliente. No lo llames sin que el cliente lo pida explícitamente.

TOOL DE GEOLOCALIZACIÓN:
Cuando el cliente dé una dirección para delivery, llamá al tool geolocalizar_direccion con la calle y el número separados.
No intentes adivinar si está en zona — siempre usá el tool. El tool te va a decir si la dirección está dentro de una zona de cobertura y cuánto cuesta el delivery.
Si el tool dice que está fuera de zona, informale al cliente amablemente que no llegamos a esa dirección.
Si el tool encuentra la dirección, confirmale la dirección formateada y el costo de envío, y seguí con el pedido.

FLUJO DEL PEDIDO:
1. Saludar y preguntar qué quiere pedir (o mostrar el menú si lo pide)
2. Confirmar los items con el cliente (cantidad, variantes, extras si hay)
3. Preguntar si es delivery o takeaway${restaurante.deliveryEnabled && restaurante.takeawayEnabled ? '' : ` (solo está disponible: ${tiposDisponibles.join(' y ')})`}
4. Si es delivery: pedirle la dirección
5. Mostrar el resumen del pedido con el total y preguntar el método de pago
6. Según el método elegido: enviar link de MP o alias de transferencia
7. Cuando se confirme el pago, avisarle que el pedido fue registrado
- Si el cliente menciona el método de pago en el mismo mensaje que el pedido (ej: "quiero X, lo pago con transferencia"), no lo preguntes de nuevo. Incluí directamente METODO_ELEGIDO con el método que dijo.
- PEDIR_METODO_PAGO solo usalo cuando realmente necesitás preguntarle al cliente. Si ya lo dijo, no lo incluyas o ponelo en false — pero en cualquier caso nunca debe aparecer en el mensaje visible al cliente.

TIPOS DE PEDIDO DISPONIBLES: ${tiposDisponibles.join(', ')}

MÉTODOS DE PAGO DISPONIBLES: ${metodos.join(', ')}
${restaurante.deliveryFee && parseFloat(restaurante.deliveryFee) > 0 ? `\nCOSTO DE DELIVERY: $${restaurante.deliveryFee} (se suma al total)` : ''}

MENÚ ACTUAL:
${menu}

INSTRUCCIONES TÉCNICAS PARA CREAR EL PEDIDO:
Cuando el cliente confirme los items y estés listo para proceder al pago, tu respuesta DEBE incluir un bloque JSON al final con este formato exacto (después de tu mensaje al cliente):

PEDIDO_JSON:{"tipo":"delivery"|"takeaway","direccion":"...solo si es delivery...","nombreCliente":"...si lo dijo...","items":[{"productoId":123,"nombre":"...","cantidad":1,"varianteId":456,"agregados":[{"id":1,"nombre":"...","precio":"500.00"}]}]}

Este bloque es solo para el sistema, el cliente no lo ve. Solo incluirlo cuando el cliente haya confirmado todo y esté listo para pagar.

Cuando el cliente pida el menú o la carta, incluir al final:
ENVIAR_CARTA:true

Cuando debas preguntar el método de pago, incluir al final:
PEDIR_METODO_PAGO:true

Cuando el cliente elija el método de pago, incluir al final:
METODO_ELEGIDO:"mercadopago"|"cucuru"|"transferencia_manual"`

  return { prompt, direccionTexto: restaurante.direccionTexto ?? null }
}

interface MensajeReciente {
  tipo: 'pedido_confirmado' | 'pedido_despachado'
  enviadoAt: Date
}

async function obtenerMensajesRecientes(db: any, restauranteId: number, telefono: string): Promise<MensajeReciente[]> {
  const ocho_horas_atras = new Date(Date.now() - 8 * 60 * 60 * 1000)
  const registros = await db
    .select({
      tipo: MensajeWhatsappTable.tipo,
      createdAt: MensajeWhatsappTable.createdAt,
    })
    .from(MensajeWhatsappTable)
    .where(and(
      eq(MensajeWhatsappTable.restauranteId, restauranteId),
      eq(MensajeWhatsappTable.telefono, telefono),
      gte(MensajeWhatsappTable.createdAt, ocho_horas_atras)
    ))
    .orderBy(desc(MensajeWhatsappTable.createdAt))
    .limit(5)

  return registros
    .filter((r: any) => r.tipo !== null)
    .map((r: any) => ({ tipo: r.tipo as MensajeReciente['tipo'], enviadoAt: new Date(r.createdAt) }))
}

function formatearContextoMensajesRecientes(mensajes: MensajeReciente[], textoMensajeCliente: string): string {
  if (mensajes.length === 0) return ''

  const ahora = new Date()
  const lineas = mensajes.map(m => {
    const minutosAtras = Math.round((ahora.getTime() - m.enviadoAt.getTime()) / 60_000)
    const tiempoTexto = minutosAtras < 60
      ? `hace ${minutosAtras} minutos`
      : `hace ${Math.round(minutosAtras / 60)} horas`
    const tipoTexto = m.tipo === 'pedido_confirmado'
      ? 'confirmación de pago y pedido en cocina'
      : 'aviso de pedido listo/en camino'
    return `- Notificación "${tipoTexto}" enviada ${tiempoTexto} (${m.enviadoAt.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })})`
  })

  return `\nCONTEXTO: En las últimas 8 horas se enviaron estas notificaciones automáticas a este cliente:\n${lineas.join('\n')}\nEl cliente acaba de responder: "${textoMensajeCliente}"\nSi el mensaje del cliente parece una respuesta a alguna de esas notificaciones (agradecimiento, consulta sobre su pedido, etc.), respondé en ese contexto. No preguntes si quiere hacer un pedido si claramente está respondiendo a una notificación previa.\n`
}

async function buscarUltimosPedidosCliente(db: any, restauranteId: number, telefono: string): Promise<string> {
  const pedidos = await db
    .select({
      id: PedidoUnificadoTable.id,
      tipo: PedidoUnificadoTable.tipo,
      estado: PedidoUnificadoTable.estado,
      total: PedidoUnificadoTable.total,
      pagado: PedidoUnificadoTable.pagado,
      createdAt: PedidoUnificadoTable.createdAt,
      direccion: PedidoUnificadoTable.direccion,
    })
    .from(PedidoUnificadoTable)
    .where(and(
      eq(PedidoUnificadoTable.restauranteId, restauranteId),
      eq(PedidoUnificadoTable.telefono, telefono)
    ))
    .orderBy(desc(PedidoUnificadoTable.createdAt))
    .limit(3)

  if (pedidos.length === 0) {
    return JSON.stringify({ pedidos: [], mensaje: 'El cliente no tiene pedidos anteriores en este restaurante.' })
  }

  const pedidosConItems = await Promise.all(pedidos.map(async (pedido: any) => {
    const items = await db
      .select({
        nombre: ProductoTable.nombre,
        cantidad: ItemPedidoUnificadoTable.cantidad,
        varianteNombre: ItemPedidoUnificadoTable.varianteNombre,
        precioUnitario: ItemPedidoUnificadoTable.precioUnitario,
        agregados: ItemPedidoUnificadoTable.agregados,
      })
      .from(ItemPedidoUnificadoTable)
      .leftJoin(ProductoTable, eq(ItemPedidoUnificadoTable.productoId, ProductoTable.id))
      .where(eq(ItemPedidoUnificadoTable.pedidoId, pedido.id))

    const fecha = new Date(pedido.createdAt)
    const fechaFormateada = fecha.toLocaleDateString('es-AR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })

    return {
      id: pedido.id,
      tipo: pedido.tipo,
      estado: pedido.estado,
      total: `$${pedido.total}`,
      pagado: pedido.pagado,
      fecha: fechaFormateada,
      ...(pedido.direccion ? { direccion: pedido.direccion } : {}),
      items: items.map((item: any) => ({
        nombre: item.nombre ?? 'Producto eliminado',
        cantidad: item.cantidad,
        ...(item.varianteNombre ? { variante: item.varianteNombre } : {}),
        ...(item.agregados?.length ? { extras: item.agregados.map((a: any) => a.nombre) } : {}),
      })),
    }
  }))

  return JSON.stringify({ pedidos: pedidosConItems })
}

function extraerCiudad(direccionTexto: string | null): string {
  if (!direccionTexto) return 'Argentina'
  const partes = direccionTexto.split(',').map(p => p.trim())
  if (partes.length >= 2) {
    return partes.slice(-2).join(', ')
  }
  return direccionTexto
}

// ─── Debounce por conversación ────────────────────────────────────────────────

interface DebounceEntry {
  timer: ReturnType<typeof setTimeout>
  textos: string[]
}
const debounceMap = new Map<string, DebounceEntry>()
const getDebounceMs = () => Math.floor(Math.random() * (9_000 - 5_000 + 1)) + 5_000

export async function procesarMensajeIA(params: ProcesarMensajeParams): Promise<void> {
  if (!WHATSAPP_IA_ENABLED) return

  const key = `${params.restauranteId}:${params.telefono}`
  const entry = debounceMap.get(key)

  if (entry) {
    clearTimeout(entry.timer)
    entry.textos.push(params.texto)
  } else {
    debounceMap.set(key, { timer: null as any, textos: [params.texto] })
  }

  const current = debounceMap.get(key)!

  current.timer = setTimeout(async () => {
    debounceMap.delete(key)
    const textoFinal = current.textos.join('\n')
    await procesarMensajeIAInterno({ ...params, texto: textoFinal }).catch(err =>
      console.error('❌ [WhatsApp IA] Error en debounce handler:', err)
    )
  }, getDebounceMs())
}

// ─── Función principal ────────────────────────────────────────────────────────

async function procesarMensajeIAInterno(params: ProcesarMensajeParams): Promise<void> {
  const { restauranteId, telefono, texto } = params
  const db = drizzle(pool)

  const [resTokenData] = await db
    .select({
      whatsappAccessToken: RestauranteTable.whatsappAccessToken,
      whatsappPhoneId: RestauranteTable.whatsappPhoneId,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  const token = resTokenData?.whatsappAccessToken ?? process.env.WHATSAPP_API_TOKEN!
  const phoneNumberId = resTokenData?.whatsappPhoneId ?? params.phoneNumberId

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
  let inactivoPorTiempo = false

  if (conversacion) {
    mensajes = (conversacion.mensajes as MensajeHistorial[]) ?? []
    pedidoDraft = (conversacion.pedidoDraft as PedidoDraft) ?? { items: [] }

    const dosHoras = 2 * 60 * 60 * 1000
    const ultimaActividad = new Date(conversacion.updatedAt).getTime()
    if (Date.now() - ultimaActividad > dosHoras) {
      inactivoPorTiempo = true
    }

    // Si la conversación ya terminó, iniciar una nueva
    if (conversacion.estado === 'finalizado' || conversacion.estado === 'pagado') {
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
  const [{ prompt: systemPromptBase, direccionTexto: restauranteDireccionTexto }, mensajesRecientes] = await Promise.all([
    buildSystemPrompt(db, restauranteId, inactivoPorTiempo),
    obtenerMensajesRecientes(db, restauranteId, telefono),
  ])
  const contextoMensajesRecientes = formatearContextoMensajesRecientes(mensajesRecientes, texto)
  const systemPrompt = contextoMensajesRecientes
    ? contextoMensajesRecientes + systemPromptBase
    : systemPromptBase

  // 4. Llamar a la API de Anthropic con tool de geolocalización
  const tools = [
    {
      name: 'buscar_pedidos_cliente',
      description: 'Devuelve los últimos 3 pedidos realizados por el cliente en este restaurante. Llamar cuando el cliente pregunte por sus pedidos anteriores, historial de compras, o quiera repetir un pedido.',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'geolocalizar_direccion',
      description: 'Geocodifica una dirección del cliente y verifica si está dentro de una zona de delivery del restaurante. Llamar cuando el cliente proporcione una dirección para delivery.',
      input_schema: {
        type: 'object',
        properties: {
          calle: {
            type: 'string',
            description: 'Nombre de la calle, limpio y sin el número. Ej: "San Martín", "Hipólito Yrigoyen"',
          },
          numero: {
            type: 'string',
            description: 'Número de la altura. Ej: "811", "2835"',
          },
        },
        required: ['calle', 'numero'],
      },
    },
  ]

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
      tools,
    }),
  })

  if (!response.ok) {
    console.error('❌ [WhatsApp IA] Error Anthropic API:', await response.text())
    await sendWhatsAppText(token, phoneNumberId, {
      phone: telefono,
      text: 'Disculpá, tuve un problema técnico. Intentá de nuevo en un momento.',
    })
    return
  }

  const data = await response.json() as any

  let respuestaCompleta: string

  // Manejar tool_use: si Claude quiere geocodificar, ejecutar y continuar
  if (data.stop_reason === 'tool_use') {
    const toolUseBlock = data.content.find((b: any) => b.type === 'tool_use')
    if (toolUseBlock?.name === 'geolocalizar_direccion') {
      const { calle, numero } = toolUseBlock.input as { calle: string; numero: string }
      console.log(`📍 [WhatsApp IA] Geocodificando: "${calle} ${numero}" para restaurante ${restauranteId}`)

      const ciudadRestaurante = extraerCiudad(restauranteDireccionTexto)
      const geoResult = await geocodificarYValidarZona(calle, numero, restauranteId, ciudadRestaurante)

      let toolResultContent: string
      if (geoResult.success) {
        toolResultContent = JSON.stringify({
          encontrada: true,
          direccionFormateada: geoResult.direccionFormateada,
          zona: geoResult.zona.nombre,
          precioDelivery: geoResult.zona.precio,
        })
        pedidoDraft.precioDelivery = geoResult.zona.precio
        pedidoDraft.direccion = geoResult.direccionFormateada
      } else if (geoResult.fueraDeZona) {
        toolResultContent = JSON.stringify({
          encontrada: false,
          direccionFormateada: geoResult.direccionFormateada,
          mensaje: 'La dirección está fuera de la zona de delivery del restaurante.',
        })
      } else {
        toolResultContent = JSON.stringify({
          encontrada: false,
          mensaje: geoResult.error,
        })
      }

      const mensajesConTool = [
        ...mensajes,
        { role: 'assistant', content: data.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseBlock.id,
              content: toolResultContent,
            },
          ],
        },
      ]

      const response2 = await fetch('https://api.anthropic.com/v1/messages', {
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
          messages: mensajesConTool,
          tools,
        }),
      })

      const data2 = await response2.json() as any
      const textBlock2 = data2.content?.find((b: any) => b.type === 'text')
      respuestaCompleta = textBlock2?.text ?? ''

      // Guardar en historial solo el texto visible
      mensajes.push({ role: 'assistant', content: data.content } as any)
      mensajes.push({
        role: 'user', content: [
          { type: 'tool_result', tool_use_id: toolUseBlock.id, content: toolResultContent }
        ]
      } as any)
      mensajes.push({ role: 'assistant', content: respuestaCompleta })
    } else if (toolUseBlock?.name === 'buscar_pedidos_cliente') {
      console.log(`📋 [WhatsApp IA] Buscando historial de pedidos para ${telefono}`)
      const historialResult = await buscarUltimosPedidosCliente(db, restauranteId, telefono)

      const mensajesConTool = [
        ...mensajes,
        { role: 'assistant', content: data.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseBlock.id,
              content: historialResult,
            },
          ],
        },
      ]

      const response2 = await fetch('https://api.anthropic.com/v1/messages', {
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
          messages: mensajesConTool,
          tools,
        }),
      })

      const data2 = await response2.json() as any
      const textBlock2 = data2.content?.find((b: any) => b.type === 'text')
      respuestaCompleta = textBlock2?.text ?? ''

      mensajes.push({ role: 'assistant', content: data.content } as any)
      mensajes.push({
        role: 'user', content: [
          { type: 'tool_result', tool_use_id: toolUseBlock.id, content: historialResult }
        ]
      } as any)
      mensajes.push({ role: 'assistant', content: respuestaCompleta })
    } else {
      respuestaCompleta = data.content?.find((b: any) => b.type === 'text')?.text ?? ''
      mensajes.push({ role: 'assistant', content: respuestaCompleta })
    }
  } else {
    // Respuesta normal sin tool
    const textBlock = data.content?.find((b: any) => b.type === 'text')
    respuestaCompleta = textBlock?.text ?? data.content?.[0]?.text ?? ''
    mensajes.push({ role: 'assistant', content: respuestaCompleta })
  }

  // 5. Parsear instrucciones del sistema embebidas en la respuesta
  // Eliminar TODOS los marcadores del sistema del mensaje visible, independientemente de su valor
  let mensajeParaCliente = respuestaCompleta
  let pedidoJsonStr: string | null = null
  let pedirMetodoPago = false
  let metodoElegido: string | null = null
  let enviarCarta = false

  // Extraer ENVIAR_CARTA si existe
  const cartaMatch = mensajeParaCliente.match(/ENVIAR_CARTA:[^\n]+/)
  if (cartaMatch) {
    enviarCarta = cartaMatch[0].includes('true')
    mensajeParaCliente = mensajeParaCliente.replace(cartaMatch[0], '').trim()
  }

  // Extraer PEDIDO_JSON si existe
  const pedidoMatch = mensajeParaCliente.match(/PEDIDO_JSON:\{.+?\}(?:\n|$)/s)
  if (pedidoMatch) {
    const jsonStr = pedidoMatch[0].replace('PEDIDO_JSON:', '').trim()
    pedidoJsonStr = jsonStr
    mensajeParaCliente = mensajeParaCliente.replace(pedidoMatch[0], '').trim()
  }

  // Extraer y eliminar PEDIR_METODO_PAGO (cualquier valor)
  const pedirMetodoPagoMatch = mensajeParaCliente.match(/PEDIR_METODO_PAGO:[^\n]+/)
  if (pedirMetodoPagoMatch) {
    pedirMetodoPago = pedirMetodoPagoMatch[0].includes('true')
    mensajeParaCliente = mensajeParaCliente.replace(pedirMetodoPagoMatch[0], '').trim()
  }

  // Extraer y eliminar METODO_ELEGIDO (cualquier valor)
  const metodoMatch = mensajeParaCliente.match(/METODO_ELEGIDO:"([^"]+)"/)
  if (metodoMatch) {
    metodoElegido = metodoMatch[1]
    mensajeParaCliente = mensajeParaCliente.replace(metodoMatch[0], '').trim()
  }

  // Limpieza final: eliminar cualquier línea que empiece con un marcador conocido que haya quedado
  mensajeParaCliente = mensajeParaCliente
    .split('\n')
    .filter(line => {
      const l = line.trim()
      return !l.startsWith('PEDIDO_JSON:')
        && !l.startsWith('PEDIR_METODO_PAGO:')
        && !l.startsWith('METODO_ELEGIDO:')
        && !l.startsWith('ENVIAR_CARTA:')
    })
    .join('\n')
    .trim()

  console.log('🤖 [IA raw]', JSON.stringify(respuestaCompleta))
  console.log('🔍 [IA parse] pedidoJson:', pedidoJsonStr, '| metodoPago:', pedirMetodoPago, '| metodoElegido:', metodoElegido)

  // 7. Procesar acciones según lo que indicó la IA

  // 7a. Flujo de carta: enviar saludo + menú estructurado + mensaje de cierre
  if (enviarCarta) {
    await db.update(WhatsappConversacionTable)
      .set({ mensajes, updatedAt: new Date() })
      .where(eq(WhatsappConversacionTable.id, conversacion.id))

    if (mensajeParaCliente.trim()) {
      await sendWhatsAppText(token, phoneNumberId, { phone: telefono, text: mensajeParaCliente.trim() })
    }

    const mensajeCarta = await construirMensajeCarta(db, restauranteId)
    await sendWhatsAppText(token, phoneNumberId, { phone: telefono, text: mensajeCarta })

    await sendWhatsAppText(token, phoneNumberId, {
      phone: telefono,
      text: 'Cada producto puede tener variantes y extras, también podés quitar ingredientes. Decime qué querés pedir.',
    })

    return
  }

  // 7c. Si la IA confirmó el pedido → crear en DB y pasar a esperando_pago
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
        direccion: pedidoData.direccion ?? pedidoDraft.direccion,
        precioDelivery: pedidoDraft.precioDelivery,
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
            text: `Link de pago:\n${resultado.linkPago}`,
          })
        } else if (resultado.alias) {
          const montoFormateado = Number(resultado.total) % 1 === 0
            ? `$${Math.round(Number(resultado.total))}`
            : `$${resultado.total}`
          await sendWhatsAppText(token, phoneNumberId, {
            phone: telefono,
            text: `Alias: ${resultado.alias}\nMonto: ${montoFormateado}`,
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

  if (draft.tipo === 'delivery') {
    const fee = draft.precioDelivery ?? resData.deliveryFee
    if (fee) total += parseFloat(fee)
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

  // MercadoPago — delegar a crear-preferencia-externo que ya tiene token refresh, fees y back_urls correctas
  if (resData.mpConnected) {
    try {
      const prefRes = await fetch('https://api.piru.app/api/mp/crear-preferencia-externo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pedidoId }),
      })
      const prefData = await prefRes.json() as any
      if (prefData.success && prefData.url_pago) {
        return { success: true, pedidoId, linkPago: prefData.url_pago, total: total.toFixed(2) }
      }
      console.error('❌ [WhatsApp IA] Error creando preferencia MP:', prefData)
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
      whatsappAccessToken: RestauranteTable.whatsappAccessToken,
    })
    .from(RestauranteTable)
    .where(eq(RestauranteTable.id, restauranteId))
    .limit(1)

  if (!restaurantes[0]?.whatsappPhoneId) return

  const token = restaurantes[0].whatsappAccessToken ?? process.env.WHATSAPP_API_TOKEN!
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