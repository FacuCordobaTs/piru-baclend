-- Migration: Add post_confirmacion field to item_pedido table
-- This field tracks items added after the order was confirmed

ALTER TABLE `item_pedido`
ADD COLUMN `post_confirmacion` BOOLEAN NOT NULL DEFAULT FALSE
AFTER `ingredientes_excluidos`;

-- Add index for faster queries when filtering by post_confirmacion
CREATE INDEX `idx_item_pedido_post_confirmacion` ON `item_pedido` (`post_confirmacion`);

