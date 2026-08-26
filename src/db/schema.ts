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
  index,
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
  // Si está activo, colorPrimario se usa sólo como acento (botones/detalles),
  // sin reemplazar la paleta neutra de fondos y textos de la tienda.
  usarColorUnico: boolean("usar_color_unico").default(false).notNull(),
  // Diseño de las cartas de producto. El glassmorphism quedó discontinuado: las cartas
  // usan siempre el diseño sólido (no-glass). La columna se mantiene por retrocompat con
  // clientes viejos, pero el frontend la ignora y el backend siempre responde `true`.
  disenoAlternativo: boolean("diseno_alternativo").default(true).notNull(),
  codigoDescuentoEnabled: boolean("codigo_descuento_enabled").default(true).notNull(),

  orderGroupEnabled: boolean("order_group_enabled").default(true).notNull(),
  deliveryEnabled: boolean("delivery_enabled").default(true).notNull(),
  // Por defecto el checkout valida la ubicación con Google Maps. Algunos locales
  // prefieren recibir la dirección escrita y resolver la zona manualmente.
  direccionSoloTexto: boolean("direccion_solo_texto").default(false).notNull(),
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

  // ── Claim flow (onboarding outbound) — ver docs/ROADMAP_CLAIM_FLOW.md ──
  // Cómo nació la cuenta. 'self_serve' = registro/onboarding normal (default, no cambia nada del
  // flujo actual). 'outbound' = tienda demo que arma el fundador y el dueño "reclama" por link.
  origen: mysqlEnum("origen", ["self_serve", "outbound"]).default("self_serve").notNull(),
  // Token único del link de reclamo (admin.piru.app/mi-tienda/{claimToken}). Nullable: sólo las
  // tiendas outbound a las que se les generó link lo tienen. Se limpia (o expira) al reclamarse.
  claimToken: varchar("claim_token", { length: 64 }).unique(),
  claimTokenExpira: timestamp("claim_token_expira"),
  // Cuándo el dueño reclamó la tienda (verificó su WhatsApp). null = todavía es prospecto.
  claimedAt: timestamp("claimed_at"),

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
  direccion: varchar("direccion", { length: 512 }),
  direccionLat: decimal("direccion_lat", { precision: 10, scale: 7 }),
  direccionLng: decimal("direccion_lng", { precision: 10, scale: 7 }),
  direccionCiudad: varchar("direccion_ciudad", { length: 255 }),
  transferenciaAlias: varchar("transferencia_alias", { length: 255 }),
  whatsappEnabled: boolean("whatsapp_enabled").default(false).notNull(),
  whatsappNumber: varchar("whatsapp_number", { length: 50 }),
  rapiboyToken: varchar("rapiboy_token", { length: 512 }),
  activo: boolean("activo").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Mesas operativas del local. No reutiliza `mesa`: esa tabla sigue sosteniendo
// el flujo legacy de QR y `sala` el pedido grupal vigente.
export const mesaLocal = mysqlTable("mesa_local", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  sucursalId: int("sucursal_id").references(() => sucursal.id, { onDelete: "set null" }),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  // Coordenadas y tamaño en unidades del grid del editor (T33), no píxeles.
  posicionX: int("posicion_x").default(0).notNull(),
  posicionY: int("posicion_y").default(0).notNull(),
  ancho: int("ancho").default(1).notNull(),
  alto: int("alto").default(1).notNull(),
  capacidad: int("capacidad").default(1).notNull(),
  // Es una marca manual opcional. T34 siempre deriva la ocupación de pedidos abiertos.
  estadoManual: varchar("estado_manual", { length: 50 }),
  activo: boolean("activo").default(true).notNull(),
  orden: int("orden").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_mesa_local_restaurante_activo_orden").on(table.restauranteId, table.activo, table.orden),
  index("idx_mesa_local_sucursal_activo").on(table.sucursalId, table.activo),
]);

export const repartidor = mysqlTable("repartidor", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  estado: mysqlEnum("estado", ["activo", "inactivo"]).default("activo").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Identidades operativas del restaurante. No reutilizan la contraseña ni el
// JWT del dueño: los mozos usan OTP y una sesion revocable. PIN/codigo quedan
// como columnas de compatibilidad para PWAs instaladas antes de este flujo.
export const usuarioRestaurante = mysqlTable("usuario_restaurante", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id, { onDelete: "cascade" }).notNull(),
  sucursalId: int("sucursal_id").references(() => sucursal.id, { onDelete: "set null" }),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  // El nombre físico es `rol` (ver add_staff_restaurante.sql). El primer
  // schema de Drizzle usó por error el nombre del tipo enum de MySQL como si
  // fuera una columna, haciendo fallar cualquier consulta de staff/POS.
  rol: mysqlEnum("rol", ["owner", "admin", "mozo"]).notNull(),
  // Credenciales del login legacy; el owner nunca copia aqui su contraseña.
  pinHash: varchar("pin_hash", { length: 255 }),
  codigoAcceso: varchar("codigo_acceso", { length: 64 }).unique(),
  // Identificador corto y humano dentro del local. El login nuevo de mozos usa
  // este numero + un OTP enviado al WhatsApp verificado del restaurante.
  numeroMozo: int("numero_mozo"),
  activo: boolean("activo").default(true).notNull(),
  intentosPinFallidos: int("intentos_pin_fallidos").default(0).notNull(),
  bloqueadoHasta: timestamp("bloqueado_hasta"),
  ultimoAccesoAt: timestamp("ultimo_acceso_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_usuario_restaurante_restaurante_activo").on(table.restauranteId, table.activo),
  index("idx_usuario_restaurante_sucursal_activo").on(table.sucursalId, table.activo),
  uniqueIndex("uq_usuario_restaurante_numero_mozo").on(table.restauranteId, table.numeroMozo),
]);

// El JWT de staff contiene el id de esta sesión; persistir su hash permite
// revocarlo sin tener que aceptar ni invalidar el JWT del dueño.
export const sesionStaff = mysqlTable("sesion_staff", {
  id: int("id").primaryKey().autoincrement(),
  usuarioRestauranteId: int("usuario_restaurante_id").references(() => usuarioRestaurante.id, { onDelete: "cascade" }).notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  expiraAt: timestamp("expira_at").notNull(),
  revocadaAt: timestamp("revocada_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_sesion_staff_usuario_activa").on(table.usuarioRestauranteId, table.revocadaAt, table.expiraAt),
]);

// OTP exclusivo para la app de mozos. Esta tabla separada evita que un codigo
// solicitado para staff pueda consumirse en el login de la cuenta dueña.
export const verificacionStaff = mysqlTable("verificacion_staff", {
  id: varchar("id", { length: 36 }).primaryKey(),
  usuarioRestauranteId: int("usuario_restaurante_id").references(() => usuarioRestaurante.id, { onDelete: "cascade" }).notNull(),
  telefono: varchar("telefono", { length: 50 }).notNull(),
  codigoHash: varchar("codigo_hash", { length: 255 }).notNull(),
  intentos: int("intentos").default(0).notNull(),
  verificado: boolean("verificado").default(false).notNull(),
  expiraEn: timestamp("expira_en").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_verificacion_staff_telefono_fecha").on(table.telefono, table.createdAt),
  index("idx_verificacion_staff_usuario_fecha").on(table.usuarioRestauranteId, table.createdAt),
]);

export const pedidoUnificado = mysqlTable("pedido_unificado", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  sucursalId: int("sucursal_id").references(() => sucursal.id),
  // Los pedidos de mesa usan el discriminador `mesa`. `consumoEnLocal` se
  // conserva para compatibilidad con clientes desplegados durante la transición.
  mesaLocalId: int("mesa_local_id").references(() => mesaLocal.id, { onDelete: "set null" }),
  consumoEnLocal: boolean("consumo_en_local").default(false).notNull(),
  // Nullable: pedidos públicos, IA y el historial anterior no tienen actor de staff.
  creadoPorUsuarioId: int("creado_por_usuario_id").references(() => usuarioRestaurante.id, { onDelete: "set null" }),
  clienteId: int("cliente_id").references(() => cliente.id), // Nullable si no se registró

  // Discriminador principal
  tipo: mysqlEnum("tipo", ["delivery", "takeaway", "mesa"]).notNull(),

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
  // Edición optimista de comandas POS. Las apps antiguas pueden ignorarlos.
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  version: int("version").default(1).notNull(),
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
}, (table) => [
  index("idx_pedido_unificado_mesa_local_estado").on(table.mesaLocalId, table.estado),
  index("idx_pedido_unificado_creado_por_usuario").on(table.creadoPorUsuarioId),
]);

export const itemPedidoUnificado = mysqlTable("item_pedido_unificado", {
  id: int("id").primaryKey().autoincrement(),
  pedidoId: int("pedido_id").references(() => pedidoUnificado.id, { onDelete: 'cascade' }).notNull(),
  productoId: int("producto_id").notNull(), // No le ponemos fk estricta por si borran el producto, no romper el historial
  varianteId: int("variante_id"),
  varianteNombre: varchar("variante_nombre", { length: 255 }),
  // Segunda elección opcional del producto (p. ej. tamaño + tipo de medallón).
  // Se conserva la variante original como precio base para retrocompatibilidad.
  varianteSecundariaId: int("variante_secundaria_id"),
  varianteSecundariaNombre: varchar("variante_secundaria_nombre", { length: 255 }),
  cantidad: int("cantidad").default(1).notNull(),
  // Cantidad de esta fila que ya fue enviada a cocina. Permite imprimir sólo
  // las unidades agregadas después de abrir una mesa, incluso tras un reload.
  cantidadImpresa: int("cantidad_impresa").default(0).notNull(),
  precioUnitario: decimal("precio_unitario", { precision: 10, scale: 2 }).notNull(),
  esCanjePuntos: boolean("es_canje_puntos").default(false),
  ingredientesExcluidos: json("ingredientes_excluidos"),
  agregados: json("agregados"),
  // Aclaración escrita por el cliente para este producto en particular.
  nota: varchar("nota", { length: 500 }),
  // Nombre del cliente que agregó este item (solo relevante en pedidos grupales)
  clienteNombre: varchar("cliente_nombre", { length: 255 }),
});

// Ledger de mutaciones POS. El actor se mantiene nullable para el historial previo.
export const pedidoUnificadoAuditoria = mysqlTable("pedido_unificado_auditoria", {
  id: int("id").primaryKey().autoincrement(),
  pedidoId: int("pedido_id").references(() => pedidoUnificado.id, { onDelete: 'cascade' }).notNull(),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  itemPedidoId: int("item_pedido_id").references(() => itemPedidoUnificado.id, { onDelete: 'set null' }),
  usuarioRestauranteId: int("usuario_restaurante_id").references(() => usuarioRestaurante.id, { onDelete: 'set null' }),
  operacion: mysqlEnum("operacion", ["agregar_item", "editar_item", "eliminar_item", "editar_datos_pos"]).notNull(),
  actorTipo: varchar("actor_tipo", { length: 40 }).default("restaurante_admin").notNull(),
  antes: json("antes"),
  despues: json("despues"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_pedido_unificado_auditoria_usuario_fecha").on(table.usuarioRestauranteId, table.createdAt),
]);

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
  // Textos configurables de cada paso del personalizador. Los defaults preservan
  // exactamente el copy que consumen las versiones anteriores de la tienda.
  tituloVariantesPrimarias: varchar("titulo_variantes_primarias", { length: 120 }).default("Elegí una opción").notNull(),
  tituloVariantesSecundarias: varchar("titulo_variantes_secundarias", { length: 120 }).default("Elegí también una segunda opción").notNull(),
  tituloExtrasPrimarios: varchar("titulo_extras_primarios", { length: 120 }).default("Extras").notNull(),
  tituloExtrasSecundarios: varchar("titulo_extras_secundarios", { length: 120 }).default("Extras").notNull(),
  permiteNota: boolean("permite_nota").default(false).notNull(),
  tituloNota: varchar("titulo_nota", { length: 120 }).default("¿Querés aclarar algo?").notNull(),
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
  // 1 = variante primaria con precio absoluto; 2 = segunda elección cuyo precio es un adicional.
  grupo: int("grupo").default(1).notNull(),
  activo: boolean("activo").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const categoria = mysqlTable("categoria", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  // Las bebidas se destacan visualmente en las comandas de cocina.
  esBebida: boolean("es_bebida").default(false).notNull(),
  // Orden manual de aparición en la carta (menor = primero).
  orden: int("orden").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_categoria_restaurante_orden").on(table.restauranteId, table.orden, table.id),
]);

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
    // 1 = extras primarios; 2 = extras secundarios (se muestran después).
    grupo: int("grupo").default(1).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_producto_agregado").on(table.productoId, table.agregadoId),
    index("idx_producto_agregado_grupo").on(table.productoId, table.grupo),
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
  // Motor de Recompra · 4.5 (protección de la base) — opt-out de mensajes de MARKETING.
  // Si el cliente pide la baja (respondió "BAJA"/"STOP" por WhatsApp), no se lo contacta más
  // con recupero/campañas. NO afecta los mensajes transaccionales (pedido/pago), que siempre salen.
  marketingOptOut: boolean("marketing_opt_out").default(false).notNull(),
  marketingOptOutAt: timestamp("marketing_opt_out_at"),
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

// Claim durable de idempotencia para los envíos automáticos a clientes. Se separa
// del historial porque el claim debe existir ANTES de llamar a Meta: de ese modo
// dos webhooks concurrentes no pueden enviar dos veces el mismo aviso.
export const envioWhatsappIdempotencia = mysqlTable("envio_whatsapp_idempotencia", {
  id: int("id").primaryKey().autoincrement(),
  pedidoUnificadoId: int("pedido_unificado_id")
    .references(() => pedidoUnificado.id)
    .notNull(),
  restauranteId: int("restaurante_id")
    .references(() => restaurante.id)
    .notNull(),
  tipo: varchar("tipo", { length: 50 }).notNull(),
  estado: mysqlEnum("estado", ["procesando", "enviado", "fallido"])
    .default("procesando")
    .notNull(),
  metaMessageId: varchar("meta_message_id", { length: 255 }),
  error: varchar("error", { length: 1000 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_envio_whatsapp_pedido_tipo").on(table.pedidoUnificadoId, table.tipo),
  index("idx_envio_whatsapp_restaurante_fecha").on(table.restauranteId, table.createdAt),
]);

// Motor de Recompra · playbook de recupero de dormidos (tarea 4.2).
// Un registro por cada "toque" de recupero enviado a un cliente. Sostiene la
// escalera de incentivos (nivel 1 sin descuento → 2 con 10% → 3 con 20% + vencimiento):
// el próximo nivel se deriva de cuántos toques se enviaron DESPUÉS de su último pedido
// (si el cliente volvió a pedir, la escalera se reinicia sola). Es, además, la base de
// la futura atribución honesta (4.4): quién fue contactado, cuándo y con qué incentivo.
export const recuperoCliente = mysqlTable("recupero_cliente", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  clienteId: int("cliente_id").references(() => cliente.id).notNull(),
  telefono: varchar("telefono", { length: 50 }).notNull(),
  // Escalón de la escalera de incentivos (1, 2 o 3).
  nivel: int("nivel").notNull(),
  descuentoPorcentaje: int("descuento_porcentaje").default(0).notNull(),
  // Código de descuento generado para este toque (null en el nivel 1, que no lleva descuento).
  codigoDescuento: varchar("codigo_descuento", { length: 50 }),
  // Segmento del cliente al momento del envío (para atribución posterior).
  segmento: varchar("segmento", { length: 20 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// Motor de Recompra · 4.4 — Campaña de recompra (envío batch) + grupo de control.
// Cada "encendido del motor" es una campaña: se detecta la cohorte recuperable, se aparta al azar
// un 10% de cada segmento como GRUPO DE CONTROL (no se contacta) y al resto se le envía el toque.
// Guardar quién quedó en control es lo que hace posible la atribución honesta ("los contactados
// volvieron al X% vs Y% los de control"). Imposible de reconstruir después: por eso va desde el día 1.
export const campanaRecompra = mysqlTable("campana_recompra", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  totalDetectados: int("total_detectados").default(0).notNull(),
  totalContactados: int("total_contactados").default(0).notNull(),
  totalControl: int("total_control").default(0).notNull(),
  totalFallidos: int("total_fallidos").default(0).notNull(),
  // ── Motor de Recompra · goteo (piloto automático) — campos aditivos ──────────
  // El modelo dejó de ser "batch masivo por click" para ser una CAMPAÑA PERSISTENTE
  // que gotea a ritmo diario. Una fila con `estado` no-null es la campaña viva del
  // local (una a la vez). Las filas viejas (estado null) son los encendidos batch legacy.
  // 'activa' | 'pausada_sin_saldo' | 'pausada_manual' | 'completada'
  estado: varchar("estado", { length: 20 }),
  // Cupo diario de envíos (warm-up del número + cocina sin picos). Configurable por local, con tope duro de sistema.
  cupoDiario: int("cupo_diario").default(30).notNull(),
  // Contador del día en curso (día de Argentina "YYYY-MM-DD") y cuántos se enviaron ese día.
  diaContador: varchar("dia_contador", { length: 10 }),
  enviadosHoy: int("enviados_hoy").default(0).notNull(),
  // Total acumulado de mensajes enviados por esta campaña (para el marcador diario).
  totalEnviados: int("total_enviados").default(0).notNull(),
  // Protección contra la súplica: se avisa una sola vez al pausar por saldo, luego 1 recordatorio/semana.
  avisoSinSaldoAt: timestamp("aviso_sin_saldo_at"),
  activadaAt: timestamp("activada_at"),
  pausadaAt: timestamp("pausada_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const campanaRecompraCliente = mysqlTable("campana_recompra_cliente", {
  id: int("id").primaryKey().autoincrement(),
  campanaId: int("campana_id").references(() => campanaRecompra.id).notNull(),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  clienteId: int("cliente_id").references(() => cliente.id).notNull(),
  // 'contactado' | 'control' — el control es el 10% apartado al azar (atribución honesta).
  rol: varchar("rol", { length: 20 }).notNull(),
  segmento: varchar("segmento", { length: 20 }),
  // Escalón de la escalera enviado (null en control).
  nivel: int("nivel"),
  codigoDescuento: varchar("codigo_descuento", { length: 50 }),
  envioOk: boolean("envio_ok").default(false).notNull(),
  // Snapshots al momento de la campaña, para medir la atribución después (¿volvió a pedir?).
  totalGastadoSnapshot: decimal("total_gastado_snapshot", { precision: 12, scale: 2 }).default("0.00"),
  ultimoPedidoAtSnapshot: timestamp("ultimo_pedido_at_snapshot"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});


// Motor de Recompra · goteo — COLA DE ENVÍOS (piloto automático).
// El corazón del rediseño: en vez de mandar todo de una, la campaña deja pendientes en esta cola y
// un job diario los gotea al ritmo del cupo. Dos poblaciones:
//   - 'flujo'  → clientes que cruzan HOY su umbral personal (máxima prioridad, nunca se posponen).
//   - 'stock'  → el backlog de ya-fríos al encender (se drena por prioridad: segmento × ticket).
// Regla sagrada: si el cliente hace un pedido, su fila pendiente pasa a 'salido' (no se lo contacta).
export const colaRecompra = mysqlTable("cola_recompra", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
  campanaId: int("campana_id").references(() => campanaRecompra.id).notNull(),
  clienteId: int("cliente_id").references(() => cliente.id).notNull(),
  telefono: varchar("telefono", { length: 50 }),
  segmento: varchar("segmento", { length: 20 }),
  // Prioridad para drenar el stock: peso del segmento × ticket histórico (más alto = antes).
  prioridad: decimal("prioridad", { precision: 14, scale: 2 }).default("0.00"),
  // 'flujo' | 'stock'
  poblacion: varchar("poblacion", { length: 10 }).notNull(),
  // 'contactado' | 'control' (el 10% apartado para la atribución honesta).
  rol: varchar("rol", { length: 20 }).default("contactado").notNull(),
  // Cuándo debería salir: flujo → hoy; stock → lo antes posible ajustado a su mejor día/franja.
  dueDate: timestamp("due_date"),
  // 'pendiente' | 'enviado' | 'salido' | 'fallido' | 'control'
  estado: varchar("estado", { length: 20 }).default("pendiente").notNull(),
  // Escalón de la escalera que se le mandó (se resuelve al enviar).
  nivel: int("nivel"),
  codigoDescuento: varchar("codigo_descuento", { length: 50 }),
  enviadoAt: timestamp("enviado_at"),
  // Snapshots al encolar, para medir la atribución después (¿volvió a pedir tras el toque?).
  totalGastadoSnapshot: decimal("total_gastado_snapshot", { precision: 12, scale: 2 }).default("0.00"),
  ultimoPedidoAtSnapshot: timestamp("ultimo_pedido_at_snapshot"),
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
// SUSCRIPCIÓN ÚNICA Y MÓDULOS
//
// El catálogo de módulos es la fuente de verdad nueva. `plan` y `planFeature`
// permanecen más abajo sólo como compatibilidad temporal para admins antiguos;
// no deben usarse para capacidades nuevas.
// ============================================================================

export const configuracionSuscripcion = mysqlTable("configuracion_suscripcion", {
  id: int("id").primaryKey().autoincrement(),
  codigo: varchar("codigo", { length: 50 }).unique().notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  descripcion: varchar("descripcion", { length: 500 }),
  precioMensual: decimal("precio_mensual", { precision: 10, scale: 2 }).notNull(),
  descuentoAnual: int("descuento_anual").default(20).notNull(),
  activo: boolean("activo").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const categoriaModulo = mysqlTable("categoria_modulo", {
  id: int("id").primaryKey().autoincrement(),
  codigo: varchar("codigo", { length: 50 }).unique().notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  descripcion: varchar("descripcion", { length: 500 }),
  orden: int("orden").default(0).notNull(),
  activo: boolean("activo").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const modulo = mysqlTable("modulo", {
  id: int("id").primaryKey().autoincrement(),
  codigo: varchar("codigo", { length: 100 }).unique().notNull(),
  categoriaId: int("categoria_id").references(() => categoriaModulo.id).notNull(),
  nombre: varchar("nombre", { length: 255 }).notNull(),
  descripcion: varchar("descripcion", { length: 500 }),
  tipo: mysqlEnum("tipo_modulo", ["incluido", "pago"]).notNull(),
  precioMensual: decimal("precio_mensual", { precision: 10, scale: 2 }).default("0.00").notNull(),
  mensajesUtilityIncluidos: int("mensajes_utility_incluidos").default(0).notNull(),
  mensajesMarketingIncluidos: int("mensajes_marketing_incluidos").default(0).notNull(),
  estadoProducto: mysqlEnum("estado_producto", ["disponible", "beta", "proximamente"])
    .default("disponible")
    .notNull(),
  activable: boolean("activable").default(true).notNull(),
  icono: varchar("icono", { length: 100 }),
  orden: int("orden").default(0).notNull(),
  activo: boolean("activo").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [index("idx_modulo_categoria_orden").on(table.categoriaId, table.orden)]);

export const restauranteModulo = mysqlTable(
  "restaurante_modulo",
  {
    id: int("id").primaryKey().autoincrement(),
    restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
    moduloId: int("modulo_id").references(() => modulo.id).notNull(),
    estado: mysqlEnum("estado_restaurante_modulo", [
      "inactivo",
      "pendiente_pago",
      "activo",
      "cancelacion_programada",
      "suspendido",
    ]).default("inactivo").notNull(),
    activadoAt: timestamp("activado_at"),
    desactivadoAt: timestamp("desactivado_at"),
    vigenteHasta: timestamp("vigente_hasta"),
    precioMensualCongelado: decimal("precio_mensual_congelado", { precision: 10, scale: 2 }),
    origen: mysqlEnum("origen_restaurante_modulo", ["usuario", "interno", "migracion", "trial", "legacy"])
      .default("usuario")
      .notNull(),
    cancelarAlFinPeriodo: boolean("cancelar_al_fin_periodo").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_restaurante_modulo").on(table.restauranteId, table.moduloId),
    index("idx_restaurante_modulo_estado").on(table.restauranteId, table.estado),
  ],
);

// Intervalos operativos definidos por el restaurante. Los pedidos se relacionan
// por su created_at dentro de [aperturaAt, cierreAt), lo que mantiene intactos
// los pedidos y clientes anteriores al despliegue del módulo.
export const turnoCaja = mysqlTable("turno_caja", {
  id: int("id").primaryKey().autoincrement(),
  restauranteId: int("restaurante_id").references(() => restaurante.id, { onDelete: "cascade" }).notNull(),
  aperturaAt: timestamp("apertura_at").notNull(),
  cierreAt: timestamp("cierre_at"),
  // true sólo para el turno actual; NULL para históricos. El índice unique
  // aprovecha que MySQL permite múltiples NULL y evita dos turnos abiertos.
  abierto: boolean("abierto").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_turno_caja_restaurante_apertura").on(table.restauranteId, table.aperturaAt),
  index("idx_turno_caja_restaurante_cierre").on(table.restauranteId, table.cierreAt),
  uniqueIndex("uq_turno_caja_un_abierto").on(table.restauranteId, table.abierto),
]);

// ============================================================================
// COMPATIBILIDAD LEGACY DE PLANES
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
  // Mensajes utility (avisos de pedido) incluidos por ciclo. 0 = ninguno (plan Básico).
  mensajesIncluidos: int("mensajes_incluidos").default(0).notNull(),
  // Mensajes MARKETING (campañas del Motor de Recompra) incluidos por ciclo. 0 = ninguno
  // (Básico/Intermedio). El Avanzado incluye 100/mes como "degustación" del Motor.
  mensajesMarketingIncluidos: int("mensajes_marketing_incluidos").default(0).notNull(),
  // LEGACY (Modelo 2): antes el Avanzado daba mensajes sin tope. En el Modelo 3 NINGÚN plan
  // es ilimitado (el "ilimitado" era insostenible: cada mensaje tiene costo real en Meta).
  // La columna se conserva por retrocompat; debe quedar en false en todos los planes.
  mensajesIlimitados: boolean("mensajes_ilimitados").default(false).notNull(),
  // Descuento porcentual al pagar el plan por año (0-20). Editable sin deploy.
  // El negocio topea el ahorro anual a 20%; el cálculo del monto (montoPorCiclo)
  // lo clampea de nuevo por las dudas. 0 = anual sin descuento (12 × mensual).
  descuentoAnual: int("descuento_anual").default(20).notNull(),
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
  // Compatibilidad temporal para endpoints/admins anteriores. La fuente nueva es
  // configuracionSuscripcionId; T05 retirará la dependencia de este campo.
  planId: int("plan_id")
    .references(() => plan.id)
    .notNull(),
  configuracionSuscripcionId: int("configuracion_suscripcion_id")
    .references(() => configuracionSuscripcion.id),
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
  // Cuándo se envió el aviso "tu prueba está por vencer" (día ~3) por WhatsApp. Sirve de flag
  // anti-reenvío del scheduler: mientras no sea null, el aviso ya salió y no se repite en cada tick.
  // Se resetea a null al arrancar un trial nuevo (iniciarTrial) para que un re-trial vuelva a avisar.
  avisoTrialVencimientoAt: timestamp("aviso_trial_vencimiento_at"),
  // Precio congelado al momento de contratar (por si luego cambia el precio del plan).
  precioMensual: decimal("precio_mensual", { precision: 10, scale: 2 }),
  // Snapshots de lectura rápida; el importe autoritativo se resuelve desde los
  // módulos activos y sus precios congelados.
  precioBaseMensual: decimal("precio_base_mensual", { precision: 10, scale: 2 }),
  montoModulosMensual: decimal("monto_modulos_mensual", { precision: 10, scale: 2 })
    .default("0.00")
    .notNull(),
  montoTotalMensual: decimal("monto_total_mensual", { precision: 10, scale: 2 }),
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

  // MARKETING — cupo del plan para ESTE ciclo (Avanzado: 100). Se acredita al inicio del
  // ciclo y el SOBRANTE SE PIERDE en la renovación (mismo criterio que utility).
  marketingIncluidosRestantes: int("marketing_incluidos_restantes").default(0).notNull(),
  // MARKETING — saldo de packs de recarga prepagos. SE ACUMULA. Puede ser NEGATIVO.
  marketingRecargaSaldo: int("marketing_recarga_saldo").default(0).notNull(),

  // Avisos de consumo del cupo utility (una sola vez por ciclo; se resetean al renovar).
  aviso80Enviado: boolean("aviso_80_enviado").default(false).notNull(),
  aviso95Enviado: boolean("aviso_95_enviado").default(false).notNull(),

  // Auto-recarga opcional: cuando el saldo utility disponible cae por debajo del umbral,
  // se dispara la compra de un pack (el que no quiere pensar, la activa y listo).
  autoRecargaHabilitada: boolean("auto_recarga_habilitada").default(false).notNull(),
  autoRecargaUmbral: int("auto_recarga_umbral"),     // dispara cuando disponible <= umbral
  autoRecargaCantidad: int("auto_recarga_cantidad"), // tamaño del pack a comprar (ej: 500)

  // Aviso por WhatsApp al DUEÑO cuando el saldo utility está bajo (plantilla `saldo_bajo_v1`,
  // con link de pago de selección de pack). Nivel del último aviso enviado este ciclo:
  // null = no se avisó · 1 = 80% del cupo consumido · 2 = 95% · 3 = saldo agotado (<= 0).
  // Se resetea a null al renovar el ciclo (mismo criterio que aviso80Enviado/aviso95Enviado).
  // La progresión 1→2→3 acota el spam a un máximo de 3 mensajes por ciclo.
  avisoSaldoBajoNivel: int("aviso_saldo_bajo_nivel"),

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
  // Link ABIERTO (sin pack definido): la recarga nace con packRecargaId/cantidad/monto en 0 y la
  // página pública `/pago/:token` muestra los packs; recién al elegir uno se fijan
  // packRecargaId/cantidad/monto y se crea la preferencia MP. Lo usa el aviso de saldo bajo por
  // WhatsApp (`saldo_bajo_v1`), donde no sabemos qué pack va a querer el dueño.
  seleccionPack: boolean("seleccion_pack").default(false).notNull(),
  // Referencias de MercadoPago (pago a la cuenta de la plataforma Piru).
  mpPreferenceId: varchar("mp_preference_id", { length: 255 }),
  mpPaymentId: varchar("mp_payment_id", { length: 255 }),
  // Link de pago por QR (`/pago/:token`): token de un solo uso para pagar la recarga
  // desde otro dispositivo (el celular) SIN login. `tokenExpiraEn` acota su validez.
  token: varchar("token", { length: 64 }).unique(),
  tokenExpiraEn: timestamp("token_expira_en"),
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
  // Compatibilidad temporal: los pagos nuevos se describen mediante sus ítems.
  planId: int("plan_id")
    .references(() => plan.id)
    .notNull(),
  configuracionSuscripcionId: int("configuracion_suscripcion_id")
    .references(() => configuracionSuscripcion.id),
  // Ciclo cubierto por este pago.
  ciclo: mysqlEnum("ciclo_pago", ["mensual", "anual"]).default("mensual").notNull(),
  // Monto pagado en ARS (autoritativo del servidor, sale del precio del plan).
  monto: decimal("monto", { precision: 10, scale: 2 }).notNull(),
  montoBase: decimal("monto_base", { precision: 10, scale: 2 }),
  montoModulos: decimal("monto_modulos", { precision: 10, scale: 2 }).default("0.00").notNull(),
  // Recarga prepaga opcional cobrada dentro de la misma preferencia de MP.
  // La fila vinculada conserva el comprobante y acredita el wallet en el webhook.
  montoRecarga: decimal("monto_recarga", { precision: 10, scale: 2 }).default("0.00").notNull(),
  recargaMensajesId: int("recarga_mensajes_id")
    .references(() => recargaMensajes.id),
  montoTotal: decimal("monto_total", { precision: 10, scale: 2 }),
  // Período de cobertura que otorga este pago (se setea al confirmar).
  periodoDesde: timestamp("periodo_desde"),
  periodoHasta: timestamp("periodo_hasta"),
  // Estado del pago. Nace 'pending' (Checkout Pro) y pasa a 'paid' con el webhook.
  estado: mysqlEnum("estado_pago_suscripcion", ["pending", "paid", "failed"]).default("pending").notNull(),
  // Referencias de MercadoPago (pago a la cuenta de la plataforma Piru).
  mpPreferenceId: varchar("mp_preference_id", { length: 255 }),
  mpPaymentId: varchar("mp_payment_id", { length: 255 }),
  // Link de pago (`/pago/:token`): token de un solo uso para pagar la cuota del plan desde
  // otro dispositivo (el celular) SIN login — se envía por WhatsApp al dueño. `tokenExpiraEn`
  // acota su validez. Comparte el espacio de tokens con `recargaMensajes.token`.
  token: varchar("token", { length: 64 }).unique(),
  tokenExpiraEn: timestamp("token_expira_en"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_pago_suscripcion_recarga").on(table.recargaMensajesId),
]);

export const pagoSuscripcionItem = mysqlTable("pago_suscripcion_item", {
  id: int("id").primaryKey().autoincrement(),
  pagoSuscripcionId: int("pago_suscripcion_id")
    .references(() => pagoSuscripcion.id, { onDelete: "cascade" })
    .notNull(),
  tipo: mysqlEnum("tipo_item_pago_suscripcion", ["base", "modulo", "pack_mensajes"]).notNull(),
  moduloId: int("modulo_id").references(() => modulo.id),
  codigo: varchar("codigo", { length: 100 }).notNull(),
  descripcion: varchar("descripcion", { length: 500 }).notNull(),
  cantidad: int("cantidad").default(1).notNull(),
  precioUnitario: decimal("precio_unitario", { precision: 10, scale: 2 }).notNull(),
  monto: decimal("monto", { precision: 10, scale: 2 }).notNull(),
  desde: timestamp("desde"),
  hasta: timestamp("hasta"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_pago_suscripcion_item_pago").on(table.pagoSuscripcionId),
  index("idx_pago_suscripcion_item_modulo").on(table.moduloId),
]);

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
