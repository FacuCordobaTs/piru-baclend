-- Migration: Campos necesarios para migración de pedidos legacy a pedido_unificado
-- Ejecutar ANTES de llamar al endpoint POST /api/migrate-pedidos

-- 1. Agregar pedido_unificado_id a pago (para vincular pagos legacy con el nuevo pedido unificado)
ALTER TABLE `pago` ADD COLUMN `pedido_unificado_id` INT NULL;

-- 2. Si item_pedido_unificado tiene FK a pedido en lugar de pedido_unificado, corregir manualmente:
--    SHOW CREATE TABLE item_pedido_unificado;  -- ver nombre de la FK
--    ALTER TABLE item_pedido_unificado DROP FOREIGN KEY <nombre_fk>;
--    ALTER TABLE item_pedido_unificado ADD CONSTRAINT fk_item_pedido_unificado_pedido_unificado
--      FOREIGN KEY (pedido_id) REFERENCES pedido_unificado(id) ON DELETE CASCADE;
