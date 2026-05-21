-- Tabla de repartidores por restaurante
CREATE TABLE IF NOT EXISTS `repartidor` (
  `id` int NOT NULL AUTO_INCREMENT,
  `restaurante_id` int NOT NULL,
  `nombre` varchar(255) NOT NULL,
  `estado` enum('activo','inactivo') NOT NULL DEFAULT 'activo',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `repartidor_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

-- Columnas nuevas en pedido_unificado
ALTER TABLE `pedido_unificado`
  ADD COLUMN `repartidor_id` int NULL,
  ADD COLUMN `delivery_fee` decimal(10,2) NULL,
  ADD CONSTRAINT `pedido_unificado_repartidor_id_fk` FOREIGN KEY (`repartidor_id`) REFERENCES `repartidor` (`id`);
