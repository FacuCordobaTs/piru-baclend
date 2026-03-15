-- Agregar columna order_group_enabled a restaurante para controlar visibilidad del botón "Armar pedido entre amigos"
ALTER TABLE `restaurante` ADD COLUMN `order_group_enabled` boolean NOT NULL DEFAULT true;
