-- Códigos de descuento con cupos limitados
CREATE TABLE IF NOT EXISTS `codigo_descuento` (
    `id` INT AUTO_INCREMENT PRIMARY KEY,
    `restaurante_id` INT NOT NULL,
    `codigo` VARCHAR(50) NOT NULL,
    `tipo` ENUM('porcentaje', 'monto_fijo') NOT NULL,
    `valor` DECIMAL(10, 2) NOT NULL,
    `limite_usos` INT NULL,
    `usos_actuales` INT NOT NULL DEFAULT 0,
    `monto_minimo` DECIMAL(10, 2) DEFAULT '0.00',
    `fecha_inicio` TIMESTAMP NULL,
    `fecha_fin` TIMESTAMP NULL,
    `activo` BOOLEAN NOT NULL DEFAULT true,
    `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`),
    UNIQUE INDEX `uq_restaurante_codigo` (`restaurante_id`, `codigo`)
);

-- Campos de descuento en pedido_delivery
ALTER TABLE `pedido_delivery` ADD COLUMN `codigo_descuento_id` INT NULL;
ALTER TABLE `pedido_delivery` ADD COLUMN `monto_descuento` DECIMAL(10, 2) DEFAULT '0.00';
ALTER TABLE `pedido_delivery` ADD CONSTRAINT `fk_pedido_delivery_codigo` FOREIGN KEY (`codigo_descuento_id`) REFERENCES `codigo_descuento`(`id`);

-- Campos de descuento en pedido_takeaway
ALTER TABLE `pedido_takeaway` ADD COLUMN `codigo_descuento_id` INT NULL;
ALTER TABLE `pedido_takeaway` ADD COLUMN `monto_descuento` DECIMAL(10, 2) DEFAULT '0.00';
ALTER TABLE `pedido_takeaway` ADD CONSTRAINT `fk_pedido_takeaway_codigo` FOREIGN KEY (`codigo_descuento_id`) REFERENCES `codigo_descuento`(`id`);
