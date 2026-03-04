CREATE TABLE `categoria` (
	`id` int AUTO_INCREMENT NOT NULL,
	`restaurante_id` int,
	`nombre` varchar(255) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `categoria_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cliente` (
	`id` int AUTO_INCREMENT NOT NULL,
	`restaurante_id` int NOT NULL,
	`nombre` varchar(255) NOT NULL,
	`telefono` varchar(50) NOT NULL,
	`direccion` varchar(255),
	`puntos` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `cliente_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `etiqueta` (
	`id` int AUTO_INCREMENT NOT NULL,
	`restaurante_id` int NOT NULL,
	`producto_id` int NOT NULL,
	`nombre` varchar(100) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `etiqueta_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_restaurante_nombre` UNIQUE(`restaurante_id`,`nombre`)
);
--> statement-breakpoint
CREATE TABLE `ingrediente` (
	`id` int AUTO_INCREMENT NOT NULL,
	`restaurante_id` int NOT NULL,
	`nombre` varchar(255) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ingrediente_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `item_pedido` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pedido_id` int NOT NULL,
	`producto_id` int NOT NULL,
	`cliente_nombre` varchar(100) NOT NULL,
	`cantidad` int DEFAULT 1,
	`precio_unitario` decimal(10,2) NOT NULL,
	`ingredientes_excluidos` json,
	`estado` enum('pending','preparing','delivered','served','cancelled') DEFAULT 'pending',
	`post_confirmacion` boolean DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `item_pedido_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `item_pedido_delivery` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pedido_delivery_id` int NOT NULL,
	`producto_id` int NOT NULL,
	`cantidad` int DEFAULT 1,
	`precio_unitario` decimal(10,2) NOT NULL,
	`ingredientes_excluidos` json,
	`es_canje_puntos` boolean DEFAULT false,
	CONSTRAINT `item_pedido_delivery_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `item_pedido_takeaway` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pedido_takeaway_id` int NOT NULL,
	`producto_id` int NOT NULL,
	`cantidad` int DEFAULT 1,
	`precio_unitario` decimal(10,2) NOT NULL,
	`ingredientes_excluidos` json,
	`es_canje_puntos` boolean DEFAULT false,
	CONSTRAINT `item_pedido_takeaway_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mesa` (
	`id` int AUTO_INCREMENT NOT NULL,
	`nombre` varchar(255) NOT NULL,
	`restaurante_id` int,
	`qr_token` varchar(255) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `mesa_id` PRIMARY KEY(`id`),
	CONSTRAINT `mesa_qr_token_unique` UNIQUE(`qr_token`)
);
--> statement-breakpoint
CREATE TABLE `notificacion` (
	`id` varchar(50) NOT NULL,
	`restaurante_id` int NOT NULL,
	`tipo` enum('NUEVO_PEDIDO','PEDIDO_CONFIRMADO','PEDIDO_CERRADO','LLAMADA_MOZO','PAGO_RECIBIDO','PRODUCTO_AGREGADO') NOT NULL,
	`mesa_id` int,
	`mesa_nombre` varchar(255),
	`pedido_id` int,
	`mensaje` varchar(500) NOT NULL,
	`detalles` varchar(500),
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	`leida` boolean NOT NULL DEFAULT false,
	CONSTRAINT `notificacion_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pago` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pedido_id` int,
	`pedido_delivery_id` int,
	`pedido_takeaway_id` int,
	`metodo` enum('efectivo','mercadopago','transferencia') NOT NULL,
	`estado` enum('pending','paid','failed') DEFAULT 'pending',
	`monto` decimal(10,2) NOT NULL,
	`mp_payment_id` varchar(255),
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `pago_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pago_subtotal` (
	`id` int AUTO_INCREMENT NOT NULL,
	`pedido_id` int NOT NULL,
	`pago_id` int,
	`cliente_nombre` varchar(100) NOT NULL,
	`monto` decimal(10,2) NOT NULL,
	`estado` enum('pending','pending_cash','paid','failed') DEFAULT 'pending',
	`metodo` enum('efectivo','mercadopago','transferencia') NOT NULL,
	`mp_payment_id` varchar(255),
	`mp_preference_id` varchar(255),
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `pago_subtotal_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pedido` (
	`id` int AUTO_INCREMENT NOT NULL,
	`restaurante_id` int,
	`mesa_id` int,
	`nombre_pedido` varchar(255),
	`estado` enum('pending','preparing','delivered','served','closed','archived') DEFAULT 'pending',
	`total` decimal(10,2) DEFAULT '0.00',
	`pagado` boolean NOT NULL DEFAULT false,
	`metodo_pago` varchar(50),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`closed_at` timestamp,
	CONSTRAINT `pedido_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pedido_delivery` (
	`id` int AUTO_INCREMENT NOT NULL,
	`restaurante_id` int,
	`cliente_id` int,
	`direccion` varchar(255) NOT NULL,
	`nombre_cliente` varchar(255),
	`telefono` varchar(50),
	`estado` enum('pending','preparing','ready','delivered','cancelled','archived') DEFAULT 'pending',
	`total` decimal(10,2) DEFAULT '0.00',
	`pagado` boolean NOT NULL DEFAULT false,
	`metodo_pago` varchar(50),
	`notas` varchar(500),
	`puntos_ganados` int DEFAULT 0,
	`puntos_usados` int DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`delivered_at` timestamp,
	CONSTRAINT `pedido_delivery_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pedido_takeaway` (
	`id` int AUTO_INCREMENT NOT NULL,
	`restaurante_id` int,
	`cliente_id` int,
	`nombre_cliente` varchar(255),
	`telefono` varchar(50),
	`estado` enum('pending','preparing','ready','delivered','cancelled','archived') DEFAULT 'pending',
	`total` decimal(10,2) DEFAULT '0.00',
	`pagado` boolean NOT NULL DEFAULT false,
	`metodo_pago` varchar(50),
	`notas` varchar(500),
	`puntos_ganados` int DEFAULT 0,
	`puntos_usados` int DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`delivered_at` timestamp,
	CONSTRAINT `pedido_takeaway_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `producto` (
	`id` int AUTO_INCREMENT NOT NULL,
	`restaurante_id` int,
	`categoria_id` int,
	`nombre` varchar(255) NOT NULL,
	`descripcion` varchar(255),
	`precio` decimal(10,2) NOT NULL,
	`activo` boolean DEFAULT true,
	`imagen_url` varchar(255),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `producto_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `producto_ingrediente` (
	`id` int AUTO_INCREMENT NOT NULL,
	`producto_id` int NOT NULL,
	`ingrediente_id` int NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `producto_ingrediente_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `producto_puntos` (
	`id` int AUTO_INCREMENT NOT NULL,
	`restaurante_id` int NOT NULL,
	`producto_id` int NOT NULL,
	`puntos_necesarios` int NOT NULL,
	`puntos_ganados` int NOT NULL DEFAULT 0,
	CONSTRAINT `producto_puntos_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `restaurante` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(255) NOT NULL,
	`nombre` varchar(255) NOT NULL,
	`password` varchar(255) NOT NULL,
	`direccion` varchar(255),
	`telefono` varchar(255),
	`imagen_url` varchar(255),
	`username` varchar(255),
	`es_carrito` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`mercado_pago_public_key` varchar(255),
	`mercado_pago_private_key` varchar(255),
	`mp_access_token` varchar(512),
	`mp_public_key` varchar(255),
	`mp_refresh_token` varchar(512),
	`mp_user_id` varchar(50),
	`mp_connected` boolean DEFAULT false,
	`split_payment` boolean NOT NULL DEFAULT true,
	`item_tracking` boolean NOT NULL DEFAULT false,
	`solo_carta_digital` boolean NOT NULL DEFAULT false,
	`delivery_fee` decimal(10,2) NOT NULL DEFAULT '0.00',
	`cucuru_customer_id` varchar(255),
	`cucuru_account_number` varchar(255),
	`cucuru_alias` varchar(255),
	`cucuru_enabled` boolean NOT NULL DEFAULT false,
	`whatsapp_enabled` boolean NOT NULL DEFAULT false,
	`whatsapp_number` varchar(50),
	`transferencia_alias` varchar(255),
	`sistema_puntos` boolean NOT NULL DEFAULT false,
	CONSTRAINT `restaurante_id` PRIMARY KEY(`id`),
	CONSTRAINT `restaurante_email_unique` UNIQUE(`email`),
	CONSTRAINT `restaurante_username_unique` UNIQUE(`username`)
);
--> statement-breakpoint
ALTER TABLE `categoria` ADD CONSTRAINT `categoria_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `cliente` ADD CONSTRAINT `cliente_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `etiqueta` ADD CONSTRAINT `etiqueta_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `etiqueta` ADD CONSTRAINT `etiqueta_producto_id_producto_id_fk` FOREIGN KEY (`producto_id`) REFERENCES `producto`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ingrediente` ADD CONSTRAINT `ingrediente_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `mesa` ADD CONSTRAINT `mesa_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notificacion` ADD CONSTRAINT `notificacion_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notificacion` ADD CONSTRAINT `notificacion_mesa_id_mesa_id_fk` FOREIGN KEY (`mesa_id`) REFERENCES `mesa`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pedido` ADD CONSTRAINT `pedido_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pedido` ADD CONSTRAINT `pedido_mesa_id_mesa_id_fk` FOREIGN KEY (`mesa_id`) REFERENCES `mesa`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pedido_delivery` ADD CONSTRAINT `pedido_delivery_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pedido_delivery` ADD CONSTRAINT `pedido_delivery_cliente_id_cliente_id_fk` FOREIGN KEY (`cliente_id`) REFERENCES `cliente`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pedido_takeaway` ADD CONSTRAINT `pedido_takeaway_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `pedido_takeaway` ADD CONSTRAINT `pedido_takeaway_cliente_id_cliente_id_fk` FOREIGN KEY (`cliente_id`) REFERENCES `cliente`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `producto` ADD CONSTRAINT `producto_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `producto` ADD CONSTRAINT `producto_categoria_id_categoria_id_fk` FOREIGN KEY (`categoria_id`) REFERENCES `categoria`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `producto_ingrediente` ADD CONSTRAINT `producto_ingrediente_producto_id_producto_id_fk` FOREIGN KEY (`producto_id`) REFERENCES `producto`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `producto_ingrediente` ADD CONSTRAINT `producto_ingrediente_ingrediente_id_ingrediente_id_fk` FOREIGN KEY (`ingrediente_id`) REFERENCES `ingrediente`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `producto_puntos` ADD CONSTRAINT `producto_puntos_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `producto_puntos` ADD CONSTRAINT `producto_puntos_producto_id_producto_id_fk` FOREIGN KEY (`producto_id`) REFERENCES `producto`(`id`) ON DELETE no action ON UPDATE no action;