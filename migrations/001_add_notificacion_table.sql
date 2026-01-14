-- Migration: Add notificacion table for admin notifications
-- Run this migration on your MySQL database

CREATE TABLE IF NOT EXISTS `notificacion` (
    `id` VARCHAR(50) NOT NULL PRIMARY KEY,
    `restaurante_id` INT NOT NULL,
    `tipo` ENUM('NUEVO_PEDIDO', 'PEDIDO_CONFIRMADO', 'PEDIDO_CERRADO', 'LLAMADA_MOZO', 'PAGO_RECIBIDO', 'PRODUCTO_AGREGADO') NOT NULL,
    `mesa_id` INT NULL,
    `mesa_nombre` VARCHAR(255) NULL,
    `pedido_id` INT NULL,
    `mensaje` VARCHAR(500) NOT NULL,
    `detalles` VARCHAR(500) NULL,
    `timestamp` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `leida` BOOLEAN NOT NULL DEFAULT FALSE,
    
    CONSTRAINT `fk_notificacion_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante`(`id`) ON DELETE CASCADE,
    CONSTRAINT `fk_notificacion_mesa` FOREIGN KEY (`mesa_id`) REFERENCES `mesa`(`id`) ON DELETE SET NULL,
    
    INDEX `idx_notificacion_restaurante` (`restaurante_id`),
    INDEX `idx_notificacion_timestamp` (`timestamp`),
    INDEX `idx_notificacion_leida` (`leida`)
);

