-- Permite cobrar una recarga de mensajes junto con base + módulos en una sola
-- preferencia de Mercado Pago. Es aditiva y conserva todos los comprobantes previos.
-- La aplicación debe desplegarse después de esta migración.
-- Reejecutable: las columnas, índice, FK y ampliación del ENUM se verifican antes.

DELIMITER //
DROP PROCEDURE IF EXISTS `add_pack_a_pago_suscripcion`//
CREATE PROCEDURE `add_pack_a_pago_suscripcion`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pago_suscripcion'
      AND COLUMN_NAME = 'monto_recarga'
  ) THEN
    ALTER TABLE `pago_suscripcion`
      ADD COLUMN `monto_recarga` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `monto_modulos`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pago_suscripcion'
      AND COLUMN_NAME = 'recarga_mensajes_id'
  ) THEN
    ALTER TABLE `pago_suscripcion`
      ADD COLUMN `recarga_mensajes_id` INT NULL DEFAULT NULL AFTER `monto_recarga`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pago_suscripcion'
      AND INDEX_NAME = 'idx_pago_suscripcion_recarga'
  ) THEN
    ALTER TABLE `pago_suscripcion`
      ADD KEY `idx_pago_suscripcion_recarga` (`recarga_mensajes_id`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'pago_suscripcion'
      AND CONSTRAINT_NAME = 'fk_pago_suscripcion_recarga'
  ) THEN
    ALTER TABLE `pago_suscripcion`
      ADD CONSTRAINT `fk_pago_suscripcion_recarga`
      FOREIGN KEY (`recarga_mensajes_id`) REFERENCES `recarga_mensajes` (`id`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pago_suscripcion_item'
      AND COLUMN_NAME = 'tipo_item_pago_suscripcion'
      AND COLUMN_TYPE LIKE '%pack_mensajes%'
  ) THEN
    ALTER TABLE `pago_suscripcion_item`
      MODIFY COLUMN `tipo_item_pago_suscripcion`
      ENUM('base','modulo','pack_mensajes') NOT NULL;
  END IF;
END//
CALL `add_pack_a_pago_suscripcion`()//
DROP PROCEDURE `add_pack_a_pago_suscripcion`//
DELIMITER ;
