-- Migration: tabla sucursal + sucursal_id en pedido_unificado y zona_delivery
-- Ejecutar en MySQL (prod). Columnas nuevas NULL para filas existentes.
-- Si algo ya existe, omitir la sentencia que falle.

CREATE TABLE IF NOT EXISTS `sucursal` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `direccion` VARCHAR(255) DEFAULT NULL,
  `whatsapp_enabled` BOOLEAN NOT NULL DEFAULT false,
  `whatsapp_number` VARCHAR(50) DEFAULT NULL,
  `rapiboy_token` VARCHAR(512) DEFAULT NULL,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `sucursal_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

ALTER TABLE `pedido_unificado`
  ADD COLUMN `sucursal_id` INT NULL,
  ADD CONSTRAINT `pedido_unificado_sucursal_id_fk` FOREIGN KEY (`sucursal_id`) REFERENCES `sucursal` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `zona_delivery`
  ADD COLUMN `sucursal_id` INT NULL,
  ADD CONSTRAINT `zona_delivery_sucursal_id_fk` FOREIGN KEY (`sucursal_id`) REFERENCES `sucursal` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
