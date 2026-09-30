-- Cobros con QR estático de Mercado Pago en el POS (cajas vinculadas + intentos de cobro).
--
-- ADITIVA: sólo crea dos tablas nuevas. No toca `pedido_unificado`, `pago`, módulos ni
-- ninguna configuración existente, así que el backend anterior convive con este esquema.
-- Aplicar ANTES de desplegar el backend que las consume.
--
-- `mp_caja_qr`: POS (caja) de Mercado Pago del propio vendedor. Se vincula una existente o se
--   crea sobre una tienda real del vendedor; la migración no crea ni inventa ninguna.
-- `pos_cobro_qr`: un intento de cobro de un pedido contra el QR de una caja. Los instantes
--   (`created_at`, `updated_at`, `expira_at`, `pagado_at`) los escribe la aplicación con
--   Drizzle y son DATETIME (sin conversión de zona), no TIMESTAMP: un TIMESTAMP se convierte
--   según la zona de cada sesión MySQL y Drizzle asume UTC, así que el mismo instante no
--   siempre volvería igual. Nunca compararlos en SQL con NOW()/CURRENT_TIMESTAMP.
--
-- PRECONDICIÓN: backup lógico verificado antes de ejecutar (MySQL confirma DDL de forma
-- implícita). `CREATE TABLE IF NOT EXISTS` hace la migración reintentable.

CREATE TABLE IF NOT EXISTS `mp_caja_qr` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `nombre` VARCHAR(120) NOT NULL,
  `mp_pos_id` VARCHAR(40) NOT NULL,
  `mp_store_id` VARCHAR(40) NULL DEFAULT NULL,
  `external_pos_id` VARCHAR(64) NOT NULL,
  `qr_imagen_url` VARCHAR(512) NULL DEFAULT NULL,
  `qr_plantilla_url` VARCHAR(512) NULL DEFAULT NULL,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mp_caja_qr_restaurante_pos` (`restaurante_id`, `mp_pos_id`),
  KEY `idx_mp_caja_qr_restaurante_activo` (`restaurante_id`, `activo`),
  CONSTRAINT `fk_mp_caja_qr_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

CREATE TABLE IF NOT EXISTS `pos_cobro_qr` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `pedido_id` INT NOT NULL,
  `caja_id` INT NOT NULL,
  `monto` DECIMAL(10,2) NOT NULL,
  `external_reference` VARCHAR(64) NOT NULL,
  `mp_order_id` VARCHAR(64) NULL DEFAULT NULL,
  `estado` ENUM('creando', 'creado', 'pagado', 'cancelado', 'vencido', 'reembolsado', 'error')
    NOT NULL DEFAULT 'creando',
  `mp_status` VARCHAR(40) NULL DEFAULT NULL,
  `mp_status_detail` VARCHAR(80) NULL DEFAULT NULL,
  `mp_payment_id` VARCHAR(64) NULL DEFAULT NULL,
  `monto_pagado` DECIMAL(10,2) NULL DEFAULT NULL,
  `mensaje` VARCHAR(255) NULL DEFAULT NULL,
  `expira_at` DATETIME NULL DEFAULT NULL,
  `pagado_at` DATETIME NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pos_cobro_qr_referencia` (`external_reference`),
  UNIQUE KEY `uq_pos_cobro_qr_mp_order` (`mp_order_id`),
  KEY `idx_pos_cobro_qr_pedido` (`pedido_id`, `created_at`),
  KEY `idx_pos_cobro_qr_caja_estado` (`caja_id`, `estado`),
  CONSTRAINT `fk_pos_cobro_qr_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  -- CASCADE: borrar un pedido (DELETE /pedido-unificado/:id, baja de un cliente) no debe
  -- quedar bloqueado por su historial de cobros.
  CONSTRAINT `fk_pos_cobro_qr_pedido`
    FOREIGN KEY (`pedido_id`) REFERENCES `pedido_unificado` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pos_cobro_qr_caja`
    FOREIGN KEY (`caja_id`) REFERENCES `mp_caja_qr` (`id`)
);
