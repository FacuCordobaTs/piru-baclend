-- Migration: Add sala table and salaId to pedido/notificacion
-- Run this SQL against your MySQL database
-- Si la tabla o columnas ya existen, omitir las líneas que fallen

CREATE TABLE IF NOT EXISTS `sala` (
  `id` int NOT NULL AUTO_INCREMENT,
  `nombre` varchar(255) NOT NULL,
  `restaurante_id` int DEFAULT NULL,
  `token` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `token` (`token`),
  KEY `restaurante_id` (`restaurante_id`),
  CONSTRAINT `sala_restaurante_id_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE `pedido` ADD COLUMN `sala_id` int DEFAULT NULL;
ALTER TABLE `pedido` ADD CONSTRAINT `pedido_sala_id_fk` FOREIGN KEY (`sala_id`) REFERENCES `sala` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `notificacion` ADD COLUMN `sala_id` int DEFAULT NULL;
ALTER TABLE `notificacion` ADD CONSTRAINT `notificacion_sala_id_fk` FOREIGN KEY (`sala_id`) REFERENCES `sala` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
