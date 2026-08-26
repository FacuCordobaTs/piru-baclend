-- Idempotencia durable para avisos automáticos de WhatsApp.
--
-- El claim único se crea antes de llamar a Meta. Esto evita que reintentos o dos
-- webhooks concurrentes (por ejemplo, las dos rutas de Mercado Pago) envíen dos
-- veces `pedido_confirmado_v1` para el mismo pedido.
--
-- Migración aditiva y retrocompatible. El backfill toma el historial existente
-- para que un webhook antiguo reintentado después del deploy tampoco reenvíe.

CREATE TABLE IF NOT EXISTS `envio_whatsapp_idempotencia` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `pedido_unificado_id` INT NOT NULL,
  `restaurante_id` INT NOT NULL,
  `tipo` VARCHAR(50) NOT NULL,
  `estado` ENUM('procesando', 'enviado', 'fallido') NOT NULL DEFAULT 'procesando',
  `meta_message_id` VARCHAR(255) NULL,
  `error` VARCHAR(1000) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_envio_whatsapp_pedido_tipo` (`pedido_unificado_id`, `tipo`),
  KEY `idx_envio_whatsapp_restaurante_fecha` (`restaurante_id`, `created_at`),
  CONSTRAINT `fk_envio_whatsapp_pedido` FOREIGN KEY (`pedido_unificado_id`) REFERENCES `pedido_unificado` (`id`),
  CONSTRAINT `fk_envio_whatsapp_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

INSERT IGNORE INTO `envio_whatsapp_idempotencia`
  (`pedido_unificado_id`, `restaurante_id`, `tipo`, `estado`, `created_at`, `updated_at`)
SELECT
  `pedido_unificado_id`,
  `restaurante_id`,
  'pedido_confirmado',
  'enviado',
  MIN(`created_at`),
  MIN(`created_at`)
FROM `mensaje_whatsapp`
WHERE `pedido_unificado_id` IS NOT NULL
  AND `tipo_mensaje` = 'pedido_confirmado'
GROUP BY `pedido_unificado_id`, `restaurante_id`;
