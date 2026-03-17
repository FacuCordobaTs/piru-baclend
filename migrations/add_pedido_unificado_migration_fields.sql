-- Migration: Campos necesarios para migración de pedidos legacy a pedido_unificado
-- Ejecutar ANTES de llamar al endpoint POST /api/migrate-pedidos

-- 1. Agregar pedido_unificado_id a pago (para vincular pagos legacy con el nuevo pedido unificado)
ALTER TABLE `pago` ADD COLUMN `pedido_unificado_id` INT NULL;

-- 2. Agregar ingredientes_excluidos y agregados a item_pedido_unificado (compatibilidad con delivery/takeaway)
ALTER TABLE `item_pedido_unificado` ADD COLUMN `ingredientes_excluidos` JSON NULL;
ALTER TABLE `item_pedido_unificado` ADD COLUMN `agregados` JSON NULL;

-- 3. Ampliar enum estado en pedido_unificado (preparing, ready para compatibilidad)
ALTER TABLE `pedido_unificado` MODIFY COLUMN `estado` ENUM('pending','preparing','ready','received','dispatched','delivered','cancelled','archived') NOT NULL DEFAULT 'pending';

-- 4. Si item_pedido_unificado tiene FK a pedido en lugar de pedido_unificado, corregir manualmente:
--    SHOW CREATE TABLE item_pedido_unificado;  -- ver nombre de la FK
--    ALTER TABLE item_pedido_unificado DROP FOREIGN KEY <nombre_fk>;
--    ALTER TABLE item_pedido_unificado ADD CONSTRAINT fk_item_pedido_unificado_pedido_unificado
--      FOREIGN KEY (pedido_id) REFERENCES pedido_unificado(id) ON DELETE CASCADE;
