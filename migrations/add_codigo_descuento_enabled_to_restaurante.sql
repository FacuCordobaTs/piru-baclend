-- Migration: habilitar toggle global de codigos de descuento por restaurante
ALTER TABLE `restaurante`
ADD COLUMN `codigo_descuento_enabled` BOOLEAN NOT NULL DEFAULT TRUE;
