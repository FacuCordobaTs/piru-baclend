-- Migration: Add 'pagado' boolean column to all order tables
-- This allows marking orders as paid regardless of split payment or item tracking settings
-- Run this SQL against your MySQL database

ALTER TABLE `pedido` 
  ADD COLUMN `pagado` BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE `pedido_delivery` 
  ADD COLUMN `pagado` BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE `pedido_takeaway` 
  ADD COLUMN `pagado` BOOLEAN NOT NULL DEFAULT FALSE;
