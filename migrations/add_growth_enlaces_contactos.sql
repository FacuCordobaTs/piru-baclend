-- T06 — Enlaces personalizados y ledger de contactos de Crecimiento.
--
-- Migración aditiva. El token público se entrega una sola vez al caller y no
-- se guarda: `marketing_enlace` persiste únicamente su SHA-256 en token_hash.
-- Las relaciones sensibles usan (restaurante_id, id), de modo que la base
-- rechaza referencias cruzadas entre tenants incluso ante un bug del servicio.
--
-- PRECONDICIONES:
--   1. hacer y verificar un backup lógico consistente (MySQL confirma DDL de
--      forma implícita);
--   2. ejecutar antes add_growth_marketing.sql;
--   3. comprobar que restaurante, producto, cliente, codigo_descuento y
--      marketing_campana usan InnoDB y no contienen inconsistencias de tenant;
--   4. desplegar el schema/backend compatible antes de habilitar escrituras.
--
-- Recuperación: detener escrituras Growth y eliminar marketing_contacto y
-- marketing_enlace, en ese orden. Los índices compuestos agregados a tablas
-- existentes son inocuos y pueden conservarse; restaurar el backup si las
-- tablas nuevas ya contienen información que deba recuperarse.

-- Los índices compuestos son claves candidatas para las FKs tenant-safe. Cada
-- bloque es reintentable y no recrea el índice si ya existe.
SET @piru_growth_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'producto'
      AND INDEX_NAME = 'uq_producto_restaurante_id'
  ),
  'SELECT 1',
  'ALTER TABLE `producto` ADD UNIQUE KEY `uq_producto_restaurante_id` (`restaurante_id`, `id`)'
);
PREPARE piru_growth_stmt FROM @piru_growth_sql;
EXECUTE piru_growth_stmt;
DEALLOCATE PREPARE piru_growth_stmt;

SET @piru_growth_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cliente'
      AND INDEX_NAME = 'uq_cliente_restaurante_id'
  ),
  'SELECT 1',
  'ALTER TABLE `cliente` ADD UNIQUE KEY `uq_cliente_restaurante_id` (`restaurante_id`, `id`)'
);
PREPARE piru_growth_stmt FROM @piru_growth_sql;
EXECUTE piru_growth_stmt;
DEALLOCATE PREPARE piru_growth_stmt;

SET @piru_growth_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'codigo_descuento'
      AND INDEX_NAME = 'uq_codigo_descuento_restaurante_id'
  ),
  'SELECT 1',
  'ALTER TABLE `codigo_descuento` ADD UNIQUE KEY `uq_codigo_descuento_restaurante_id` (`restaurante_id`, `id`)'
);
PREPARE piru_growth_stmt FROM @piru_growth_sql;
EXECUTE piru_growth_stmt;
DEALLOCATE PREPARE piru_growth_stmt;

SET @piru_growth_sql = IF(
  EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_campana'
      AND INDEX_NAME = 'uq_marketing_campana_restaurante_id'
  ),
  'SELECT 1',
  'ALTER TABLE `marketing_campana` ADD UNIQUE KEY `uq_marketing_campana_restaurante_id` (`restaurante_id`, `id`)'
);
PREPARE piru_growth_stmt FROM @piru_growth_sql;
EXECUTE piru_growth_stmt;
DEALLOCATE PREPARE piru_growth_stmt;

CREATE TABLE IF NOT EXISTS `marketing_enlace` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `campana_id` INT NULL,
  `cliente_id` INT NULL,
  `receta_codigo` VARCHAR(64) NULL,
  `token_hash` VARCHAR(64) NOT NULL,
  `idempotencia_clave` VARCHAR(128) NOT NULL,
  `destino_tipo` ENUM('tienda','producto','carrito') NOT NULL DEFAULT 'tienda',
  `producto_id` INT NULL,
  `carrito_rep` VARCHAR(2048) NULL,
  `codigo_descuento_id` INT NULL,
  `texto_sugerido` VARCHAR(4096) NULL,
  `expira_at` TIMESTAMP NULL,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_marketing_enlace_token_hash` (`token_hash`),
  UNIQUE KEY `uq_marketing_enlace_rest_idempotencia` (`restaurante_id`, `idempotencia_clave`),
  UNIQUE KEY `uq_marketing_enlace_restaurante_id` (`restaurante_id`, `id`),
  KEY `idx_marketing_enlace_rest_campana` (`restaurante_id`, `campana_id`, `created_at`),
  KEY `idx_marketing_enlace_rest_cliente` (`restaurante_id`, `cliente_id`, `created_at`),
  KEY `idx_marketing_enlace_rest_vigencia` (`restaurante_id`, `activo`, `expira_at`),
  CONSTRAINT `chk_marketing_enlace_expira`
    CHECK (`expira_at` IS NULL OR `expira_at` >= `created_at`),
  CONSTRAINT `fk_marketing_enlace_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_marketing_enlace_campana_tenant`
    FOREIGN KEY (`restaurante_id`, `campana_id`)
    REFERENCES `marketing_campana` (`restaurante_id`, `id`),
  CONSTRAINT `fk_marketing_enlace_cliente_tenant`
    FOREIGN KEY (`restaurante_id`, `cliente_id`)
    REFERENCES `cliente` (`restaurante_id`, `id`),
  CONSTRAINT `fk_marketing_enlace_producto_tenant`
    FOREIGN KEY (`restaurante_id`, `producto_id`)
    REFERENCES `producto` (`restaurante_id`, `id`),
  CONSTRAINT `fk_marketing_enlace_descuento_tenant`
    FOREIGN KEY (`restaurante_id`, `codigo_descuento_id`)
    REFERENCES `codigo_descuento` (`restaurante_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `marketing_contacto` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `enlace_id` INT NOT NULL,
  `cliente_id` INT NULL,
  `canal` ENUM('copiado','wa_me','piru_whatsapp','otro') NOT NULL,
  `estado` ENUM('preparado','abierto','reservado','enviado','fallido','revertido') NOT NULL DEFAULT 'preparado',
  `idempotencia_clave` VARCHAR(128) NOT NULL,
  `proveedor` VARCHAR(64) NULL,
  `proveedor_message_id` VARCHAR(255) NULL,
  `costo_mensajes` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `enviado_at` TIMESTAMP NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_marketing_contacto_rest_idempotencia` (`restaurante_id`, `idempotencia_clave`),
  UNIQUE KEY `uq_marketing_contacto_proveedor_mensaje` (`proveedor`, `proveedor_message_id`),
  KEY `idx_marketing_contacto_rest_enlace` (`restaurante_id`, `enlace_id`, `canal`, `estado`),
  KEY `idx_marketing_contacto_rest_cliente` (`restaurante_id`, `cliente_id`, `created_at`),
  KEY `idx_marketing_contacto_rest_estado` (`restaurante_id`, `estado`, `created_at`),
  CONSTRAINT `chk_marketing_contacto_costo` CHECK (`costo_mensajes` >= 0),
  CONSTRAINT `chk_marketing_contacto_enviado`
    CHECK (`enviado_at` IS NULL OR `enviado_at` >= `created_at`),
  CONSTRAINT `fk_marketing_contacto_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_marketing_contacto_enlace_tenant`
    FOREIGN KEY (`restaurante_id`, `enlace_id`)
    REFERENCES `marketing_enlace` (`restaurante_id`, `id`),
  CONSTRAINT `fk_marketing_contacto_cliente_tenant`
    FOREIGN KEY (`restaurante_id`, `cliente_id`)
    REFERENCES `cliente` (`restaurante_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- POSTCHECKS (sólo lectura):
--
-- 1. Ambas tablas deben existir (esperado: 2).
-- SELECT COUNT(*) AS tablas_growth_enlaces
-- FROM information_schema.TABLES
-- WHERE TABLE_SCHEMA = DATABASE()
--   AND TABLE_NAME IN ('marketing_enlace', 'marketing_contacto');
--
-- 2. Verificar FKs tenant-safe (esperado: enlace=5, contacto=3).
-- SELECT TABLE_NAME, COUNT(*) AS foreign_keys
-- FROM information_schema.TABLE_CONSTRAINTS
-- WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY'
--   AND TABLE_NAME IN ('marketing_enlace', 'marketing_contacto')
-- GROUP BY TABLE_NAME ORDER BY TABLE_NAME;
--
-- 3. Verificar hash global e idempotencia por tenant (esperado: 4 filas).
-- SELECT TABLE_NAME, INDEX_NAME,
--   GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columnas
-- FROM information_schema.STATISTICS
-- WHERE TABLE_SCHEMA = DATABASE() AND NON_UNIQUE = 0
--   AND INDEX_NAME IN (
--     'uq_marketing_enlace_token_hash',
--     'uq_marketing_enlace_rest_idempotencia',
--     'uq_marketing_contacto_rest_idempotencia',
--     'uq_marketing_contacto_proveedor_mensaje'
--   )
-- GROUP BY TABLE_NAME, INDEX_NAME ORDER BY TABLE_NAME, INDEX_NAME;
--
-- 4. No debe existir una columna que almacene el token público (esperado: 0).
-- SELECT COUNT(*) AS tokens_publicos_persistidos
-- FROM information_schema.COLUMNS
-- WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'marketing_enlace'
--   AND COLUMN_NAME = 'token';
--
-- 5. Las siguientes consultas deben devolver 0; las FKs compuestas impiden
--    crear estas inconsistencias una vez desplegada la migración.
-- SELECT COUNT(*) AS enlaces_campana_otro_tenant
-- FROM marketing_enlace e JOIN marketing_campana c ON c.id = e.campana_id
-- WHERE e.restaurante_id <> c.restaurante_id;
-- SELECT COUNT(*) AS contactos_enlace_otro_tenant
-- FROM marketing_contacto c JOIN marketing_enlace e ON e.id = c.enlace_id
-- WHERE c.restaurante_id <> e.restaurante_id;
