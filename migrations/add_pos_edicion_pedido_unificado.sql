-- T27 — edición transaccional de comandas POS.
--
-- Esta migración es aditiva y compatible con admins instalados: updated_at y version
-- son campos nuevos con defaults. MySQL hace commit implícito de DDL; ejecutar sólo
-- después de un backup lógico verificado. Las guardas information_schema permiten
-- reintentarlo en servidores MySQL que no soportan ADD COLUMN IF NOT EXISTS.

DELIMITER $$
CREATE PROCEDURE add_pos_edicion_pedido_unificado_columns()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'pedido_unificado' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE pedido_unificado
      ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'pedido_unificado' AND column_name = 'version'
  ) THEN
    ALTER TABLE pedido_unificado
      ADD COLUMN version INT NOT NULL DEFAULT 1;
  END IF;
END$$
DELIMITER ;

CALL add_pos_edicion_pedido_unificado_columns();
DROP PROCEDURE add_pos_edicion_pedido_unificado_columns;

CREATE TABLE IF NOT EXISTS pedido_unificado_auditoria (
  id INT NOT NULL AUTO_INCREMENT,
  pedido_id INT NOT NULL,
  restaurante_id INT NOT NULL,
  item_pedido_id INT NULL,
  operacion ENUM('agregar_item','editar_item','eliminar_item','editar_datos_pos') NOT NULL,
  actor_tipo VARCHAR(40) NOT NULL DEFAULT 'restaurante_admin',
  antes JSON NULL,
  despues JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pedido_unificado_auditoria_pedido_fecha (pedido_id, created_at),
  KEY idx_pedido_unificado_auditoria_restaurante_fecha (restaurante_id, created_at),
  CONSTRAINT fk_pedido_unificado_auditoria_pedido
    FOREIGN KEY (pedido_id) REFERENCES pedido_unificado(id) ON DELETE CASCADE,
  CONSTRAINT fk_pedido_unificado_auditoria_restaurante
    FOREIGN KEY (restaurante_id) REFERENCES restaurante(id),
  CONSTRAINT fk_pedido_unificado_auditoria_item
    FOREIGN KEY (item_pedido_id) REFERENCES item_pedido_unificado(id) ON DELETE SET NULL
);
