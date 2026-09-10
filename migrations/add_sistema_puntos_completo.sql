-- Migración: Sistema completo de puntos, acumulación, canjes y auditoría

-- 1. Tabla de configuración de puntos por restaurante
CREATE TABLE IF NOT EXISTS `configuracion_puntos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurante_id` INT NOT NULL UNIQUE,
  `activo` BOOLEAN NOT NULL DEFAULT TRUE,
  `modo_acumulacion` ENUM('monto', 'producto', 'ambos') NOT NULL DEFAULT 'monto',
  `pesos_por_punto` INT NOT NULL DEFAULT 100,
  `puntos_primer_pedido` INT NOT NULL DEFAULT 0,
  `puntos_minimos_canje` INT NOT NULL DEFAULT 0,
  `permitir_canje_envio_gratis` BOOLEAN NOT NULL DEFAULT FALSE,
  `puntos_envio_gratis` INT NOT NULL DEFAULT 300,
  `permitir_canje_descuento` BOOLEAN NOT NULL DEFAULT FALSE,
  `descuento_tipo` ENUM('fijo', 'porcentaje') NOT NULL DEFAULT 'fijo',
  `descuento_valor` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `descuento_puntos_costo` INT NOT NULL DEFAULT 0,
  `descuento_monto_minimo` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `descuento_tope` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  `vencimiento_dias` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_configuracion_puntos_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Tabla de auditoría / ledger de puntos
CREATE TABLE IF NOT EXISTS `transaccion_puntos` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurante_id` INT NOT NULL,
  `cliente_id` INT NOT NULL,
  `pedido_unificado_id` INT NULL,
  `tipo` ENUM('suma_compra', 'canje_producto', 'canje_envio', 'canje_descuento', 'bonus_bienvenida', 'ajuste_manual', 'devolucion_cancelacion', 'expiracion') NOT NULL,
  `puntos` INT NOT NULL,
  `saldo_resultante` INT NOT NULL,
  `motivo` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_transaccion_puntos_cliente` (`restaurante_id`, `cliente_id`, `created_at`),
  INDEX `idx_transaccion_puntos_pedido` (`pedido_unificado_id`),
  CONSTRAINT `fk_transaccion_puntos_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_transaccion_puntos_cliente` FOREIGN KEY (`cliente_id`) REFERENCES `cliente` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_transaccion_puntos_pedido` FOREIGN KEY (`pedido_unificado_id`) REFERENCES `pedido_unificado` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Columnas en pedido_unificado (usar procedure o ALTER condicional)
SET @dbname = DATABASE();
SET @tablename = "pedido_unificado";

SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "puntos_ganados"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE pedido_unificado ADD COLUMN puntos_ganados INT NOT NULL DEFAULT 0 AFTER monto_descuento"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "puntos_usados"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE pedido_unificado ADD COLUMN puntos_usados INT NOT NULL DEFAULT 0 AFTER puntos_ganados"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "puntos_canje_tipo"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE pedido_unificado ADD COLUMN puntos_canje_tipo VARCHAR(50) NULL AFTER puntos_usados"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;

SET @preparedStatement = (SELECT IF(
  (
    SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE
      TABLE_SCHEMA = @dbname
      AND TABLE_NAME = @tablename
      AND COLUMN_NAME = "descuento_puntos"
  ) > 0,
  "SELECT 1",
  "ALTER TABLE pedido_unificado ADD COLUMN descuento_puntos DECIMAL(10, 2) NOT NULL DEFAULT 0.00 AFTER puntos_canje_tipo"
));
PREPARE alterIfNotExists FROM @preparedStatement;
EXECUTE alterIfNotExists;
DEALLOCATE PREPARE alterIfNotExists;
