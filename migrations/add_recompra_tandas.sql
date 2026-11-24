-- Recompra por tandas y chats de WhatsApp de sólo lectura.
--
-- ADITIVA: crea tres tablas nuevas y no toca las existentes. La cola continua del Motor de
-- Recompra (`cola_recompra`, `recupero_cliente`) queda intacta; la pantalla Recompra del panel
-- deja de leerla y trabaja con tandas que arma el dueño cuando quiere.
--
--   recompra_tanda          una tanda: canal, cantidad pedida y presupuesto de beneficios.
--   recompra_tanda_mensaje  un mensaje personalizado por cliente, con su link, beneficio y motivos.
--   whatsapp_chat_mensaje   lo que el cliente le escribe al número del local (hoy, Alfajor), la
--                           respuesta automática y las tandas enviadas por Meta.
--
-- Ver docs/CUSTOMERS_AND_GROWTH.md ("Recompra por tandas") y docs/PLANTILLAS_TANDAS.md.

CREATE TABLE IF NOT EXISTS `recompra_tanda` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `canal` ENUM('manual','api') NOT NULL DEFAULT 'manual',
  `cantidad_pedida` INT NOT NULL,
  `presupuesto` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `presupuesto_asignado` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `con_puntos` BOOLEAN NOT NULL DEFAULT FALSE,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_recompra_tanda_rest_id` (`restaurante_id`, `id`),
  KEY `idx_recompra_tanda_rest_fecha` (`restaurante_id`, `created_at`),
  CONSTRAINT `fk_recompra_tanda_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

CREATE TABLE IF NOT EXISTS `recompra_tanda_mensaje` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `tanda_id` INT NOT NULL,
  `cliente_id` INT NOT NULL,
  `orden` INT NOT NULL,
  `cliente_nombre` VARCHAR(255) NOT NULL,
  `telefono` VARCHAR(20) NOT NULL,
  `segmento` VARCHAR(32) NOT NULL,
  `angulo` VARCHAR(32) NOT NULL,
  `texto` TEXT NOT NULL,
  `texto_plantilla` VARCHAR(900) NOT NULL,
  `motivos` JSON NOT NULL,
  `datos` JSON NOT NULL,
  `beneficio_tipo` ENUM('ninguno','porcentaje','monto_fijo','envio_gratis','puntos') NOT NULL DEFAULT 'ninguno',
  `beneficio_valor` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `beneficio_etiqueta` VARCHAR(120) NULL DEFAULT NULL,
  `costo_maximo` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `vigencia_horas` INT NULL DEFAULT NULL,
  `link` VARCHAR(1024) NOT NULL,
  `codigo_descuento_id` INT NULL DEFAULT NULL,
  `enlace_id` INT NULL DEFAULT NULL,
  `imagen_url` VARCHAR(512) NULL DEFAULT NULL,
  `estado` ENUM('pendiente','enviado','descartado') NOT NULL DEFAULT 'pendiente',
  `canal_envio` ENUM('wa_me','api') NULL DEFAULT NULL,
  `enviado_at` TIMESTAMP NULL DEFAULT NULL,
  `proveedor_message_id` VARCHAR(255) NULL DEFAULT NULL,
  `error_envio` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_recompra_tanda_mensaje_cliente` (`tanda_id`, `cliente_id`),
  KEY `idx_recompra_tanda_mensaje_tanda` (`restaurante_id`, `tanda_id`, `orden`),
  KEY `idx_recompra_tanda_mensaje_cliente` (`restaurante_id`, `cliente_id`, `enviado_at`),
  CONSTRAINT `fk_recompra_tanda_mensaje_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_recompra_tanda_mensaje_tanda` FOREIGN KEY (`restaurante_id`, `tanda_id`) REFERENCES `recompra_tanda` (`restaurante_id`, `id`),
  CONSTRAINT `fk_recompra_tanda_mensaje_cliente` FOREIGN KEY (`restaurante_id`, `cliente_id`) REFERENCES `cliente` (`restaurante_id`, `id`)
);

CREATE TABLE IF NOT EXISTS `whatsapp_chat_mensaje` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `telefono` VARCHAR(20) NOT NULL,
  `clave` VARCHAR(10) NOT NULL,
  `direccion` ENUM('entrante','saliente') NOT NULL,
  `origen` ENUM('cliente','bot','tanda') NOT NULL,
  `texto` TEXT NOT NULL,
  `imagen_url` VARCHAR(512) NULL DEFAULT NULL,
  `wa_message_id` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_whatsapp_chat_mensaje_wa` (`restaurante_id`, `wa_message_id`),
  KEY `idx_whatsapp_chat_mensaje_clave` (`restaurante_id`, `clave`, `created_at`),
  KEY `idx_whatsapp_chat_mensaje_fecha` (`restaurante_id`, `created_at`),
  CONSTRAINT `fk_whatsapp_chat_mensaje_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);
