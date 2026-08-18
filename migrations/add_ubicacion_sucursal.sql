-- Ubicación geocodificada por sucursal.
-- Cambio aditivo: las sucursales existentes conservan su dirección de texto y
-- pueden completar coordenadas/ciudad desde Ajustes sin afectar pedidos viejos.

ALTER TABLE `sucursal`
  MODIFY COLUMN `direccion` VARCHAR(512) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `direccion_lat` DECIMAL(10, 7) NULL DEFAULT NULL AFTER `direccion`,
  ADD COLUMN IF NOT EXISTS `direccion_lng` DECIMAL(10, 7) NULL DEFAULT NULL AFTER `direccion_lat`,
  ADD COLUMN IF NOT EXISTS `direccion_ciudad` VARCHAR(255) NULL DEFAULT NULL AFTER `direccion_lng`;
