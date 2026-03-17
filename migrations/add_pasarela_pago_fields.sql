-- Migration: Add proveedor de pasarela de pago and Talo credentials
-- Run this SQL against your MySQL database
-- Table: restaurante

ALTER TABLE `restaurante` ADD COLUMN `proveedor_pago` ENUM('cucuru', 'talo', 'mercadopago', 'manual') NOT NULL DEFAULT 'manual';
ALTER TABLE `restaurante` ADD COLUMN `talo_api_key` VARCHAR(255) NULL;
ALTER TABLE `restaurante` ADD COLUMN `talo_user_id` VARCHAR(255) NULL;
