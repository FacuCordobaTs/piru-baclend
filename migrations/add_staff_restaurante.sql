-- T37 — identidad y sesiones de staff para la PWA de mozos.
--
-- Migración aditiva. Requiere backup lógico verificado antes de ejecutar: MySQL
-- confirma DDL implícitamente. La recuperación es restaurar ese backup. No toca
-- `mesa`, `sala` ni credenciales de `restaurante`.

CREATE TABLE IF NOT EXISTS `usuario_restaurante` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `sucursal_id` INT NULL DEFAULT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `rol` ENUM('owner','admin','mozo') NOT NULL,
  `pin_hash` VARCHAR(255) NULL DEFAULT NULL,
  `codigo_acceso` VARCHAR(64) NULL DEFAULT NULL,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `intentos_pin_fallidos` INT NOT NULL DEFAULT 0,
  `bloqueado_hasta` TIMESTAMP NULL DEFAULT NULL,
  `ultimo_acceso_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_usuario_restaurante_codigo_acceso` (`codigo_acceso`),
  KEY `idx_usuario_restaurante_restaurante_activo` (`restaurante_id`, `activo`),
  KEY `idx_usuario_restaurante_sucursal_activo` (`sucursal_id`, `activo`),
  CONSTRAINT `fk_usuario_restaurante_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_usuario_restaurante_sucursal`
    FOREIGN KEY (`sucursal_id`) REFERENCES `sucursal` (`id`) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS `sesion_staff` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `usuario_restaurante_id` INT NOT NULL,
  `token_hash` VARCHAR(64) NOT NULL,
  `expira_at` TIMESTAMP NOT NULL,
  `revocada_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sesion_staff_token_hash` (`token_hash`),
  KEY `idx_sesion_staff_usuario_activa` (`usuario_restaurante_id`, `revocada_at`, `expira_at`),
  CONSTRAINT `fk_sesion_staff_usuario`
    FOREIGN KEY (`usuario_restaurante_id`) REFERENCES `usuario_restaurante` (`id`) ON DELETE CASCADE
);

-- Backfill explícito del owner para que la auditoría de operaciones admin no
-- tenga que depender de una contraseña reutilizada. Es reintentable porque el
-- NOT EXISTS evita duplicar el owner de cada restaurante.
INSERT INTO `usuario_restaurante` (`restaurante_id`, `nombre`, `rol`, `activo`)
SELECT r.`id`, COALESCE(NULLIF(TRIM(r.`nombre`), ''), CONCAT('Owner #', r.`id`)), 'owner', true
FROM `restaurante` r
WHERE NOT EXISTS (
  SELECT 1 FROM `usuario_restaurante` u
  WHERE u.`restaurante_id` = r.`id` AND u.`rol` = 'owner'
);

DELIMITER //
DROP PROCEDURE IF EXISTS `t37_extender_pedido_unificado`//
CREATE PROCEDURE `t37_extender_pedido_unificado`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado'
      AND COLUMN_NAME = 'creado_por_usuario_id'
  ) THEN
    ALTER TABLE `pedido_unificado`
      ADD COLUMN `creado_por_usuario_id` INT NULL DEFAULT NULL AFTER `consumo_en_local`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado'
      AND INDEX_NAME = 'idx_pedido_unificado_creado_por_usuario'
  ) THEN
    ALTER TABLE `pedido_unificado`
      ADD KEY `idx_pedido_unificado_creado_por_usuario` (`creado_por_usuario_id`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado'
      AND CONSTRAINT_NAME = 'fk_pedido_unificado_creado_por_usuario'
  ) THEN
    ALTER TABLE `pedido_unificado`
      ADD CONSTRAINT `fk_pedido_unificado_creado_por_usuario`
      FOREIGN KEY (`creado_por_usuario_id`) REFERENCES `usuario_restaurante` (`id`) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado_auditoria'
      AND COLUMN_NAME = 'usuario_restaurante_id'
  ) THEN
    ALTER TABLE `pedido_unificado_auditoria`
      ADD COLUMN `usuario_restaurante_id` INT NULL DEFAULT NULL AFTER `item_pedido_id`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado_auditoria'
      AND INDEX_NAME = 'idx_pedido_unificado_auditoria_usuario_fecha'
  ) THEN
    ALTER TABLE `pedido_unificado_auditoria`
      ADD KEY `idx_pedido_unificado_auditoria_usuario_fecha` (`usuario_restaurante_id`, `created_at`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado_auditoria'
      AND CONSTRAINT_NAME = 'fk_pedido_unificado_auditoria_usuario'
  ) THEN
    ALTER TABLE `pedido_unificado_auditoria`
      ADD CONSTRAINT `fk_pedido_unificado_auditoria_usuario`
      FOREIGN KEY (`usuario_restaurante_id`) REFERENCES `usuario_restaurante` (`id`) ON DELETE SET NULL;
  END IF;
END//
DELIMITER ;

CALL `t37_extender_pedido_unificado`();
DROP PROCEDURE `t37_extender_pedido_unificado`;
