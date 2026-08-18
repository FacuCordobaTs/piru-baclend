-- Variantes dobles: mantiene intacto el contrato de la variante primaria y agrega
-- una segunda elección opcional con precio adicional.
ALTER TABLE variante_producto
  ADD COLUMN grupo INT NOT NULL DEFAULT 1 AFTER precio;

ALTER TABLE item_pedido_unificado
  ADD COLUMN variante_secundaria_id INT NULL AFTER variante_nombre,
  ADD COLUMN variante_secundaria_nombre VARCHAR(255) NULL AFTER variante_secundaria_id;

CREATE INDEX idx_variante_producto_producto_grupo
  ON variante_producto (producto_id, grupo);
