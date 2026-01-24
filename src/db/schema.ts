// schema.ts
import { mysqlTable, varchar, int, timestamp, boolean, decimal, mysqlEnum, json } from "drizzle-orm/mysql-core";


export const restaurante = mysqlTable("restaurante", {
    id: int("id").primaryKey().autoincrement(),
    email: varchar("email", { length: 255 }).unique().notNull(),
    nombre: varchar("nombre", { length: 255 }).notNull(),
    password: varchar("password", { length: 255 }).notNull(),
    direccion: varchar("direccion", { length: 255 }),
    telefono: varchar("telefono", { length: 255 }),
    imagenUrl: varchar("imagen_url", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // Campos legacy (se pueden eliminar después de migrar)
    mercadoPagoPublicKey: varchar("mercado_pago_public_key", { length: 255 }),
    mercadoPagoPrivateKey: varchar("mercado_pago_private_key", { length: 255 }),
    // Campos OAuth de MercadoPago para Marketplace
    mpAccessToken: varchar("mp_access_token", { length: 512 }),
    mpPublicKey: varchar("mp_public_key", { length: 255 }),
    mpRefreshToken: varchar("mp_refresh_token", { length: 512 }),
    mpUserId: varchar("mp_user_id", { length: 50 }),
    mpConnected: boolean("mp_connected").default(false),
});

export const categoria = mysqlTable("categoria", {
    id: int("id").primaryKey().autoincrement(),
    restauranteId: int("restaurante_id").references(() => restaurante.id),
    nombre: varchar("nombre", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const mesa = mysqlTable("mesa", {
    id: int("id").primaryKey().autoincrement(),
    nombre: varchar("nombre", { length: 255 }).notNull(),
    restauranteId: int("restaurante_id").references(() => restaurante.id),
    qrToken: varchar("qr_token", { length: 255 }).unique().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
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
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const ingrediente = mysqlTable("ingrediente", {
    id: int("id").primaryKey().autoincrement(),
    restauranteId: int("restaurante_id").references(() => restaurante.id).notNull(),
    nombre: varchar("nombre", { length: 255 }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const productoIngrediente = mysqlTable("producto_ingrediente", {
    id: int("id").primaryKey().autoincrement(),
    productoId: int("producto_id").references(() => producto.id).notNull(),
    ingredienteId: int("ingrediente_id").references(() => ingrediente.id).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const pedido = mysqlTable("pedido", {
    id: int("id").primaryKey().autoincrement(),
    restauranteId: int("restaurante_id").references(() => restaurante.id),
    mesaId: int("mesa_id").references(() => mesa.id),
    estado: mysqlEnum('estado', ['pending', 'preparing', 'delivered', 'closed']).default('pending'),
    total: decimal("total", { precision: 10, scale: 2 }).default('0.00'),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    closedAt: timestamp("closed_at"),
});

export const itemPedido = mysqlTable('item_pedido', {
    id: int('id').primaryKey().autoincrement(),
    pedidoId: int('pedido_id').notNull(),
    productoId: int('producto_id').notNull(),
    clienteNombre: varchar('cliente_nombre', { length: 100 }).notNull(),
    cantidad: int('cantidad').default(1),
    precioUnitario: decimal('precio_unitario', { precision: 10, scale: 2 }).notNull(),
    ingredientesExcluidos: json('ingredientes_excluidos'), // Array de IDs de ingredientes excluidos
    postConfirmacion: boolean('post_confirmacion').default(false), // true si se agregó después de confirmar el pedido
});

export const pago = mysqlTable('pago', {
    id: int('id').primaryKey().autoincrement(),
    pedidoId: int('pedido_id').notNull(),
    metodo: mysqlEnum('metodo', ['efectivo', 'mercadopago']).notNull(),
    estado: mysqlEnum('estado', ['pending', 'paid', 'failed']).default('pending'),
    monto: decimal('monto', { precision: 10, scale: 2 }).notNull(),
    mpPaymentId: varchar('mp_payment_id', { length: 255 }),
    createdAt: timestamp('created_at').defaultNow(),
});

// Tabla para trackear pagos de subtotales individuales (split payment)
export const pagoSubtotal = mysqlTable('pago_subtotal', {
    id: int('id').primaryKey().autoincrement(),
    pedidoId: int('pedido_id').notNull(),
    pagoId: int('pago_id'), // Referencia al pago principal (puede ser null si es pago en efectivo)
    clienteNombre: varchar('cliente_nombre', { length: 100 }).notNull(),
    monto: decimal('monto', { precision: 10, scale: 2 }).notNull(),
    estado: mysqlEnum('estado', ['pending', 'pending_cash', 'paid', 'failed']).default('pending'),
    metodo: mysqlEnum('metodo', ['efectivo', 'mercadopago']).notNull(),
    mpPaymentId: varchar('mp_payment_id', { length: 255 }), // Para identificar el pago en webhook
    mpPreferenceId: varchar('mp_preference_id', { length: 255 }), // ID de la preferencia creada
    createdAt: timestamp('created_at').defaultNow(),
});

export const notificacion = mysqlTable('notificacion', {
    id: varchar('id', { length: 50 }).primaryKey(), // Format: notif-timestamp-random
    restauranteId: int('restaurante_id').references(() => restaurante.id).notNull(),
    tipo: mysqlEnum('tipo', ['NUEVO_PEDIDO', 'PEDIDO_CONFIRMADO', 'PEDIDO_CERRADO', 'LLAMADA_MOZO', 'PAGO_RECIBIDO', 'PRODUCTO_AGREGADO']).notNull(),
    mesaId: int('mesa_id').references(() => mesa.id),
    mesaNombre: varchar('mesa_nombre', { length: 255 }),
    pedidoId: int('pedido_id'),
    mensaje: varchar('mensaje', { length: 500 }).notNull(),
    detalles: varchar('detalles', { length: 500 }),
    timestamp: timestamp('timestamp').defaultNow().notNull(),
    leida: boolean('leida').default(false).notNull(),
});