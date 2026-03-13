-- Migration: Add Rapiboy integration fields for delivery logistics
-- Run this SQL against your MySQL database on the VPS
-- Tables: restaurante (config), pedido_delivery (tracking)

-- 1. Token de API Rapiboy en configuración del restaurante
ALTER TABLE `restaurante` ADD COLUMN `rapiboy_token` VARCHAR(512) NULL;

-- 2. Campos de tracking Rapiboy en pedidos de delivery
ALTER TABLE `pedido_delivery` ADD COLUMN `rapiboy_tracking_url` VARCHAR(512) NULL;
ALTER TABLE `pedido_delivery` ADD COLUMN `rapiboy_trip_id` VARCHAR(100) NULL;
