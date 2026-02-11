-- Migration: Add 'archived' state to all order tables
-- Run this SQL against your MySQL database to add the 'archived' enum value

ALTER TABLE `pedido` 
  MODIFY COLUMN `estado` ENUM('pending', 'preparing', 'delivered', 'served', 'closed', 'archived') DEFAULT 'pending';

ALTER TABLE `pedido_delivery` 
  MODIFY COLUMN `estado` ENUM('pending', 'preparing', 'ready', 'delivered', 'cancelled', 'archived') DEFAULT 'pending';

ALTER TABLE `pedido_takeaway` 
  MODIFY COLUMN `estado` ENUM('pending', 'preparing', 'ready', 'delivered', 'cancelled', 'archived') DEFAULT 'pending';
