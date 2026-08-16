-- T01 — Suscripción única y catálogo de módulos.
--
-- Esta migración es ADITIVA. Conserva plan/plan_feature y las columnas plan_id/
-- precio_mensual/monto como compatibilidad temporal para los admins instalados;
-- T05 retirará el runtime que las consume antes de que se eliminen físicamente.
--
-- PRECONDICIÓN OBLIGATORIA: hacer y verificar un backup lógico consistente antes
-- de ejecutar. Ejemplo:
--   mysqldump --single-transaction --routines --triggers piru > piru-pre-t01.sql
-- Rollback: restaurar ese backup. No hay rollback SQL automático porque MySQL
-- confirma DDL implícitamente. Esta migración no borra tablas ni datos legacy.
--
-- Orden seguro: crear catálogo -> extender tablas existentes -> backfill -> seeds
-- -> entitlement puntual de Alfajor. Las extensiones de tablas usan consultas a
-- information_schema dentro de un procedimiento temporal, por lo que también
-- son re-ejecutables en MySQL anterior a 8.0.29 (que no soporta
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS `configuracion_suscripcion` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `codigo` VARCHAR(50) NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `descripcion` VARCHAR(500) DEFAULT NULL,
  `precio_mensual` DECIMAL(10,2) NOT NULL,
  `descuento_anual` INT NOT NULL DEFAULT 20,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_configuracion_suscripcion_codigo` (`codigo`)
);

CREATE TABLE IF NOT EXISTS `categoria_modulo` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `codigo` VARCHAR(50) NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `descripcion` VARCHAR(500) DEFAULT NULL,
  `orden` INT NOT NULL DEFAULT 0,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_categoria_modulo_codigo` (`codigo`)
);

CREATE TABLE IF NOT EXISTS `modulo` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `codigo` VARCHAR(100) NOT NULL,
  `categoria_id` INT NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `descripcion` VARCHAR(500) DEFAULT NULL,
  `tipo_modulo` ENUM('incluido','pago') NOT NULL,
  `precio_mensual` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `mensajes_utility_incluidos` INT NOT NULL DEFAULT 0,
  `mensajes_marketing_incluidos` INT NOT NULL DEFAULT 0,
  `estado_producto` ENUM('disponible','beta','proximamente') NOT NULL DEFAULT 'disponible',
  `activable` BOOLEAN NOT NULL DEFAULT true,
  `icono` VARCHAR(100) DEFAULT NULL,
  `orden` INT NOT NULL DEFAULT 0,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_modulo_codigo` (`codigo`),
  KEY `idx_modulo_categoria_orden` (`categoria_id`, `orden`),
  CONSTRAINT `fk_modulo_categoria` FOREIGN KEY (`categoria_id`) REFERENCES `categoria_modulo` (`id`)
);

CREATE TABLE IF NOT EXISTS `restaurante_modulo` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `modulo_id` INT NOT NULL,
  `estado_restaurante_modulo` ENUM('inactivo','pendiente_pago','activo','cancelacion_programada','suspendido') NOT NULL DEFAULT 'inactivo',
  `activado_at` TIMESTAMP NULL DEFAULT NULL,
  `desactivado_at` TIMESTAMP NULL DEFAULT NULL,
  `vigente_hasta` TIMESTAMP NULL DEFAULT NULL,
  `precio_mensual_congelado` DECIMAL(10,2) DEFAULT NULL,
  `origen_restaurante_modulo` ENUM('usuario','interno','migracion','trial','legacy') NOT NULL DEFAULT 'usuario',
  `cancelar_al_fin_periodo` BOOLEAN NOT NULL DEFAULT false,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_restaurante_modulo` (`restaurante_id`, `modulo_id`),
  KEY `idx_restaurante_modulo_estado` (`restaurante_id`, `estado_restaurante_modulo`),
  CONSTRAINT `fk_restaurante_modulo_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_restaurante_modulo_modulo` FOREIGN KEY (`modulo_id`) REFERENCES `modulo` (`id`)
);

CREATE TABLE IF NOT EXISTS `pago_suscripcion_item` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `pago_suscripcion_id` INT NOT NULL,
  `tipo_item_pago_suscripcion` ENUM('base','modulo') NOT NULL,
  `modulo_id` INT NULL DEFAULT NULL,
  `codigo` VARCHAR(100) NOT NULL,
  `descripcion` VARCHAR(500) NOT NULL,
  `cantidad` INT NOT NULL DEFAULT 1,
  `precio_unitario` DECIMAL(10,2) NOT NULL,
  `monto` DECIMAL(10,2) NOT NULL,
  `desde` TIMESTAMP NULL DEFAULT NULL,
  `hasta` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pago_suscripcion_item_pago` (`pago_suscripcion_id`),
  KEY `idx_pago_suscripcion_item_modulo` (`modulo_id`),
  CONSTRAINT `fk_pago_suscripcion_item_pago` FOREIGN KEY (`pago_suscripcion_id`) REFERENCES `pago_suscripcion` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pago_suscripcion_item_modulo` FOREIGN KEY (`modulo_id`) REFERENCES `modulo` (`id`)
);

-- MySQL no admite ADD ... IF NOT EXISTS en todas las versiones soportadas.
-- Cada columna, índice y FK se agrega condicionalmente para que una segunda
-- ejecución controlada sea segura, incluso si la primera quedó interrumpida.
DELIMITER //
DROP PROCEDURE IF EXISTS `t01_extender_suscripcion_unica`//
CREATE PROCEDURE `t01_extender_suscripcion_unica`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suscripcion'
      AND COLUMN_NAME = 'configuracion_suscripcion_id'
  ) THEN
    ALTER TABLE `suscripcion` ADD COLUMN `configuracion_suscripcion_id` INT NULL DEFAULT NULL AFTER `plan_id`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suscripcion'
      AND COLUMN_NAME = 'precio_base_mensual'
  ) THEN
    ALTER TABLE `suscripcion` ADD COLUMN `precio_base_mensual` DECIMAL(10,2) NULL DEFAULT NULL AFTER `precio_mensual`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suscripcion'
      AND COLUMN_NAME = 'monto_modulos_mensual'
  ) THEN
    ALTER TABLE `suscripcion` ADD COLUMN `monto_modulos_mensual` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `precio_base_mensual`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suscripcion'
      AND COLUMN_NAME = 'monto_total_mensual'
  ) THEN
    ALTER TABLE `suscripcion` ADD COLUMN `monto_total_mensual` DECIMAL(10,2) NULL DEFAULT NULL AFTER `monto_modulos_mensual`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suscripcion'
      AND INDEX_NAME = 'idx_suscripcion_configuracion'
  ) THEN
    ALTER TABLE `suscripcion` ADD KEY `idx_suscripcion_configuracion` (`configuracion_suscripcion_id`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pago_suscripcion'
      AND COLUMN_NAME = 'configuracion_suscripcion_id'
  ) THEN
    ALTER TABLE `pago_suscripcion` ADD COLUMN `configuracion_suscripcion_id` INT NULL DEFAULT NULL AFTER `plan_id`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pago_suscripcion'
      AND COLUMN_NAME = 'monto_base'
  ) THEN
    ALTER TABLE `pago_suscripcion` ADD COLUMN `monto_base` DECIMAL(10,2) NULL DEFAULT NULL AFTER `monto`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pago_suscripcion'
      AND COLUMN_NAME = 'monto_modulos'
  ) THEN
    ALTER TABLE `pago_suscripcion` ADD COLUMN `monto_modulos` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `monto_base`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pago_suscripcion'
      AND COLUMN_NAME = 'monto_total'
  ) THEN
    ALTER TABLE `pago_suscripcion` ADD COLUMN `monto_total` DECIMAL(10,2) NULL DEFAULT NULL AFTER `monto_modulos`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pago_suscripcion'
      AND INDEX_NAME = 'idx_pago_suscripcion_configuracion'
  ) THEN
    ALTER TABLE `pago_suscripcion` ADD KEY `idx_pago_suscripcion_configuracion` (`configuracion_suscripcion_id`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'suscripcion'
      AND CONSTRAINT_NAME = 'fk_suscripcion_configuracion'
  ) THEN
    ALTER TABLE `suscripcion`
      ADD CONSTRAINT `fk_suscripcion_configuracion`
      FOREIGN KEY (`configuracion_suscripcion_id`) REFERENCES `configuracion_suscripcion` (`id`);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'pago_suscripcion'
      AND CONSTRAINT_NAME = 'fk_pago_suscripcion_configuracion'
  ) THEN
    ALTER TABLE `pago_suscripcion`
      ADD CONSTRAINT `fk_pago_suscripcion_configuracion`
      FOREIGN KEY (`configuracion_suscripcion_id`) REFERENCES `configuracion_suscripcion` (`id`);
  END IF;
END//
CALL `t01_extender_suscripcion_unica`()//
DROP PROCEDURE `t01_extender_suscripcion_unica`//
DELIMITER ;

-- Configuración única. Los UPSERTs permiten volver a ejecutar el seed sin
-- duplicar filas y restauran la definición de producto aprobada.
INSERT INTO `configuracion_suscripcion`
  (`codigo`, `nombre`, `descripcion`, `precio_mensual`, `descuento_anual`, `activo`)
VALUES
  ('piru', 'Suscripción Piru', 'Operación base de Piru.', 20000.00, 20, true)
ON DUPLICATE KEY UPDATE
  `nombre` = VALUES(`nombre`), `descripcion` = VALUES(`descripcion`),
  `precio_mensual` = VALUES(`precio_mensual`), `descuento_anual` = VALUES(`descuento_anual`), `activo` = VALUES(`activo`);

INSERT INTO `categoria_modulo` (`codigo`, `nombre`, `descripcion`, `orden`, `activo`) VALUES
  ('ventas_local', 'Ventas en el local', 'Herramientas para vender y operar en el local.', 1, true),
  ('clientes_fidelizacion', 'Clientes y fidelización', 'Relación y recompra de clientes.', 2, true),
  ('cobros', 'Cobros', 'Medios de pago e integraciones de cobro.', 3, true),
  ('delivery', 'Delivery', 'Operación de entregas.', 4, true),
  ('operacion_administracion', 'Operación y administración', 'Herramientas operativas del negocio.', 5, true),
  ('modulos_pagos', 'Módulos pagos', 'Capacidades adicionales con cargo mensual.', 6, true)
ON DUPLICATE KEY UPDATE
  `nombre` = VALUES(`nombre`), `descripcion` = VALUES(`descripcion`), `orden` = VALUES(`orden`), `activo` = VALUES(`activo`);

INSERT INTO `modulo`
  (`codigo`, `categoria_id`, `nombre`, `descripcion`, `tipo_modulo`, `precio_mensual`, `mensajes_utility_incluidos`, `mensajes_marketing_incluidos`, `estado_producto`, `activable`, `icono`, `orden`, `activo`)
SELECT s.codigo, c.id, s.nombre, s.descripcion, s.tipo_modulo, s.precio_mensual, s.utility, s.marketing, s.estado_producto, s.activable, s.icono, s.orden, true
FROM (
  SELECT 'pos' codigo, 'ventas_local' categoria, 'Punto de venta' nombre, 'Tomá pedidos desde el mostrador.' descripcion, 'incluido' tipo_modulo, 0.00 precio_mensual, 0 utility, 0 marketing, 'beta' estado_producto, true activable, 'Store' icono, 1 orden
  UNION ALL SELECT 'mesas', 'ventas_local', 'Mesas', 'Gestioná mesas y consumo en el local.', 'incluido', 0.00, 0, 0, 'proximamente', true, 'Utensils', 2
  UNION ALL SELECT 'puntos_clientes', 'clientes_fidelizacion', 'Puntos para clientes', 'Programa de puntos y fidelización.', 'incluido', 0.00, 0, 0, 'proximamente', true, 'Award', 1
  UNION ALL SELECT 'codigos_descuento', 'clientes_fidelizacion', 'Códigos de descuento', 'Creá promociones y cupones.', 'incluido', 0.00, 0, 0, 'disponible', true, 'Ticket', 2
  UNION ALL SELECT 'mercadopago', 'cobros', 'Mercado Pago', 'Cobros online con Mercado Pago.', 'incluido', 0.00, 0, 0, 'disponible', true, 'CreditCard', 1
  UNION ALL SELECT 'talo', 'cobros', 'Talo', 'Cobros online con Talo.', 'incluido', 0.00, 0, 0, 'disponible', true, 'WalletCards', 2
  UNION ALL SELECT 'rapiboy', 'delivery', 'Rapiboy', 'Integración con cadetes Rapiboy.', 'incluido', 0.00, 0, 0, 'disponible', true, 'Bike', 1
  UNION ALL SELECT 'facturacion_arca', 'operacion_administracion', 'Facturación ARCA', 'Emití comprobantes electrónicos.', 'incluido', 0.00, 0, 0, 'disponible', true, 'Receipt', 1
  UNION ALL SELECT 'gestion_stock', 'operacion_administracion', 'Gestión de stock', 'Controlá disponibilidad e inventario.', 'incluido', 0.00, 0, 0, 'proximamente', true, 'Package', 2
  UNION ALL SELECT 'gestion_cadetes', 'operacion_administracion', 'Gestión de cadetes', 'Organizá repartidores propios.', 'incluido', 0.00, 0, 0, 'disponible', true, 'Truck', 3
  UNION ALL SELECT 'impresion_comandas', 'operacion_administracion', 'Impresión de comandas', 'Imprimí pedidos automáticamente.', 'incluido', 0.00, 0, 0, 'disponible', true, 'Printer', 4
  UNION ALL SELECT 'multisucursal', 'operacion_administracion', 'Múltiples sucursales', 'Operá más de un local.', 'incluido', 0.00, 0, 0, 'disponible', true, 'Building2', 5
  UNION ALL SELECT 'avisos_automaticos_whatsapp', 'modulos_pagos', 'Avisos automáticos por WhatsApp', 'Avisos de estado de pedidos con la marca del local.', 'pago', 30000.00, 200, 0, 'disponible', true, 'MessageCircle', 1
  UNION ALL SELECT 'motor_recompra', 'modulos_pagos', 'Motor de Recompra', 'Recuperá clientes automáticamente.', 'pago', 70000.00, 0, 100, 'disponible', true, 'Repeat2', 2
) s
JOIN `categoria_modulo` c ON c.codigo = s.categoria
ON DUPLICATE KEY UPDATE
  `categoria_id` = VALUES(`categoria_id`), `nombre` = VALUES(`nombre`), `descripcion` = VALUES(`descripcion`),
  `tipo_modulo` = VALUES(`tipo_modulo`), `precio_mensual` = VALUES(`precio_mensual`),
  `mensajes_utility_incluidos` = VALUES(`mensajes_utility_incluidos`), `mensajes_marketing_incluidos` = VALUES(`mensajes_marketing_incluidos`),
  `estado_producto` = VALUES(`estado_producto`), `activable` = VALUES(`activable`), `icono` = VALUES(`icono`), `orden` = VALUES(`orden`), `activo` = true;

-- Backfill de snapshots para que las filas existentes tengan una única
-- configuración comercial sin alterar su plan legacy ni su período vigente.
UPDATE `suscripcion` s
JOIN `configuracion_suscripcion` cs ON cs.codigo = 'piru'
SET s.configuracion_suscripcion_id = COALESCE(s.configuracion_suscripcion_id, cs.id),
    s.precio_base_mensual = COALESCE(s.precio_base_mensual, s.precio_mensual, cs.precio_mensual),
    s.monto_total_mensual = COALESCE(s.monto_total_mensual, s.precio_mensual, cs.precio_mensual) + s.monto_modulos_mensual;

UPDATE `pago_suscripcion` ps
JOIN `configuracion_suscripcion` cs ON cs.codigo = 'piru'
SET ps.configuracion_suscripcion_id = COALESCE(ps.configuracion_suscripcion_id, cs.id),
    ps.monto_base = COALESCE(ps.monto_base, ps.monto),
    ps.monto_total = COALESCE(ps.monto_total, ps.monto) + ps.monto_modulos;

-- Alfajor no hereda módulos gratuitos. Conserva Cucuru fuera del catálogo, pero
-- Avisos queda como módulo pago estándar para que su primer checkout facture
-- base + Avisos igual que cualquier cuenta nueva.
INSERT INTO `restaurante_modulo`
  (`restaurante_id`, `modulo_id`, `estado_restaurante_modulo`, `activado_at`, `precio_mensual_congelado`, `origen_restaurante_modulo`, `cancelar_al_fin_periodo`)
SELECT r.id, m.id, 'activo', CURRENT_TIMESTAMP, m.precio_mensual, 'migracion', false
FROM `restaurante` r
JOIN `modulo` m ON m.codigo = 'avisos_automaticos_whatsapp'
WHERE r.requiere_suscripcion = false
  AND (LOWER(COALESCE(r.username, '')) IN ('alfajor', 'alfajorconpapas') OR LOWER(COALESCE(r.nombre, '')) = 'alfajor con papas')
ON DUPLICATE KEY UPDATE
  `estado_restaurante_modulo` = 'activo', `precio_mensual_congelado` = VALUES(`precio_mensual_congelado`),
  `origen_restaurante_modulo` = 'migracion', `cancelar_al_fin_periodo` = false,
  `desactivado_at` = NULL;

UPDATE `restaurante`
SET `requiere_suscripcion` = true
WHERE LOWER(COALESCE(`username`, '')) IN ('alfajor', 'alfajorconpapas')
   OR LOWER(COALESCE(`nombre`, '')) = 'alfajor con papas';
