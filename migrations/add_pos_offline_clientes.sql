-- Instancia 1. MySQL 8+. Backup verificado antes de ejecutar; DDL hace commit.
-- Reintentable. NO habilita todavía la unicidad telefónica.
DROP PROCEDURE IF EXISTS migrar_pos_offline_clientes;
DELIMITER $$
CREATE PROCEDURE migrar_pos_offline_clientes()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='cliente' AND column_name='telefono_normalizado') THEN
    ALTER TABLE cliente ADD COLUMN telefono_normalizado VARCHAR(20) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='cliente' AND column_name='updated_at') THEN
    ALTER TABLE cliente ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='cliente' AND index_name='idx_cliente_restaurante_telefono') THEN
    ALTER TABLE cliente ADD INDEX idx_cliente_restaurante_telefono (restaurante_id, telefono_normalizado);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pedido_unificado' AND column_name='client_request_id') THEN
    ALTER TABLE pedido_unificado ADD COLUMN client_request_id CHAR(36) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='pedido_unificado' AND index_name='uq_pedido_restaurante_request') THEN
    ALTER TABLE pedido_unificado ADD UNIQUE INDEX uq_pedido_restaurante_request (restaurante_id, client_request_id);
  END IF;
  UPDATE cliente SET telefono_normalizado = CASE
    WHEN CHAR_LENGTH(REGEXP_REPLACE(telefono, '[^0-9]', '')) BETWEEN 8 AND 20
    THEN REGEXP_REPLACE(telefono, '[^0-9]', '') ELSE NULL END
  WHERE NOT (telefono_normalizado <=> CASE
    WHEN CHAR_LENGTH(REGEXP_REPLACE(telefono, '[^0-9]', '')) BETWEEN 8 AND 20
    THEN REGEXP_REPLACE(telefono, '[^0-9]', '') ELSE NULL END);
END$$
DELIMITER ;
CALL migrar_pos_offline_clientes();
DROP PROCEDURE migrar_pos_offline_clientes;

-- Checkpoint y auditoría operativa. No contienen teléfonos ni snapshots de pedidos.
CREATE TABLE IF NOT EXISTS pos_mantenimiento (
  tarea VARCHAR(80) PRIMARY KEY, ultimo_id BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL DEFAULT 0, errores BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pos_cliente_consolidacion (
  duplicado_id INT PRIMARY KEY, canonico_id INT NOT NULL, restaurante_id INT NOT NULL,
  referencias JSON NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
