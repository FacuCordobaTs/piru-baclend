-- Instancia 3. Ejecutar SEPARADAMENTE, después del job de consolidación y sus
-- postchecks. Detiene el despliegue si todavía existen duplicados o mal backfill.
DROP PROCEDURE IF EXISTS habilitar_unicidad_cliente_pos;
DELIMITER $$
CREATE PROCEDURE habilitar_unicidad_cliente_pos()
BEGIN
  IF EXISTS (SELECT 1 FROM cliente WHERE telefono_normalizado IS NOT NULL
      GROUP BY restaurante_id, telefono_normalizado HAVING COUNT(*) > 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Quedan clientes duplicados: ejecutar auditoria y consolidacion POS';
  END IF;
  IF EXISTS (SELECT 1 FROM cliente WHERE NOT (telefono_normalizado <=> CASE
      WHEN CHAR_LENGTH(REGEXP_REPLACE(telefono, '[^0-9]', '')) BETWEEN 8 AND 20
      THEN REGEXP_REPLACE(telefono, '[^0-9]', '') ELSE NULL END)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Backfill telefonico incompleto';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='cliente' AND index_name='uq_cliente_restaurante_telefono') THEN
    ALTER TABLE cliente ADD UNIQUE INDEX uq_cliente_restaurante_telefono (restaurante_id, telefono_normalizado);
  END IF;
END$$
DELIMITER ;
CALL habilitar_unicidad_cliente_pos();
DROP PROCEDURE habilitar_unicidad_cliente_pos;
