-- Zonas especiales (countries / barrios cerrados) con ventana horaria de entrega.
--
-- La capacidad vive detrás del módulo `avisos_automaticos_whatsapp`: las rutas
-- de configuración y el endpoint público que las ofrece usan ese entitlement.
-- `permitir_pre_pedidos_zonas_especiales` habilita armar el pedido fuera de la
-- ventana para entregarlo en la próxima (mismo criterio que los pedidos
-- programados cuando el local está cerrado).
--
-- PRECONDICIÓN: backup lógico verificado. DDL en MySQL se confirma implícito.
-- Reintentable: la tabla usa IF NOT EXISTS; los ADD COLUMN se ejecutan una vez.

CREATE TABLE IF NOT EXISTS `zona_especial` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `precio` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `hora_inicio` VARCHAR(5) NOT NULL,
  `hora_fin` VARCHAR(5) NOT NULL,
  `activa` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_zona_especial_restaurante_activa` (`restaurante_id`, `activa`, `nombre`),
  CONSTRAINT `fk_zona_especial_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE
);

ALTER TABLE `restaurante`
  ADD COLUMN `permitir_pre_pedidos_zonas_especiales` BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE `pedido_unificado`
  ADD COLUMN `zona_especial_id` INT NULL DEFAULT NULL,
  ADD KEY `idx_pedido_unificado_zona_especial` (`zona_especial_id`),
  ADD CONSTRAINT `fk_pedido_unificado_zona_especial`
    FOREIGN KEY (`zona_especial_id`) REFERENCES `zona_especial` (`id`) ON DELETE SET NULL;

ALTER TABLE `mensaje_whatsapp`
  MODIFY COLUMN `tipo_mensaje` ENUM('pedido_confirmado','pedido_despachado','zona_especial_llegada') DEFAULT NULL;
