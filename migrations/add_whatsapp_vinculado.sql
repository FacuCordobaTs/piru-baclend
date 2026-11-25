-- WhatsApp del local vinculado como dispositivo (servicio wa-vinculado, whatsmeow).
--
-- ADITIVA. Sólo aplica a locales SIN el módulo avisos_automaticos_whatsapp:
--   whatsapp_vinculado                          estado de la sesión que informa el servicio.
--   pedido_unificado.whatsapp_confirmado_at     cuándo llegó "Pedido #N" al WhatsApp del local.
--   recompra_tanda_mensaje.canal_envio          suma 'vinculado' (envío automático con tope diario).
-- Ver docs/WHATSAPP_AND_PAYMENTS.md ("WhatsApp vinculado").

CREATE TABLE IF NOT EXISTS `whatsapp_vinculado` (
  `restaurante_id` INT NOT NULL,
  `conectado` BOOLEAN NOT NULL DEFAULT FALSE,
  `telefono` VARCHAR(32) NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`restaurante_id`),
  CONSTRAINT `fk_whatsapp_vinculado_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

ALTER TABLE `pedido_unificado` ADD COLUMN `whatsapp_confirmado_at` TIMESTAMP NULL;

ALTER TABLE `recompra_tanda_mensaje`
  MODIFY COLUMN `canal_envio` ENUM('wa_me','api','vinculado') NULL;

ALTER TABLE `recompra_tanda` ADD COLUMN `envio_vinculado_at` TIMESTAMP NULL;
