-- Migration: planes y suscripciones (modelo de negocio nuevo: cuota mensual fija,
-- sin comisión por venta). Tablas: plan, plan_feature, suscripcion, saldo_mensajes,
-- recarga_mensajes. Todo aditivo; no toca tablas existentes.
-- Ejecutar en MySQL (prod). Si algo ya existe, omitir la sentencia que falle.

CREATE TABLE IF NOT EXISTS `plan` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `codigo` VARCHAR(50) NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `descripcion` VARCHAR(500) DEFAULT NULL,
  `precio_mensual` DECIMAL(10,2) NOT NULL,
  `mensajes_incluidos` INT NOT NULL DEFAULT 0,
  `mensajes_marketing_incluidos` INT NOT NULL DEFAULT 0,
  `mensajes_ilimitados` BOOLEAN NOT NULL DEFAULT false,
  `orden` INT NOT NULL DEFAULT 0,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `plan_codigo_unique` (`codigo`)
);

CREATE TABLE IF NOT EXISTS `plan_feature` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `plan_id` INT NOT NULL,
  `feature_key` VARCHAR(100) NOT NULL,
  `habilitado` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_plan_feature` (`plan_id`, `feature_key`),
  CONSTRAINT `plan_feature_plan_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `plan` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS `suscripcion` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `plan_id` INT NOT NULL,
  `estado_suscripcion` ENUM('trial','activa','pago_pendiente','suspendida','cancelada') NOT NULL DEFAULT 'trial',
  `ciclo` ENUM('mensual','anual') NOT NULL DEFAULT 'mensual',
  `fecha_inicio` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `trial_fin` TIMESTAMP NULL DEFAULT NULL,
  `fecha_proximo_cobro` TIMESTAMP NULL DEFAULT NULL,
  `gracia_hasta` TIMESTAMP NULL DEFAULT NULL,
  `fecha_cancelacion` TIMESTAMP NULL DEFAULT NULL,
  `precio_mensual` DECIMAL(10,2) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `suscripcion_restaurante_id_unique` (`restaurante_id`),
  CONSTRAINT `suscripcion_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `suscripcion_plan_id_fk` FOREIGN KEY (`plan_id`) REFERENCES `plan` (`id`)
);

-- Wallet de mensajes: saldo actual por local (dos buckets: utility / marketing).
CREATE TABLE IF NOT EXISTS `saldo_mensajes` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `ciclo_inicio` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `ciclo_renueva_en` TIMESTAMP NULL DEFAULT NULL,
  `utility_incluidos_restantes` INT NOT NULL DEFAULT 0,
  `utility_recarga_saldo` INT NOT NULL DEFAULT 0,
  `marketing_incluidos_restantes` INT NOT NULL DEFAULT 0,
  `marketing_recarga_saldo` INT NOT NULL DEFAULT 0,
  `aviso_80_enviado` BOOLEAN NOT NULL DEFAULT false,
  `aviso_95_enviado` BOOLEAN NOT NULL DEFAULT false,
  `auto_recarga_habilitada` BOOLEAN NOT NULL DEFAULT false,
  `auto_recarga_umbral` INT NULL DEFAULT NULL,
  `auto_recarga_cantidad` INT NULL DEFAULT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `saldo_mensajes_restaurante_id_unique` (`restaurante_id`),
  CONSTRAINT `saldo_mensajes_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

-- Ledger de movimientos de mensajes (consumo/recarga/renovacion/expiracion/ajuste).
CREATE TABLE IF NOT EXISTS `transaccion_mensajes` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `tipo_transaccion` ENUM('consumo','recarga','renovacion_plan','expiracion','ajuste') NOT NULL,
  `categoria_mensaje` ENUM('utility','marketing') NOT NULL,
  `cantidad` INT NOT NULL,
  `saldo_resultante` INT NULL DEFAULT NULL,
  `motivo` VARCHAR(255) DEFAULT NULL,
  `tipo_mensaje` VARCHAR(64) DEFAULT NULL,
  `pedido_unificado_id` INT NULL DEFAULT NULL,
  `recarga_mensajes_id` INT NULL DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `transaccion_mensajes_restaurante_idx` (`restaurante_id`, `created_at`),
  CONSTRAINT `transaccion_mensajes_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

-- Comprobante financiero de cada compra de pack de recarga.
CREATE TABLE IF NOT EXISTS `recarga_mensajes` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `categoria_recarga` ENUM('utility','marketing') NOT NULL DEFAULT 'utility',
  `cantidad` INT NOT NULL,
  `monto` DECIMAL(10,2) NOT NULL,
  `origen_recarga` ENUM('manual','auto') NOT NULL DEFAULT 'manual',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `recarga_mensajes_restaurante_id_fk` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

-- ---------------------------------------------------------------------------
-- Seed: los 3 planes actuales y sus features (según el modelo de negocio).
-- Precios y mensajes son editables después sin deploy (UPDATE sobre plan).
-- ---------------------------------------------------------------------------

INSERT INTO `plan` (`codigo`, `nombre`, `descripcion`, `precio_mensual`, `mensajes_incluidos`, `mensajes_marketing_incluidos`, `mensajes_ilimitados`, `orden`, `activo`)
VALUES
  ('basico',     'Básico',    'Recepción de pedidos, impresión de comandas, menú ilimitado, todos los métodos de pago, cupones, estadísticas y reportes.', 20000.00, 0, 0, false, 1, true),
  ('intermedio', 'Intermedio','Todo lo del Básico más avisos automáticos al cliente por WhatsApp (200/mes), facturación ARCA, Rapiboy, múltiples sucursales y estadísticas avanzadas.', 50000.00, 200, 0, false, 2, true),
  ('avanzado',   'Avanzado',  'Todo lo del Intermedio más 100 mensajes de marketing/mes, dominio propio y Motor de Recompra.', 120000.00, 200, 100, false, 3, true)
ON DUPLICATE KEY UPDATE `nombre` = VALUES(`nombre`);

-- Features del plan Intermedio (Intermedio+).
INSERT INTO `plan_feature` (`plan_id`, `feature_key`)
SELECT p.id, f.feature_key
FROM `plan` p
JOIN (
  SELECT 'avisos_whatsapp_cliente' AS feature_key
  UNION ALL SELECT 'facturacion_arca'
  UNION ALL SELECT 'rapiboy'
  UNION ALL SELECT 'multisucursal'
  UNION ALL SELECT 'estadisticas_avanzadas'
) f
WHERE p.codigo = 'intermedio'
ON DUPLICATE KEY UPDATE `habilitado` = true;

-- Features del plan Avanzado (todo lo del Intermedio + dominio propio + motor de recompra).
INSERT INTO `plan_feature` (`plan_id`, `feature_key`)
SELECT p.id, f.feature_key
FROM `plan` p
JOIN (
  SELECT 'avisos_whatsapp_cliente' AS feature_key
  UNION ALL SELECT 'facturacion_arca'
  UNION ALL SELECT 'rapiboy'
  UNION ALL SELECT 'multisucursal'
  UNION ALL SELECT 'estadisticas_avanzadas'
  UNION ALL SELECT 'dominio_propio'
  UNION ALL SELECT 'motor_recompra'
) f
WHERE p.codigo = 'avanzado'
ON DUPLICATE KEY UPDATE `habilitado` = true;
