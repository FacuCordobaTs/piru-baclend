// schema.ts
import { mysqlTable, varchar, int, timestamp, boolean, decimal, mysqlEnum } from "drizzle-orm/mysql-core";


export const restaurante = mysqlTable("restaurante", {
    id: int("id").primaryKey().autoincrement(),
    email: varchar("email", { length: 255 }).unique().notNull(),
    nombre: varchar("nombre", { length: 255 }).notNull(),
    password: varchar("password", { length: 255 }).notNull(),
    direccion: varchar("direccion", { length: 255 }),
    telefono: varchar("telefono", { length: 255 }),
    imagenUrl: varchar("imagen_url", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    mercadoPagoPublicKey: varchar("mercado_pago_public_key", { length: 255 }),
    mercadoPagoPrivateKey: varchar("mercado_pago_private_key", { length: 255 }),
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
    nombre: varchar("nombre", { length: 255 }).notNull(),
    descripcion: varchar("descripcion", { length: 255 }),
    precio: decimal("precio", { precision: 10, scale: 2 }).notNull(),
    activo: boolean("activo").default(true),
    imagenUrl: varchar("imagen_url", { length: 255 }),
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