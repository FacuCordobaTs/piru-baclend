-- Aplicar después de add_sucursal_solo_pos.sql y ANTES del backend.
-- NULL conserva todos los productos actuales. No altera pedidos ni inventario.
SET @piru_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'producto' AND COLUMN_NAME = 'evento_sucursal_id'),
  'SELECT 1',
  'ALTER TABLE producto ADD COLUMN evento_sucursal_id INT NULL DEFAULT NULL'
);
PREPARE piru_stmt FROM @piru_sql;
EXECUTE piru_stmt;
DEALLOCATE PREPARE piru_stmt;

SET @piru_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'producto' AND INDEX_NAME = 'idx_producto_evento_sucursal'),
  'SELECT 1',
  'ALTER TABLE producto ADD INDEX idx_producto_evento_sucursal (evento_sucursal_id)'
);
PREPARE piru_stmt FROM @piru_sql;
EXECUTE piru_stmt;
DEALLOCATE PREPARE piru_stmt;

-- RESTRICT: borrar una sede nunca debe volver públicos sus productos.
SET @piru_sql = IF(
  EXISTS(SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'producto' AND CONSTRAINT_NAME = 'producto_evento_sucursal_id_sucursal_id_fk'),
  'SELECT 1',
  'ALTER TABLE producto ADD CONSTRAINT producto_evento_sucursal_id_sucursal_id_fk FOREIGN KEY (evento_sucursal_id) REFERENCES sucursal(id) ON DELETE RESTRICT'
);
PREPARE piru_stmt FROM @piru_sql;
EXECUTE piru_stmt;
DEALLOCATE PREPARE piru_stmt;
SET @piru_sql = NULL;
