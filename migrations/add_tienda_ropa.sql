-- Tienda de indumentaria (ropa) — catálogo, pedidos y pagos para alfajor (restaurante id 6).
--
-- Esta migración es ADITIVA y aislada: no toca `pedido_unificado`, `item_pedido_unificado`,
-- `producto`, `account_pool` ni ninguna de sus rutas. Los pedidos de comida siguen su curso
-- sin cambios de comportamiento; la ropa vive en sus propias tablas.
--
-- Agrega a `restaurante` dos columnas de configuración de la tienda de ropa
-- (`ropa_envio_enabled`, `ropa_costo_envio`), deliberadamente separadas de
-- `delivery_enabled`/`delivery_fee`, que gobiernan el envío de comida.
--
-- PRECONDICIÓN: hacer y verificar un backup lógico antes de ejecutar. MySQL
-- confirma DDL implícitamente, por lo que la recuperación es restaurar ese backup.
-- Las guardas de information_schema hacen reintentable la extensión de la tabla
-- existente en MySQL, que no soporta ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS `ropa_producto` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `subtitulo` VARCHAR(255) NULL DEFAULT NULL,
  `descripcion` VARCHAR(500) NULL DEFAULT NULL,
  `composicion` VARCHAR(255) NULL DEFAULT NULL,
  `fit` VARCHAR(100) NULL DEFAULT NULL,
  `precio` DECIMAL(10,2) NOT NULL,
  `precio_anterior` DECIMAL(10,2) NULL DEFAULT NULL,
  `categoria` VARCHAR(50) NULL DEFAULT NULL,
  -- Array JSON de URLs de R2. La primera es la imagen de la tarjeta del catálogo.
  `imagenes` JSON NULL,
  -- Array JSON de strings, ej. ["S","M","L","XL"].
  `talles` JSON NULL,
  -- Array JSON de { nombre: string, hex: string }.
  `colores` JSON NULL,
  -- NULL = sin control de stock; con valor, se descuenta al confirmar cada pedido.
  `stock` INT NULL DEFAULT NULL,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `orden` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ropa_producto_restaurante_activo_orden` (`restaurante_id`, `activo`, `orden`),
  CONSTRAINT `fk_ropa_producto_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

CREATE TABLE IF NOT EXISTS `ropa_pedido` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `nombre_cliente` VARCHAR(255) NOT NULL,
  `telefono` VARCHAR(50) NOT NULL,
  `email` VARCHAR(255) NULL DEFAULT NULL,
  `tipo_entrega` ENUM('retiro', 'envio') NOT NULL,
  `direccion` VARCHAR(512) NULL DEFAULT NULL,
  `ciudad` VARCHAR(255) NULL DEFAULT NULL,
  `codigo_postal` VARCHAR(20) NULL DEFAULT NULL,
  `notas` VARCHAR(500) NULL DEFAULT NULL,
  `subtotal` DECIMAL(10,2) NOT NULL,
  `costo_envio` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `total` DECIMAL(10,2) NOT NULL,
  -- Canonical: mercadopago_checkout, transferencia_automatica_cucuru, manual_transfer, cash.
  -- Ver backend/src/lib/metodos-pago.ts
  `metodo_pago` VARCHAR(64) NULL DEFAULT NULL,
  `pagado` BOOLEAN NOT NULL DEFAULT false,
  `estado_pago` ENUM('pendiente', 'pagado', 'fallido') NOT NULL DEFAULT 'pendiente',
  `estado` ENUM('pendiente', 'preparando', 'enviado', 'entregado', 'cancelado') NOT NULL DEFAULT 'pendiente',
  -- Alias/CVU dinámico de Cucuru minteado por pedido (ver services/cucuru.ts). Se duplica acá
  -- además de en ropa_pago porque es lo que le muestra la pantalla de seguimiento al comprador.
  `alias_transferencia` VARCHAR(255) NULL DEFAULT NULL,
  `cvu_transferencia` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ropa_pedido_restaurante_estado_fecha` (`restaurante_id`, `estado`, `created_at`),
  CONSTRAINT `fk_ropa_pedido_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

CREATE TABLE IF NOT EXISTS `ropa_pedido_item` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `pedido_id` INT NOT NULL,
  -- Sin FK estricta a ropa_producto, igual que item_pedido_unificado.producto_id: borrar un
  -- producto no debe romper el historial de pedidos ya hechos.
  `producto_id` INT NOT NULL,
  -- Snapshot comercial al momento de la compra.
  `nombre_producto` VARCHAR(255) NOT NULL,
  `imagen_url` VARCHAR(512) NULL DEFAULT NULL,
  `talle` VARCHAR(50) NULL DEFAULT NULL,
  `color_nombre` VARCHAR(100) NULL DEFAULT NULL,
  `color_hex` VARCHAR(20) NULL DEFAULT NULL,
  `cantidad` INT NOT NULL DEFAULT 1,
  `precio_unitario` DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_ropa_pedido_item_pedido` (`pedido_id`),
  CONSTRAINT `fk_ropa_pedido_item_pedido`
    FOREIGN KEY (`pedido_id`) REFERENCES `ropa_pedido` (`id`) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `ropa_pago` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `pedido_id` INT NOT NULL,
  `metodo` VARCHAR(64) NOT NULL,
  `estado` ENUM('pending', 'paid', 'failed') NOT NULL DEFAULT 'pending',
  `monto` DECIMAL(10,2) NOT NULL,
  -- Ids de Mercado Pago. La external_reference que los asocia es `piru-ropa-{pedidoId}`,
  -- deliberadamente distinta del `piru-{id}` de comida para que el webhook no se confunda.
  `mp_payment_id` VARCHAR(255) NULL DEFAULT NULL,
  `mp_preference_id` VARCHAR(255) NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ropa_pago_pedido` (`pedido_id`),
  CONSTRAINT `fk_ropa_pago_pedido`
    FOREIGN KEY (`pedido_id`) REFERENCES `ropa_pedido` (`id`) ON DELETE CASCADE
);

DELIMITER //
DROP PROCEDURE IF EXISTS `t_ropa_extender_restaurante`//
CREATE PROCEDURE `t_ropa_extender_restaurante`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurante'
      AND COLUMN_NAME = 'ropa_envio_enabled'
  ) THEN
    ALTER TABLE `restaurante`
      ADD COLUMN `ropa_envio_enabled` BOOLEAN NOT NULL DEFAULT true AFTER `afip_condicion_iva`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurante'
      AND COLUMN_NAME = 'ropa_costo_envio'
  ) THEN
    ALTER TABLE `restaurante`
      ADD COLUMN `ropa_costo_envio` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `ropa_envio_enabled`;
  END IF;
END//
DELIMITER ;

CALL `t_ropa_extender_restaurante`();
DROP PROCEDURE `t_ropa_extender_restaurante`;

-- POST-CHECK (descomentar y correr a mano después de aplicar):
--
-- SELECT TABLE_NAME FROM information_schema.TABLES
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME IN ('ropa_producto', 'ropa_pedido', 'ropa_pedido_item', 'ropa_pago');
--   -> deben aparecer las 4.
--
-- SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'restaurante'
--     AND COLUMN_NAME IN ('ropa_envio_enabled', 'ropa_costo_envio');
--   -> ropa_envio_enabled tinyint(1) default 1 · ropa_costo_envio decimal(10,2) default 0.00
--
-- SELECT COUNT(*) FROM `ropa_producto`;  -- 0: catálogo vacío, no toca datos existentes
-- SELECT COUNT(*) FROM `ropa_pedido`;    -- 0
