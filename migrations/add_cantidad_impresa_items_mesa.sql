-- T43 — impresión incremental persistente de comandas.
--
-- Despliegue seguro: aplicar antes del backend que lee `cantidad_impresa`.
-- Es aditiva e idempotente. El backfill considera ya impresas las unidades de
-- pedidos cuyo claim histórico (`pedido_unificado.impreso`) estaba confirmado,
-- evitando que una actualización reimprima todo el historial del restaurante.

DELIMITER $$
CREATE PROCEDURE add_cantidad_impresa_item_pedido_unificado()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'item_pedido_unificado'
      AND column_name = 'cantidad_impresa'
  ) THEN
    ALTER TABLE item_pedido_unificado
      ADD COLUMN cantidad_impresa INT NOT NULL DEFAULT 0 AFTER cantidad;

  END IF;

  UPDATE item_pedido_unificado item
  INNER JOIN pedido_unificado pedido ON pedido.id = item.pedido_id
  SET item.cantidad_impresa = item.cantidad
  WHERE pedido.impreso = 1
    AND item.cantidad_impresa = 0;
END$$
DELIMITER ;

CALL add_cantidad_impresa_item_pedido_unificado();
DROP PROCEDURE add_cantidad_impresa_item_pedido_unificado;
