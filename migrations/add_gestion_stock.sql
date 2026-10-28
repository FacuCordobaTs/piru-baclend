-- Control de stock: insumos, recetas por producto/variante, compras y ledger.
--
-- El módulo `gestion_stock` ya existía en el catálogo como "próximamente". Esta
-- migración lo vuelve activable y agrega las tablas que usan sus endpoints.
-- No toca `producto.stock` (esa columna pertenece a la tienda de ropa de
-- Alfajor) ni el agregado de pedidos: el consumo se concilia desde
-- `item_pedido_unificado` con `stock_movimiento` como ledger idempotente.
--
-- PRECONDICIÓN: backup lógico verificado. DDL en MySQL se confirma implícito.

CREATE TABLE IF NOT EXISTS `insumo` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `unidad` ENUM('unidad', 'gramo', 'kilogramo', 'mililitro', 'litro') NOT NULL DEFAULT 'unidad',
  `stock_actual` DECIMAL(14,3) NOT NULL DEFAULT 0.000,
  `stock_minimo` DECIMAL(14,3) NULL DEFAULT NULL,
  `stock_maximo` DECIMAL(14,3) NOT NULL DEFAULT 0.000,
  `costo_ultimo` DECIMAL(12,2) NULL DEFAULT NULL,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_insumo_restaurante_activo` (`restaurante_id`, `activo`, `nombre`),
  CONSTRAINT `fk_insumo_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `producto_consumo` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `producto_id` INT NOT NULL,
  `insumo_id` INT NOT NULL,
  `variante_id` INT NULL DEFAULT NULL,
  `cantidad` DECIMAL(14,3) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_producto_consumo_producto` (`producto_id`),
  KEY `idx_producto_consumo_insumo` (`insumo_id`),
  CONSTRAINT `fk_producto_consumo_producto`
    FOREIGN KEY (`producto_id`) REFERENCES `producto` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_producto_consumo_insumo`
    FOREIGN KEY (`insumo_id`) REFERENCES `insumo` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_producto_consumo_variante`
    FOREIGN KEY (`variante_id`) REFERENCES `variante_producto` (`id`) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `stock_gasto` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `descripcion` VARCHAR(255) NOT NULL,
  `proveedor` VARCHAR(255) NULL DEFAULT NULL,
  `fecha` DATETIME NOT NULL,
  `total` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `creado_por_usuario_id` INT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_stock_gasto_restaurante_fecha` (`restaurante_id`, `fecha`),
  CONSTRAINT `fk_stock_gasto_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_stock_gasto_usuario`
    FOREIGN KEY (`creado_por_usuario_id`) REFERENCES `usuario_restaurante` (`id`) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS `stock_gasto_item` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `gasto_id` INT NOT NULL,
  `insumo_id` INT NOT NULL,
  `cantidad` DECIMAL(14,3) NOT NULL,
  `costo_unitario` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `subtotal` DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (`id`),
  KEY `idx_stock_gasto_item_gasto` (`gasto_id`),
  CONSTRAINT `fk_stock_gasto_item_gasto`
    FOREIGN KEY (`gasto_id`) REFERENCES `stock_gasto` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_stock_gasto_item_insumo`
    FOREIGN KEY (`insumo_id`) REFERENCES `insumo` (`id`) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS `stock_movimiento` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `insumo_id` INT NOT NULL,
  `tipo` ENUM('compra', 'consumo', 'ajuste', 'devolucion') NOT NULL,
  `cantidad` DECIMAL(14,3) NOT NULL,
  `costo_unitario` DECIMAL(12,2) NULL DEFAULT NULL,
  `pedido_id` INT NULL DEFAULT NULL,
  `item_pedido_id` INT NULL DEFAULT NULL,
  `gasto_id` INT NULL DEFAULT NULL,
  `nota` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_stock_movimiento_item_insumo` (`item_pedido_id`, `insumo_id`),
  KEY `idx_stock_movimiento_restaurante_fecha` (`restaurante_id`, `created_at`),
  KEY `idx_stock_movimiento_pedido` (`pedido_id`),
  CONSTRAINT `fk_stock_movimiento_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_stock_movimiento_insumo`
    FOREIGN KEY (`insumo_id`) REFERENCES `insumo` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_stock_movimiento_gasto`
    FOREIGN KEY (`gasto_id`) REFERENCES `stock_gasto` (`id`) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS `stock_sync` (
  `restaurante_id` INT NOT NULL,
  `ultima_sincronizacion` DATETIME NOT NULL,
  PRIMARY KEY (`restaurante_id`),
  CONSTRAINT `fk_stock_sync_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE
);

-- Índice para conciliar sólo pedidos creados/actualizados desde el cursor.
-- MySQL no soporta CREATE INDEX IF NOT EXISTS: se usa una guarda reintentable.
DELIMITER //
DROP PROCEDURE IF EXISTS `t_stock_indice_pedido`//
CREATE PROCEDURE `t_stock_indice_pedido`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado'
      AND INDEX_NAME = 'idx_pedido_unificado_stock_sync'
  ) THEN
    ALTER TABLE `pedido_unificado`
      ADD INDEX `idx_pedido_unificado_stock_sync` (`restaurante_id`, `updated_at`);
  END IF;
END//
DELIMITER ;

CALL `t_stock_indice_pedido`();
DROP PROCEDURE `t_stock_indice_pedido`;

-- El módulo pasa de "en preparación" a disponible y activable (incluido).
UPDATE `modulo`
SET
  `nombre` = 'Control de stock',
  `descripcion` = 'Descontá insumos por venta, cargá compras y recibí alertas antes de quedarte sin stock.',
  `estado_producto` = 'disponible',
  `activable` = true,
  `activo` = true
WHERE `codigo` = 'gestion_stock';

-- POST-CHECK:
-- SELECT TABLE_NAME FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME IN ('insumo', 'producto_consumo', 'stock_gasto',
--                        'stock_gasto_item', 'stock_movimiento', 'stock_sync');
--   -> deben aparecer las 6.
-- SELECT estado_producto, activable FROM modulo WHERE codigo = 'gestion_stock';
--   -> disponible, 1.
