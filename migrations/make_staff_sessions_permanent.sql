-- Las sesiones de la PWA de mozos permanecen activas hasta una revocación
-- explícita (baja del usuario o cambio de PIN). Esta migración también extiende
-- las sesiones activas existentes, para no requerir un nuevo OTP al desplegar.
-- Requiere que `add_staff_restaurante.sql` ya se haya ejecutado.

DELIMITER //
DROP PROCEDURE IF EXISTS `make_staff_sessions_permanent`//
CREATE PROCEDURE `make_staff_sessions_permanent`()
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sesion_staff'
      AND COLUMN_NAME = 'expira_at'
      AND IS_NULLABLE = 'NO'
  ) THEN
    ALTER TABLE `sesion_staff`
      MODIFY COLUMN `expira_at` TIMESTAMP NULL DEFAULT NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'sesion_staff'
  ) THEN
    UPDATE `sesion_staff`
    SET `expira_at` = NULL
    WHERE `revocada_at` IS NULL;
  END IF;
END//
DELIMITER ;

CALL `make_staff_sessions_permanent`();
DROP PROCEDURE `make_staff_sessions_permanent`;
