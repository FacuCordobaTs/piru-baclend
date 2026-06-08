-- Agrega columna whatsapp_phone_id a la tabla restaurante
ALTER TABLE `restaurante`
  ADD COLUMN `whatsapp_phone_id` varchar(50) DEFAULT NULL;

-- Crea la tabla de conversaciones WhatsApp para el agente IA
CREATE TABLE `whatsapp_conversacion` (
  `id` int NOT NULL AUTO_INCREMENT,
  `restaurante_id` int NOT NULL,
  `telefono` varchar(50) NOT NULL,
  `nombre_cliente` varchar(255) DEFAULT NULL,
  `mensajes` json NOT NULL,
  `pedido_draft` json DEFAULT NULL,
  `estado_conversacion` enum('conversando','esperando_pago','pagado','finalizado') NOT NULL DEFAULT 'conversando',
  `pedido_unificado_id` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_wc_restaurante` (`restaurante_id`),
  KEY `fk_wc_pedido_unificado` (`pedido_unificado_id`),
  CONSTRAINT `fk_wc_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_wc_pedido_unificado` FOREIGN KEY (`pedido_unificado_id`) REFERENCES `pedido_unificado` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
