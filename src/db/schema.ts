// schema.ts
import {
  mysqlTable,
  varchar,
  int,
  timestamp,
  boolean,
  decimal,
  mysqlEnum,
  json,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

export const restaurante = mysqlTable("restaurante", {
  id: int("id").primaryKey().autoincrement(),
  // Nullable: las cuentas registradas por WhatsApp (self-serve) sólo tienen el teléfono al crearse;
  // el nombre, email y password se completan después en el onboarding.
  email: varchar("email", { length: 255 }).unique(),
  nombre: varchar("nombre", { length: 255 }),
  password: varchar("password", { length: 255 }),
  // true si el número fue verificado por código de WhatsApp (registro self-serve)
  telefonoVerificado: boolean("telefono_verificado").default(false).notNull(),
  direccion: varchar("direccion", { length: 255 }),
  direccionTexto: varchar("direccion_texto", { length: 512 }),
  direccionLat: decimal("direccion_lat", { precision: 10, scale: 7 }),
  direccionLng: decimal("direccion_lng", { precision: 10, scale: 7 }),
  telefono: varchar("telefono", { length: 255 }),
  imagenUrl: varchar("imagen_url", { length: 255 }),
  imagenLightUrl: varchar("imagen_light_url", { length: 255 }),
  username: varchar("username", { length: 255 }).unique(),

  mpAccessToken: varchar("mp_access_token", { length: 512 }),
  mpPublicKey: varchar("mp_public_key", { length: 255 }),
  mpRefreshToken: varchar("mp_refresh_token", { length: 512 }),
  mpUserId: varchar("mp_user_id", { length: 50 }),
  mpConnected: boolean("mp_connected").default(false),



  deliveryFee: decimal("delivery_fee", { precision: 10, scale: 2 })
    .default("0.00")
    .notNull(),

  cucuruApiKey: varchar("cucuru_api_key", { length: 255 }),
  cucuruCollectorId: varchar("cucuru_collector_id", { length: 255 }),
  cucuruConfigurado: boolean("cucuru_configurado").default(false).notNull(),
  cucuruEnabled: boolean("cucuru_enabled").default(true).notNull(),
  cardsPaymentsEnabled: boolean("cards_payments_enabled").default(true).notNull(),

  whatsappEnabled: boolean("whatsapp_enabled").default(false).notNull(),
  whatsappNumber: varchar("whatsapp_number", { length: 50 }),
  whatsappPhoneId: varchar("whatsapp_phone_id", { length: 50 }),
  whatsappWabaId: varchar("whatsapp_waba_id", { length: 100 }),
  whatsappAccessToken: varchar("whatsapp_access_token", { length: 512 }),
  whatsappTokenExpiry: timestamp("whatsapp_token_expiry"),
  /** WhatsApp al que los clientes envían comprobantes (transferencia manual); independiente de la API de notificaciones al local. */
  comprobantesWhatsapp: varchar("comprobantes_whatsapp", { length: 50 }),

  transferenciaAlias: varchar("transferencia_alias", { length: 255 }),

  /** Overrides for enabled payment methods; merged in app with legacy columns (see resolveMetodosPagoConfig). */
  metodosPagoConfig: json("metodos_pago_config"),

  colorPrimario: varchar("color_primario", { length: 50 }),
  colorSecundario: varchar("color_secundario", { length: 50 }),
  disenoAlternativo: boolean("diseno_alternativo").default(false).notNull(),
  codigoDescuentoEnabled: boolean("codigo_descuento_enabled").default(true).notNull(),

  orderGroupEnabled: boolean("order_group_enabled").default(true).notNull(),
  deliveryEnabled: boolean("delivery_enabled").default(true).notNull(),
  takeawayEnabled: boolean("takeaway_enabled").default(true).notNull(),
  // Rapiboy - integración logística delivery
  rapiboyToken: varchar("rapiboy_token", { length: 512 }),
  rapiboyMode: mysqlEnum("rapiboy_mode", ["on_demand", "food"]),

  // Pedidos programados para después del horario
  permitirPedidosProgramados: boolean("permitir_pedidos_programados").default(false).notNull(),
  usarFranjasHorario: boolean("usar_franjas_horario").default(false).notNull(),
  // Si está activo, el cliente está obligado a elegir una franja de horario (no puede pedir "para ahora")
  soloPedidosProgramados: boolean("solo_pedidos_programados").default(false).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),

  // ----- Agregar mas adelante cuando ya tenga talo configurado ------

  proveedorPago: mysqlEnum("proveedor_pago", [
    "cucuru",
    "talo",
    "mercadopago",
    "manual",
  ]).default("manual"),
  taloClientId: varchar("talo_client_id", { length: 255 }),
  taloClientSecret: varchar("talo_client_secret", { length: 255 }),
  taloUserId: varchar("talo_user_id", { length: 255 }),

  notificarClientesWhatsapp: boolean("notificar_clientes_whatsapp").default(false),
  modoConfirmacionManual: boolean("modo_confirmacion_manual").default(false),
  completedOnboarding: boolean("completed_onboarding").default(false).notNull(),
  // Hard paywall: los locales dados de alta bajo el modelo de planes requieren una suscripción
  // activa para usar el panel. default=false → las cuentas viejas (pre-planes) quedan
  // grandfathered (nunca bloqueadas); el registro nuevo lo pone en true. Ver lib/planes.ts
  // (tieneAccesoAlPanel) y el gate del admin (ProtectedLayout → /suscribir).
  requiereSuscripcion: boolean("requiere_suscripcion").default(false).notNull(),

  // AFIP / ARCA - facturación electrónica
  afipHabilitado: boolean("afip_habilitado").default(false).notNull(),
  afipCuit: varchar("afip_cuit", { length: 11 }),
  afipClaveFiscal: varchar("afip_clave_fiscal", { length: 2048 }),
  afipCert: varchar("afip_cert", { length: 8192 }),
  afipKeyPrivada: varchar("afip_key_privada", { length: 8192 }),
  afipPuntoDeVenta: int("afip_punto_de_venta"),
  afipCondicionIva: mysqlEnum("afip_condicion_iva", ["RI", "MO"]).default("RI"),

  // ------ COLUMNAS A ELIMINAR ------

  // sistemaPuntos: boolean("sistema_puntos").default(false).notNull(),
  // mercadoPagoPublicKey: varchar("mercado_pago_public_key", { length: 255 }),
  // mercadoPagoPrivateKey: varchar("mercado_pago_private_key", { length: 255 }),
  // esCarrito: boolean("es_carrito").default(false).notNull(),
  // splitPayment: boolean("split_payment").default(true).notNull(),
  // itemTracking: boolean("item_tracking").default(false).notNull(),
  // soloCartaDigital: boolean("solo_carta_digital").default(false).notNull(),
});

export const sucursal = mysqlTable("sucursal", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  direccion: varchar("direccion", { length: 255 }),
  whatsappEnabled: boolean("whatsapp_enabled").default(false).notNull(),
  whatsappNumber: varchar("whatsapp_number", { length: 50 }),
  rapiboyToken: varchar("rapiboy_token", { length: 512 }),
  activo: boolean("activo").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const repartidor = mysqlTable("repartidor", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  estado: mysqlEnum("estado", ["activo", "inactivo"]).default("activo").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const pedidoUnificado = mysqlTable("pedido_unificado", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  sucursalId: int("sucursal_id").references(() => sucursal.id),
  clienteId: int("cliente_id").references(() => cliente.id), // Nullable si no se registró

  // Discriminador principal
  tipo: mysqlEnum("tipo", ["delivery", "takeaway"]).notNull(),

  // Datos comunes (compatible con delivery/takeaway legacy)
  estado: mysqlEnum("estado", [
    "pending",
    "preparing",
    "ready",
    "received",
    "dispatched",   // En camino (delivery)
    "delivered",    // Entregado/Retirado
    "cancelled",
    "archived",
  ]).default("pending").notNull(),

  nombreCliente: varchar("nombre_cliente", { length: 255 }),
  telefono: varchar("telefono", { length: 50 }),
  notas: varchar("notas", { length: 500 }),

  // Totales y Pagos
  total: decimal("total", { precision: 10, scale: 2 }).default("0.00").notNull(),
  pagado: boolean("pagado").default(false).notNull(),
  /** Canonical: mercadopago_checkout, mercadopago_bricks, transferencia_automatica_*, manual_transfer, cash; legacy: mercadopago, transferencia, efectivo */
  metodoPago: varchar("metodo_pago", { length: 64 }),

  // Datos exclusivos de Delivery (pueden ser nulos si es takeaway)
  direccion: varchar("direccion", { length: 255 }),
  latitud: varchar("latitud", { length: 50 }),
  longitud: varchar("longitud", { length: 50 }),
  rapiboyTrackingUrl: varchar("rapiboy_tracking_url", { length: 512 }),
  rapiboyTripId: varchar("rapiboy_trip_id", { length: 100 }),

  // Puntos y Descuentos
  codigoDescuentoId: int("codigo_descuento_id").references(() => codigoDescuento.id),
  montoDescuento: decimal("monto_descuento", { precision: 10, scale: 2 }).default("0.00"),

  // Trazabilidad
  impreso: boolean("impreso").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deliveredAt: timestamp("delivered_at"),

  // ─── NUEVO: Notificar a whatsapp ─────────
  notificarWhatsapp: boolean("notificar_whatsapp").default(false),

  // Demora informada al cliente por el admin (modo confirmación manual)
  demoraMinutos: int("demora_minutos"),
  // Horario solicitado por el cliente para recibir el pedido (ej: "21:30")
  horarioProgramado: varchar("horario_programado", { length: 20 }),

  // Repartidor asignado al pedido de delivery
  repartidorId: int("repartidor_id").references(() => repartidor.id),
  // Fee de delivery exacto cobrado al cliente (calculado por zona)
  deliveryFee: decimal("delivery_fee", { precision: 10, scale: 2 }),

  // Pedido grupal: items con clienteNombre individual (flujo sala/grupo)
  grupal: boolean("grupal").default(false).notNull(),

  // Pedido creado por el agente IA de WhatsApp
  creadoPorIa: boolean("creado_por_ia").default(false).notNull(),

  // Pedido anotado manualmente desde el POS del local (no se cobra comisión, a diferencia de los tomados por la web)
  anotadoManualmente: boolean("anotado_manualmente").default(false).notNull(),

  // AFIP / ARCA - facturación electrónica
  afipFacturado: boolean("afip_facturado").default(false).notNull(),
  afipCae: varchar("afip_cae", { length: 14 }),
  afipCaeFchVto: varchar("afip_cae_fch_vto", { length: 10 }),
  afipNumeroComprobante: int("afip_numero_comprobante"),
  afipPuntoDeVenta: int("afip_punto_de_venta"),
  afipPdfUrl: varchar("afip_pdf_url", { length: 512 }),
});

export const itemPedidoUnificado = mysqlTable("item_pedido_unificado", {
  id: int("id").primaryKey().autoincrement(),
  pedidoId: int("pedido_id").references(() => pedidoUnificado.id, { onDelete: 'cascade' }).notNull(),
  productoId: int("producto_id").notNull(), // No le ponemos fk estricta por si borran el producto, no romper el historial
  varianteId: int("variante_id"),
  varianteNombre: varchar("variante_nombre", { length: 255 }),
  cantidad: int("cantidad").default(1).notNull(),
  precioUnitario: decimal("precio_unitario", { precision: 10, scale: 2 }).notNull(),
  esCanjePuntos: boolean("es_canje_puntos").default(false),
  ingredientesExcluidos: json("ingredientes_excluidos"),
  agregados: json("agregados"),
  // Nombre del cliente que agregó este item (solo relevante en pedidos grupales)
  clienteNombre: varchar("cliente_nombre", { length: 255 }),
});

export const producto = mysqlTable("producto", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id),
  categoriaId: int("categoria_id").references(() => categoria.id),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  descripcion: varchar("descripcion", { length: 255 }),
  precio: decimal("precio", { precision: 10, scale: 2 }).notNull(),
  activo: boolean("activo").default(true),
  imagenUrl: varchar("imagen_url", { length: 255 }),
  descuento: int("descuento").default(0),
  descuentoFechaInicio: timestamp("descuento_fecha_inicio"),
  descuentoFechaFin: timestamp("descuento_fecha_fin"),
  tieneVariantes: boolean("tiene_variantes").default(false).notNull(),
  // Orden manual de aparición dentro de su categoría (menor = primero). Configurable por el restaurante (drag & drop).
  orden: int("orden").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const varianteProducto = mysqlTable("variante_producto", {
  id: int("id").primaryKey().autoincrement(),
  productoId: int("producto_id")
    .references(() => producto.id, { onDelete: "cascade" })
    .notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  precio: decimal("precio", { precision: 10, scale: 2 }).notNull(),
  activo: boolean("activo").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const categoria = mysqlTable("categoria", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Sala: equivalente a mesa para pedidos grupales (link in bio, sin QR físico)
export const sala = mysqlTable("sala", {
  id: int("id").primaryKey().autoincrement(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  restauranteId: int("restaurante_id").references(() => restaurante.id),
  token: varchar("token", { length: 255 }).unique().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const ingrediente = mysqlTable("ingrediente", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const productoIngrediente = mysqlTable(
  "producto_ingrediente",
  {
    id: int("id").primaryKey().autoincrement(),
    productoId: int("producto_id")
      .references(() => producto.id)
      .notNull(),
    ingredienteId: int("ingrediente_id")
      .references(() => ingrediente.id)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_producto_ingrediente").on(
      table.productoId,
      table.ingredienteId,
    ),
  ],
);

export const agregado = mysqlTable("agregado", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  precio: decimal("precio", { precision: 10, scale: 2 })
    .default("0.00")
    .notNull(),
  // Si está desactivado, no se ofrece en ningún producto de la app cliente
  activo: boolean("activo").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const productoAgregado = mysqlTable(
  "producto_agregado",
  {
    id: int("id").primaryKey().autoincrement(),
    productoId: int("producto_id")
      .references(() => producto.id)
      .notNull(),
    agregadoId: int("agregado_id")
      .references(() => agregado.id)
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_producto_agregado").on(table.productoId, table.agregadoId),
  ],
);

// Etiquetas de productos (únicas por restaurante, asociadas a un solo producto)
export const etiqueta = mysqlTable(
  "etiqueta",
  {
    id: int("id").primaryKey().autoincrement(),
    restauranteId: int("restaurante_id")
      .references(() => restaurante.id)
      .notNull(),
    productoId: int("producto_id")
      .references(() => producto.id)
      .notNull(),
    nombre: varchar("nombre", { length: 100 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("unique_restaurante_nombre").on(
      table.restauranteId,
      table.nombre,
    ),
  ],
);


export const cliente = mysqlTable("cliente", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  telefono: varchar("telefono", { length: 50 }).notNull(),
  direccion: varchar("direccion", { length: 255 }),
  puntos: int("puntos").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Verificación de registro por WhatsApp (onboarding self-serve por código OTP).
// Cada fila es una "sesión de espera de código" única, identificada por un UUID.
export const registroTelefono = mysqlTable("registro_telefono", {
  // UUID que identifica esta sesión de verificación; es lo que ve el frontend en la URL de espera.
  id: varchar("id", { length: 36 }).primaryKey(),
  telefono: varchar("telefono", { length: 50 }).notNull(),
  // Hash bcrypt del código de 6 dígitos. Nunca se guarda el código en texto plano.
  codigoHash: varchar("codigo_hash", { length: 255 }).notNull(),
  // Intentos fallidos de ingreso del código (para bloquear fuerza bruta).
  intentos: int("intentos").default(0).notNull(),
  verificado: boolean("verificado").default(false).notNull(),
  // Se completa una vez que la verificación crea la cuenta.
  restauranteId: int("restaurante_id").references(() => restaurante.id),
  expiraEn: timestamp("expira_en").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Códigos de descuento con cupos limitados
export const codigoDescuento = mysqlTable(
  "codigo_descuento",
  {
    id: int("id").primaryKey().autoincrement(),
    restauranteId: int("restaurante_id")
      .references(() => restaurante.id)
      .notNull(),
    codigo: varchar("codigo", { length: 50 }).notNull(),
    tipo: mysqlEnum("tipo", ["porcentaje", "monto_fijo"]).notNull(),
    valor: decimal("valor", { precision: 10, scale: 2 }).notNull(),
    limiteUsos: int("limite_usos"),
    usosActuales: int("usos_actuales").default(0).notNull(),
    montoMinimo: decimal("monto_minimo", { precision: 10, scale: 2 }).default("0.00"),
    fechaInicio: timestamp("fecha_inicio"),
    fechaFin: timestamp("fecha_fin"),
    activo: boolean("activo").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_restaurante_codigo").on(table.restauranteId, table.codigo),
  ]
);

// Horarios de atención del restaurante (múltiples turnos por día)
export const horarioRestaurante = mysqlTable("horario_restaurante", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  diaSemana: int("dia_semana").notNull(), // 0=Domingo, 1=Lunes ... 6=Sábado
  horaApertura: varchar("hora_apertura", { length: 5 }).notNull(), // "HH:mm"
  horaCierre: varchar("hora_cierre", { length: 5 }).notNull(), // "HH:mm"
});

export const franjaHorarioPedido = mysqlTable("franja_horario_pedido", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(), // ej: "Almuerzo", "Cena"
  horaInicio: varchar("hora_inicio", { length: 5 }).notNull(), // "HH:mm"
  horaFin: varchar("hora_fin", { length: 5 }).notNull(), // "HH:mm"
  activo: boolean("activo").default(true).notNull(),
  // Cupo de pedidos pagados que admite la franja por día. null = sin límite.
  // Cuando la cantidad de pedidos pagados de hoy en esta franja alcanza el cupo,
  // la franja deja de ofrecerse en la app cliente (no bloquea creación de pedidos ni pagos).
  cupo: int("cupo"),
  // Momento del último reseteo manual del cupo. Al contar los pedidos pagados de la franja,
  // solo se cuentan los creados a partir de este instante (permite "liberar" la franja a mano).
  cupoReseteadoAt: timestamp("cupo_reseteado_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Zonas de delivery con polígonos y precios dinámicos
export const zonaDelivery = mysqlTable("zona_delivery", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  sucursalId: int("sucursal_id").references(() => sucursal.id),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  precio: decimal("precio", { precision: 10, scale: 2 }).notNull(),
  poligono: json("poligono").notNull(), // Array de {lat: number, lng: number}
  color: varchar("color", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Historial de mensajes WhatsApp enviados a clientes
export const mensajeWhatsapp = mysqlTable("mensaje_whatsapp", {
  id: int("id").primaryKey().autoincrement(),
  pedidoUnificadoId: int("pedido_unificado_id").references(() => pedidoUnificado.id),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  telefono: varchar("telefono", { length: 50 }).notNull(),
  tipo: mysqlEnum("tipo_mensaje", ["pedido_confirmado", "pedido_despachado"]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});



// ------- Quitar esto una vez que ya esta resuelto lo de TALO -------

export const accountPool = mysqlTable("account_pool", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id),
  accountNumber: varchar("account_number", { length: 255 }),
  alias: varchar("alias", { length: 255 }),
  estado: mysqlEnum("estado", ["disponible", "asignado"]).default("disponible"),
  pedidoIdAsignado: int("pedido_id_asignado"),
  tipoPedido: mysqlEnum("tipo_pedido", ["delivery", "takeaway"]),
  updatedAt: timestamp("updated_at").defaultNow(),
});


export const productoPuntos = mysqlTable("producto_puntos", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  productoId: int("producto_id")
    .references(() => producto.id)
    .notNull(),
  puntosNecesarios: int("puntos_necesarios").notNull(),
  puntosGanados: int("puntos_ganados").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const whatsappConversacion = mysqlTable("whatsapp_conversacion", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  telefono: varchar("telefono", { length: 50 }).notNull(),
  nombreCliente: varchar("nombre_cliente", { length: 255 }),
  mensajes: json("mensajes").notNull(),
  pedidoDraft: json("pedido_draft"),
  estado: mysqlEnum("estado_conversacion", [
    "conversando",
    "esperando_pago",
    "pagado",
    "finalizado",
  ]).default("conversando").notNull(),
  pedidoUnificadoId: int("pedido_unificado_id").references(() => pedidoUnificado.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================================
// PLANES Y SUSCRIPCIONES
// Modelo de negocio: cuota mensual fija en 3 planes, SIN comisión por venta.
// El único costo variable (mensajes de WhatsApp al cliente) se cobra aparte
// como consumible (ver saldoMensajes / recargaMensajes).
// ============================================================================

// Definición de cada plan comercial. Editable sin deploy (precio, mensajes
// incluidos, etc. viven en la tabla, no en constantes hardcodeadas en el código).
export const plan = mysqlTable("plan", {
  id: int("id").primaryKey().autoincrement(),
  // Código estable usado por el código para referirse al plan; no cambia aunque
  // cambie el nombre comercial. Ver PLAN_CODES en lib/planes.ts.
  codigo: varchar("codigo", { length: 50 }).unique().notNull(), // "basico" | "intermedio" | "avanzado"
  nombre: varchar("nombre", { length: 255 }).notNull(),
  descripcion: varchar("descripcion", { length: 500 }),
  // Precio mensual en ARS. Editable sin deploy.
  precioMensual: decimal("precio_mensual", { precision: 10, scale: 2 }).notNull(),
  // Mensajes de WhatsApp al cliente incluidos por ciclo. 0 = ninguno (plan Básico).
  mensajesIncluidos: int("mensajes_incluidos").default(0).notNull(),
  // true = mensajes sin tope (plan Avanzado). Cuando es true se ignora mensajesIncluidos.
  mensajesIlimitados: boolean("mensajes_ilimitados").default(false).notNull(),
  // Orden de aparición en la UI de pricing (menor = primero).
  orden: int("orden").default(0).notNull(),
  // Permite discontinuar un plan sin borrarlo: las suscripciones existentes lo conservan.
  activo: boolean("activo").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Qué features habilita cada plan. Tabla en vez de ifs desparramados por el código:
// para saber si un restaurante tiene acceso a una feature se mira su plan -> plan_feature.
// Sólo se listan las filas de features habilitadas (habilitado=true por default).
// Ver FEATURE_KEYS en lib/planes.ts para la lista canónica de claves.
export const planFeature = mysqlTable(
  "plan_feature",
  {
    id: int("id").primaryKey().autoincrement(),
    planId: int("plan_id")
      .references(() => plan.id, { onDelete: "cascade" })
      .notNull(),
    // Clave estable de la feature. Ej: "avisos_whatsapp_cliente", "facturacion_arca",
    // "rapiboy", "multisucursal", "estadisticas_avanzadas", "dominio_propio", "motor_recompra".
    featureKey: varchar("feature_key", { length: 100 }).notNull(),
    habilitado: boolean("habilitado").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_plan_feature").on(table.planId, table.featureKey),
  ],
);

// Suscripción de un restaurante a un plan. Una fila por restaurante (la vigente).
export const suscripcion = mysqlTable("suscripcion", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull()
    .unique(),
  planId: int("plan_id")
    .references(() => plan.id)
    .notNull(),
  // Estado de la suscripción. Define qué puede hacer el local:
  //  - trial:          período de prueba; acceso completo al plan contratado.
  //  - activa:         al día; acceso completo.
  //  - pago_pendiente: venció el cobro pero está en PERÍODO DE GRACIA (ver graciaHasta);
  //                    sigue operando con normalidad. NUNCA se corta en seco por un pago fallido.
  //  - suspendida:     se agotó el período de gracia sin pagar; el panel se limita (features
  //                    de pago bloqueadas), pero los pedidos/avisos en curso NO se cortan.
  //  - cancelada:      baja voluntaria; sin acceso a features de pago.
  estado: mysqlEnum("estado_suscripcion", [
    "trial",
    "activa",
    "pago_pendiente",
    "suspendida",
    "cancelada",
  ])
    .default("trial")
    .notNull(),
  // Ciclo de facturación.
  ciclo: mysqlEnum("ciclo", ["mensual", "anual"]).default("mensual").notNull(),
  fechaInicio: timestamp("fecha_inicio").defaultNow().notNull(),
  // Fin del período de prueba (si aplica).
  trialFin: timestamp("trial_fin"),
  // Próximo cobro programado.
  fechaProximoCobro: timestamp("fecha_proximo_cobro"),
  // Hasta cuándo dura el período de gracia tras un pago fallido (estado pago_pendiente).
  // Pasada esta fecha sin registrarse el pago, recién ahí se pasa a suspendida.
  graciaHasta: timestamp("gracia_hasta"),
  // Fecha de baja voluntaria.
  fechaCancelacion: timestamp("fecha_cancelacion"),
  // Precio congelado al momento de contratar (por si luego cambia el precio del plan).
  precioMensual: decimal("precio_mensual", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Wallet de mensajes de WhatsApp al cliente (único costo variable de Piru) ───
// Meta cobra distinto según la categoría del mensaje, por eso se llevan DOS saldos:
//  - utility  → avisos de pedido ("en camino" / "listo"). Más barato. Lo incluye el plan.
//  - marketing → campañas del Motor de Recompra (ROADMAP). Más caro. Sólo por recarga.
// Regla dura: NUNCA cortar en seco. Si un saldo se agota, el mensaje igual sale y el
// saldo queda NEGATIVO, a cubrir con la próxima recarga. Un comensal jamás se queda sin
// su aviso por un tema de billing del local.

// Saldo actual por local (una fila por restaurante). Es un snapshot para lectura rápida;
// la verdad auditable es el ledger transaccion_mensajes.
export const saldoMensajes = mysqlTable("saldo_mensajes", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull()
    .unique(),

  // Ventana del ciclo actual. Al llegar a cicloRenuevaEn se acredita el cupo del plan.
  cicloInicio: timestamp("ciclo_inicio").defaultNow().notNull(),
  cicloRenuevaEn: timestamp("ciclo_renueva_en"),

  // UTILITY — cupo del plan para ESTE ciclo. Se acredita al inicio del ciclo y el
  // SOBRANTE SE PIERDE en la renovación (no se acumula: mantiene la contabilidad simple
  // y preserva el driver de recarga).
  utilityIncluidosRestantes: int("utility_incluidos_restantes").default(0).notNull(),
  // UTILITY — saldo de packs de recarga prepagos. SE ACUMULA entre ciclos. Puede ser NEGATIVO.
  utilityRecargaSaldo: int("utility_recarga_saldo").default(0).notNull(),

  // MARKETING — saldo de recarga (no lo incluye el plan). Se acumula. Puede ser NEGATIVO.
  marketingRecargaSaldo: int("marketing_recarga_saldo").default(0).notNull(),

  // Avisos de consumo del cupo utility (una sola vez por ciclo; se resetean al renovar).
  aviso80Enviado: boolean("aviso_80_enviado").default(false).notNull(),
  aviso95Enviado: boolean("aviso_95_enviado").default(false).notNull(),

  // Auto-recarga opcional: cuando el saldo utility disponible cae por debajo del umbral,
  // se dispara la compra de un pack (el que no quiere pensar, la activa y listo).
  autoRecargaHabilitada: boolean("auto_recarga_habilitada").default(false).notNull(),
  autoRecargaUmbral: int("auto_recarga_umbral"),     // dispara cuando disponible <= umbral
  autoRecargaCantidad: int("auto_recarga_cantidad"), // tamaño del pack a comprar (ej: 500)

  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Ledger de TODOS los movimientos de mensajes. Sin este log no se puede auditar ni
// resolver un reclamo. Un movimiento = una fila; saldo_mensajes es su acumulado.
export const transaccionMensajes = mysqlTable("transaccion_mensajes", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  // Tipo de movimiento.
  tipo: mysqlEnum("tipo_transaccion", [
    "consumo",         // envío de un mensaje (cantidad negativa)
    "recarga",         // compra de un pack (cantidad positiva)
    "renovacion_plan", // acreditación del cupo del plan al inicio del ciclo (positiva)
    "expiracion",      // sobrante del cupo que se pierde al renovar (negativa)
    "ajuste",          // corrección manual (soporte)
  ]).notNull(),
  // Categoría / bucket afectado (Meta cobra distinto).
  categoria: mysqlEnum("categoria_mensaje", ["utility", "marketing"]).notNull(),
  // Cantidad con signo: negativa (consumo/expiracion), positiva (recarga/renovacion).
  cantidad: int("cantidad").notNull(),
  // Saldo total disponible de la categoría luego de aplicar este movimiento (auditoría).
  saldoResultante: int("saldo_resultante"),
  // Motivo legible (ej: "aviso_pedido_despachado", "pack_500", "renovacion_mensual").
  motivo: varchar("motivo", { length: 255 }),
  // Tipo de mensaje que originó el consumo (alineado con mensaje_whatsapp.tipo_mensaje).
  tipoMensaje: varchar("tipo_mensaje", { length: 64 }),
  // Trazabilidad. Sin FK estricta para no romper el ledger si se borra el pedido/recarga.
  pedidoUnificadoId: int("pedido_unificado_id"),
  recargaMensajesId: int("recarga_mensajes_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Packs de recarga comprables (prepago, modelo SUBE). Editable sin deploy: el
// precio es la variable a calibrar (por encima del costo real por mensaje y un
// orden de magnitud por debajo del salto de plan).
export const packRecarga = mysqlTable("pack_recarga", {
  id: int("id").primaryKey().autoincrement(),
  // Bucket que recarga el pack (Meta cobra distinto → precio distinto).
  categoria: mysqlEnum("categoria_pack", ["utility", "marketing"]).default("utility").notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  // Mensajes que suma el pack (ej: 500).
  cantidad: int("cantidad").notNull(),
  // Precio del pack en ARS. Autoritativo del servidor (nunca confiar en el cliente).
  precio: decimal("precio", { precision: 10, scale: 2 }).notNull(),
  orden: int("orden").default(0).notNull(),
  activo: boolean("activo").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Registro de compras de packs de recarga ("recargar crédito"). Es el comprobante
// financiero (monto en ARS); el crédito en sí queda asentado en transaccion_mensajes.
export const recargaMensajes = mysqlTable("recarga_mensajes", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  // Bucket que recarga este pack (Meta cobra distinto → precio distinto).
  categoria: mysqlEnum("categoria_recarga", ["utility", "marketing"]).default("utility").notNull(),
  // Pack comprado (null para créditos manuales/ajustes que no salen de un pack).
  packRecargaId: int("pack_recarga_id"),
  // Cantidad de mensajes que suma el pack (ej: 500).
  cantidad: int("cantidad").notNull(),
  // Monto pagado por el pack en ARS.
  monto: decimal("monto", { precision: 10, scale: 2 }).notNull(),
  // Si la compra la disparó la auto-recarga o fue manual (botón de recarga).
  origen: mysqlEnum("origen_recarga", ["manual", "auto"]).default("manual").notNull(),
  // Estado del pago. 'paid' por default: los créditos directos (ajuste/auto) nacen acreditados;
  // las compras vía MercadoPago nacen 'pending' y pasan a 'paid' recién con el webhook.
  estado: mysqlEnum("estado_recarga", ["pending", "paid", "failed"]).default("paid").notNull(),
  // Referencias de MercadoPago (pago a la cuenta de la plataforma Piru).
  mpPreferenceId: varchar("mp_preference_id", { length: 255 }),
  mpPaymentId: varchar("mp_payment_id", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Pagos de la cuota mensual del plan (suscripción). NO usamos las suscripciones
// recurrentes de MercadoPago: cada cobro es un pago único vía Checkout Pro que
// paga a la cuenta de la plataforma (Piru) y EXTIENDE la suscripción un ciclo.
// Es el comprobante financiero; el efecto sobre el acceso queda en `suscripcion`.
export const pagoSuscripcion = mysqlTable("pago_suscripcion", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  // Plan que se está pagando (congelado al iniciar el pago, por si cambia después).
  planId: int("plan_id")
    .references(() => plan.id)
    .notNull(),
  // Ciclo cubierto por este pago.
  ciclo: mysqlEnum("ciclo_pago", ["mensual", "anual"]).default("mensual").notNull(),
  // Monto pagado en ARS (autoritativo del servidor, sale del precio del plan).
  monto: decimal("monto", { precision: 10, scale: 2 }).notNull(),
  // Período de cobertura que otorga este pago (se setea al confirmar).
  periodoDesde: timestamp("periodo_desde"),
  periodoHasta: timestamp("periodo_hasta"),
  // Estado del pago. Nace 'pending' (Checkout Pro) y pasa a 'paid' con el webhook.
  estado: mysqlEnum("estado_pago_suscripcion", ["pending", "paid", "failed"]).default("pending").notNull(),
  // Referencias de MercadoPago (pago a la cuenta de la plataforma Piru).
  mpPreferenceId: varchar("mp_preference_id", { length: 255 }),
  mpPaymentId: varchar("mp_payment_id", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ----------- DEBAJO ESTA LA ARQUITECTURA VIEJA QUE YA NO QUIERO USAR -----------------
export const mesa = mysqlTable("mesa", {
  id: int("id").primaryKey().autoincrement(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  restauranteId: int("restaurante_id").references(() => restaurante.id),
  qrToken: varchar("qr_token", { length: 255 }).unique().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


export const pago = mysqlTable("pago", {
  id: int("id").primaryKey().autoincrement(),
  pedidoId: int("pedido_id"), // Ya no es .notNull()
  pedidoDeliveryId: int("pedido_delivery_id"), // Nuevo
  pedidoTakeawayId: int("pedido_takeaway_id"), // Nuevo
  pedidoUnificadoId: int("pedido_unificado_id"), // Migración: pedidos unificados
  metodo: mysqlEnum("metodo", [
    "efectivo",
    "mercadopago",
    "transferencia",
  ]).notNull(),
  estado: mysqlEnum("estado", ["pending", "paid", "failed"]).default("pending"),
  monto: decimal("monto", { precision: 10, scale: 2 }).notNull(),
  mpPaymentId: varchar("mp_payment_id", { length: 255 }),
  createdAt: timestamp("created_at").defaultNow(),
});

export const pedido = mysqlTable("pedido", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id),
  mesaId: int("mesa_id").references(() => mesa.id),
  salaId: int("sala_id").references(() => sala.id),
  nombrePedido: varchar("nombre_pedido", { length: 255 }),
  estado: mysqlEnum("estado", [
    "pending",
    "preparing",
    "delivered",
    "served",
    "closed",
    "archived",
  ]).default("pending"),
  total: decimal("total", { precision: 10, scale: 2 }).default("0.00"),
  pagado: boolean("pagado").default(false).notNull(),
  /** Canonical: mercadopago_checkout, mercadopago_bricks, transferencia_automatica_*, manual_transfer, cash; legacy: mercadopago, transferencia, efectivo */
  metodoPago: varchar("metodo_pago", { length: 64 }),
  impreso: boolean("impreso").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  closedAt: timestamp("closed_at"),
});

export const itemPedido = mysqlTable("item_pedido", {
  id: int("id").primaryKey().autoincrement(),
  pedidoId: int("pedido_id").notNull(),
  productoId: int("producto_id").notNull(),
  clienteNombre: varchar("cliente_nombre", { length: 100 }).notNull(),
  cantidad: int("cantidad").default(1),
  precioUnitario: decimal("precio_unitario", {
    precision: 10,
    scale: 2,
  }).notNull(),
  ingredientesExcluidos: json("ingredientes_excluidos"), // Array de IDs de ingredientes excluidos
  agregados: json("agregados"), // Array de { id: number, nombre: string, precio: string } de agregados sumados
  estado: mysqlEnum("estado", [
    "pending",
    "preparing",
    "delivered",
    "served",
    "cancelled",
  ]).default("pending"),
  postConfirmacion: boolean("post_confirmacion").default(false), // true si se agregó después de confirmar el pedido
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Tabla para trackear pagos de subtotales individuales (split payment)
export const pagoSubtotal = mysqlTable("pago_subtotal", {
  id: int("id").primaryKey().autoincrement(),
  pedidoId: int("pedido_id").notNull(),
  pagoId: int("pago_id"), // Referencia al pago principal (puede ser null si es pago en efectivo)
  clienteNombre: varchar("cliente_nombre", { length: 100 }).notNull(),
  monto: decimal("monto", { precision: 10, scale: 2 }).notNull(),
  estado: mysqlEnum("estado", [
    "pending",
    "pending_cash",
    "paid",
    "failed",
  ]).default("pending"),
  metodo: mysqlEnum("metodo", [
    "efectivo",
    "mercadopago",
    "transferencia",
  ]).notNull(),
  mpPaymentId: varchar("mp_payment_id", { length: 255 }), // Para identificar el pago en webhook
  mpPreferenceId: varchar("mp_preference_id", { length: 255 }), // ID de la preferencia creada
  createdAt: timestamp("created_at").defaultNow(),
});

export const notificacion = mysqlTable("notificacion", {
  id: varchar("id", { length: 50 }).primaryKey(), // Format: notif-timestamp-random
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  tipo: mysqlEnum("tipo", [
    "NUEVO_PEDIDO",
    "NUEVO_PEDIDO_PENDIENTE_PAGO",
    "PEDIDO_CONFIRMADO",
    "PEDIDO_CERRADO",
    "LLAMADA_MOZO",
    "PAGO_RECIBIDO",
    "PRODUCTO_AGREGADO",
  ]).notNull(),
  mesaId: int("mesa_id").references(() => mesa.id),
  salaId: int("sala_id").references(() => sala.id),
  mesaNombre: varchar("mesa_nombre", { length: 255 }),
  pedidoId: int("pedido_id"),
  mensaje: varchar("mensaje", { length: 500 }).notNull(),
  detalles: varchar("detalles", { length: 500 }),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  leida: boolean("leida").default(false).notNull(),
});

// Pedido de delivery (sin mesa, con dirección)
export const pedidoDelivery = mysqlTable("pedido_delivery", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id),
  clienteId: int("cliente_id").references(() => cliente.id),
  direccion: varchar("direccion", { length: 255 }).notNull(),
  latitud: varchar("latitud", { length: 50 }),
  longitud: varchar("longitud", { length: 50 }),
  nombreCliente: varchar("nombre_cliente", { length: 255 }),
  telefono: varchar("telefono", { length: 50 }),
  estado: mysqlEnum("estado", [
    "pending",
    "preparing",
    "ready",
    "dispatched",
    "delivered",
    "cancelled",
    "archived",
  ]).default("pending"),
  total: decimal("total", { precision: 10, scale: 2 }).default("0.00"),
  pagado: boolean("pagado").default(false).notNull(),
  /** Canonical: mercadopago_checkout, mercadopago_bricks, transferencia_automatica_*, manual_transfer, cash; legacy: mercadopago, transferencia, efectivo */
  metodoPago: varchar("metodo_pago", { length: 64 }),
  notas: varchar("notas", { length: 500 }),
  puntosGanados: int("puntos_ganados").default(0),
  puntosUsados: int("puntos_usados").default(0),
  impreso: boolean("impreso").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deliveredAt: timestamp("delivered_at"),
  // Rapiboy - tracking de envío
  rapiboyTrackingUrl: varchar("rapiboy_tracking_url", { length: 512 }),
  rapiboyTripId: varchar("rapiboy_trip_id", { length: 100 }),
  // Descuento aplicado
  codigoDescuentoId: int("codigo_descuento_id").references(() => codigoDescuento.id),
  montoDescuento: decimal("monto_descuento", { precision: 10, scale: 2 }).default("0.00"),
});

// Items del pedido de delivery
export const itemPedidoDelivery = mysqlTable("item_pedido_delivery", {
  id: int("id").primaryKey().autoincrement(),
  pedidoDeliveryId: int("pedido_delivery_id").notNull(),
  productoId: int("producto_id").notNull(),
  varianteId: int("variante_id"),
  varianteNombre: varchar("variante_nombre", { length: 255 }),
  cantidad: int("cantidad").default(1),
  precioUnitario: decimal("precio_unitario", {
    precision: 10,
    scale: 2,
  }).notNull(),
  ingredientesExcluidos: json("ingredientes_excluidos"),
  agregados: json("agregados"),
  esCanjePuntos: boolean("es_canje_puntos").default(false),
});

// Pedido Take Away (sin mesa, sin dirección)
export const pedidoTakeaway = mysqlTable("pedido_takeaway", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id),
  clienteId: int("cliente_id").references(() => cliente.id),
  nombreCliente: varchar("nombre_cliente", { length: 255 }),
  telefono: varchar("telefono", { length: 50 }),
  estado: mysqlEnum("estado", [
    "pending",
    "preparing",
    "ready",
    "dispatched",
    "delivered",
    "cancelled",
    "archived",
  ]).default("pending"),
  total: decimal("total", { precision: 10, scale: 2 }).default("0.00"),
  pagado: boolean("pagado").default(false).notNull(),
  /** Canonical: mercadopago_checkout, mercadopago_bricks, transferencia_automatica_*, manual_transfer, cash; legacy: mercadopago, transferencia, efectivo */
  metodoPago: varchar("metodo_pago", { length: 64 }),
  notas: varchar("notas", { length: 500 }),
  puntosGanados: int("puntos_ganados").default(0),
  puntosUsados: int("puntos_usados").default(0),
  impreso: boolean("impreso").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  deliveredAt: timestamp("delivered_at"),
  // Descuento aplicado
  codigoDescuentoId: int("codigo_descuento_id").references(() => codigoDescuento.id),
  montoDescuento: decimal("monto_descuento", { precision: 10, scale: 2 }).default("0.00"),
});

// Items del pedido take away
export const itemPedidoTakeaway = mysqlTable("item_pedido_takeaway", {
  id: int("id").primaryKey().autoincrement(),
  pedidoTakeawayId: int("pedido_takeaway_id").notNull(),
  productoId: int("producto_id").notNull(),
  varianteId: int("variante_id"),
  varianteNombre: varchar("variante_nombre", { length: 255 }),
  cantidad: int("cantidad").default(1),
  precioUnitario: decimal("precio_unitario", {
    precision: 10,
    scale: 2,
  }).notNull(),
  ingredientesExcluidos: json("ingredientes_excluidos"),
  agregados: json("agregados"),
  esCanjePuntos: boolean("es_canje_puntos").default(false),
});

