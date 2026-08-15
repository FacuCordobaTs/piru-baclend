-- T32 — modelo de mesas operativas sobre pedido_unificado.
--
-- Esta migración es ADITIVA: no toca `mesa`, `sala`, `pedido` ni sus rutas.
-- `pedido_unificado.tipo` conserva delivery/takeaway; consumo_en_local permite
-- al frontend nuevo derivar la modalidad local sin romper admins instalados.
--
-- PRECONDICIÓN: hacer y verificar un backup lógico antes de ejecutar. MySQL
-- confirma DDL implícitamente, por lo que la recuperación es restaurar ese backup.
-- Las guardas de information_schema hacen reintentable la extensión de la tabla
-- existente en MySQL que no soporta ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS `mesa_local` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `sucursal_id` INT NULL DEFAULT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `posicion_x` INT NOT NULL DEFAULT 0,
  `posicion_y` INT NOT NULL DEFAULT 0,
  `ancho` INT NOT NULL DEFAULT 1,
  `alto` INT NOT NULL DEFAULT 1,
  `capacidad` INT NOT NULL DEFAULT 1,
  `estado_manual` VARCHAR(50) NULL DEFAULT NULL,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `orden` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_mesa_local_restaurante_activo_orden` (`restaurante_id`, `activo`, `orden`),
  KEY `idx_mesa_local_sucursal_activo` (`sucursal_id`, `activo`),
  CONSTRAINT `fk_mesa_local_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_mesa_local_sucursal`
    FOREIGN KEY (`sucursal_id`) REFERENCES `sucursal` (`id`) ON DELETE SET NULL
);

DELIMITER //
DROP PROCEDURE IF EXISTS `t32_extender_pedido_unificado`//
CREATE PROCEDURE `t32_extender_pedido_unificado`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado'
      AND COLUMN_NAME = 'mesa_local_id'
  ) THEN
    ALTER TABLE `pedido_unificado`
      ADD COLUMN `mesa_local_id` INT NULL DEFAULT NULL AFTER `sucursal_id`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado'
      AND COLUMN_NAME = 'consumo_en_local'
  ) THEN
    ALTER TABLE `pedido_unificado`
      ADD COLUMN `consumo_en_local` BOOLEAN NOT NULL DEFAULT false AFTER `mesa_local_id`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado'
      AND INDEX_NAME = 'idx_pedido_unificado_mesa_local_estado'
  ) THEN
    ALTER TABLE `pedido_unificado`
      ADD KEY `idx_pedido_unificado_mesa_local_estado` (`mesa_local_id`, `estado`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado'
      AND CONSTRAINT_NAME = 'fk_pedido_unificado_mesa_local'
  ) THEN
    ALTER TABLE `pedido_unificado`
      ADD CONSTRAINT `fk_pedido_unificado_mesa_local`
      FOREIGN KEY (`mesa_local_id`) REFERENCES `mesa_local` (`id`) ON DELETE SET NULL;
  END IF;
END//
DELIMITER ;

CALL `t32_extender_pedido_unificado`();
DROP PROCEDURE `t32_extender_pedido_unificado`;
