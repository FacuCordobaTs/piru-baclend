-- Agregar columna `impreso` a las tablas de pedidos para evitar impresiones duplicadas
ALTER TABLE `pedido` ADD COLUMN `impreso` boolean NOT NULL DEFAULT false;
ALTER TABLE `pedido_delivery` ADD COLUMN `impreso` boolean NOT NULL DEFAULT false;
ALTER TABLE `pedido_takeaway` ADD COLUMN `impreso` boolean NOT NULL DEFAULT false;
