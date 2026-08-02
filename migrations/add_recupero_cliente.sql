-- Migration: Motor de Recompra · playbook de recupero de dormidos (tarea 4.2).
-- Crea recupero_cliente: un registro por cada "toque" de recupero enviado a un cliente.
-- Sostiene la escalera de incentivos (nivel 1 sin descuento → 2 con 10% → 3 con 20% + vencimiento)
-- y es la base de la futura atribución (4.4). Aditivo y retrocompatible: tabla nueva, nada existente
-- se toca; los admins viejos la ignoran.

CREATE TABLE IF NOT EXISTS `recupero_cliente` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `cliente_id` INT NOT NULL,
  `telefono` VARCHAR(50) NOT NULL,
  `nivel` INT NOT NULL,
  `descuento_porcentaje` INT NOT NULL DEFAULT 0,
  `codigo_descuento` VARCHAR(50) NULL,
  `segmento` VARCHAR(20) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_recupero_restaurante_cliente` (`restaurante_id`, `cliente_id`),
  CONSTRAINT `fk_recupero_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_recupero_cliente` FOREIGN KEY (`cliente_id`) REFERENCES `cliente` (`id`)
);
