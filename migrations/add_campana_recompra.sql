-- Migration: Motor de Recompra · 4.4 — Campañas de recompra + grupo de control.
-- Cada "encendido del motor" es una campaña (envío batch): se detecta la cohorte recuperable
-- (en_riesgo/dormido/perdido que se pueden contactar), se aparta al azar un 10% de cada segmento
-- como GRUPO DE CONTROL (no se contacta) y al resto se le envía el toque de recupero.
-- Guardar quién quedó en control es lo que hace posible la atribución honesta (contactados vs control).
-- Es imposible de reconstruir después → va desde el día 1.
-- Aditivo y retrocompatible: tablas nuevas, nada existente se toca.

CREATE TABLE IF NOT EXISTS `campana_recompra` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `total_detectados` INT NOT NULL DEFAULT 0,
  `total_contactados` INT NOT NULL DEFAULT 0,
  `total_control` INT NOT NULL DEFAULT 0,
  `total_fallidos` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_campana_restaurante` (`restaurante_id`, `created_at`),
  CONSTRAINT `fk_campana_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

CREATE TABLE IF NOT EXISTS `campana_recompra_cliente` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `campana_id` INT NOT NULL,
  `restaurante_id` INT NOT NULL,
  `cliente_id` INT NOT NULL,
  -- 'contactado' | 'control'
  `rol` VARCHAR(20) NOT NULL,
  `segmento` VARCHAR(20) NULL,
  `nivel` INT NULL,
  `codigo_descuento` VARCHAR(50) NULL,
  `envio_ok` TINYINT(1) NOT NULL DEFAULT 0,
  `total_gastado_snapshot` DECIMAL(12,2) NULL DEFAULT '0.00',
  `ultimo_pedido_at_snapshot` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_campana_cliente_campana` (`campana_id`),
  INDEX `idx_campana_cliente_restaurante` (`restaurante_id`, `cliente_id`),
  CONSTRAINT `fk_campana_cliente_campana` FOREIGN KEY (`campana_id`) REFERENCES `campana_recompra` (`id`),
  CONSTRAINT `fk_campana_cliente_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_campana_cliente_cliente` FOREIGN KEY (`cliente_id`) REFERENCES `cliente` (`id`)
);
