-- Identificador corto por restaurante para el login OTP de la app de mozos.
-- Migracion aditiva y retrocompatible: codigo_acceso/pin_hash se conservan para
-- las versiones instaladas que todavia usan el login anterior.

DELIMITER //
DROP PROCEDURE IF EXISTS `add_numero_mozo_login_otp`//
CREATE PROCEDURE `add_numero_mozo_login_otp`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'usuario_restaurante'
      AND COLUMN_NAME = 'numero_mozo'
  ) THEN
    ALTER TABLE `usuario_restaurante`
      ADD COLUMN `numero_mozo` INT NULL DEFAULT NULL AFTER `codigo_acceso`;
  END IF;

  -- Backfill estable: 1..N por restaurante, dejando al owner sin numero. La
  -- tabla temporal evita leer y actualizar la misma tabla en una subconsulta.
  DROP TEMPORARY TABLE IF EXISTS `tmp_numero_mozo`;
  CREATE TEMPORARY TABLE `tmp_numero_mozo` (
    `id` INT NOT NULL PRIMARY KEY,
    `numero` INT NOT NULL
  );
  INSERT INTO `tmp_numero_mozo` (`id`, `numero`)
  SELECT actual.id,
    1 + (
      SELECT COUNT(*)
      FROM `usuario_restaurante` anterior
      WHERE anterior.`restaurante_id` = actual.`restaurante_id`
        AND anterior.`rol` <> 'owner'
        AND anterior.`id` < actual.`id`
    )
  FROM `usuario_restaurante` actual
  WHERE actual.`rol` <> 'owner';

  UPDATE `usuario_restaurante` u
  JOIN `tmp_numero_mozo` n ON n.id = u.id
  SET u.`numero_mozo` = n.numero
  WHERE u.`numero_mozo` IS NULL;
  DROP TEMPORARY TABLE IF EXISTS `tmp_numero_mozo`;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'usuario_restaurante'
      AND INDEX_NAME = 'uq_usuario_restaurante_numero_mozo'
  ) THEN
    ALTER TABLE `usuario_restaurante`
      ADD UNIQUE KEY `uq_usuario_restaurante_numero_mozo` (`restaurante_id`, `numero_mozo`);
  END IF;
END//
CALL `add_numero_mozo_login_otp`()//
DROP PROCEDURE IF EXISTS `add_numero_mozo_login_otp`//
DELIMITER ;

CREATE TABLE IF NOT EXISTS `verificacion_staff` (
  `id` VARCHAR(36) NOT NULL,
  `usuario_restaurante_id` INT NOT NULL,
  `telefono` VARCHAR(50) NOT NULL,
  `codigo_hash` VARCHAR(255) NOT NULL,
  `intentos` INT NOT NULL DEFAULT 0,
  `verificado` BOOLEAN NOT NULL DEFAULT false,
  `expira_en` TIMESTAMP NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_verificacion_staff_telefono_fecha` (`telefono`, `created_at`),
  KEY `idx_verificacion_staff_usuario_fecha` (`usuario_restaurante_id`, `created_at`),
  CONSTRAINT `fk_verificacion_staff_usuario`
    FOREIGN KEY (`usuario_restaurante_id`) REFERENCES `usuario_restaurante` (`id`) ON DELETE CASCADE
);
