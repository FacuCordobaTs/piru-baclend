-- T05 — Base de datos de Crecimiento: campañas, sesiones, eventos y atribución.
--
-- Migración exclusivamente aditiva. No agrega columnas a `pedido_unificado`:
-- la atribución queda en una tabla separada y auditable. Las claves de
-- idempotencia incluyen `restaurante_id`, de modo que dos tenants pueden usar
-- el mismo UUID/slug sin colisionar.
--
-- PRECONDICIONES:
--   1. hacer y verificar un backup lógico consistente (MySQL confirma DDL de
--      forma implícita);
--   2. comprobar que existen restaurante, producto, codigo_descuento y
--      pedido_unificado, y que todas usan InnoDB;
--   3. desplegar el schema/backend compatible antes de habilitar tráfico Growth.
--
-- Recuperación: detener escrituras Growth y eliminar las cuatro tablas en el
-- orden inverso al de creación, o restaurar el backup si ya contienen datos.

CREATE TABLE IF NOT EXISTS `marketing_campana` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(191) NOT NULL,
  `tipo` ENUM('adquisicion','recompra') NOT NULL,
  `receta_codigo` VARCHAR(64) NULL,
  `estado` ENUM('borrador','activa','inactiva') NOT NULL DEFAULT 'borrador',
  `destino_tipo` ENUM('tienda','producto','carrito') NOT NULL DEFAULT 'tienda',
  `producto_id` INT NULL,
  `carrito_rep` VARCHAR(2048) NULL,
  `codigo_descuento_id` INT NULL,
  `utm_source` VARCHAR(255) NULL,
  `utm_medium` VARCHAR(255) NULL,
  `utm_campaign` VARCHAR(255) NULL,
  `utm_term` VARCHAR(255) NULL,
  `utm_content` VARCHAR(255) NULL,
  `inversion_manual` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `usa_grupo_control` BOOLEAN NOT NULL DEFAULT false,
  `activada_at` TIMESTAMP NULL,
  `desactivada_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_marketing_campana_restaurante_slug` (`restaurante_id`, `slug`),
  KEY `idx_marketing_campana_restaurante_estado` (`restaurante_id`, `estado`, `created_at`),
  KEY `idx_marketing_campana_producto` (`producto_id`),
  KEY `idx_marketing_campana_codigo_descuento` (`codigo_descuento_id`),
  CONSTRAINT `chk_marketing_campana_inversion` CHECK (`inversion_manual` >= 0),
  CONSTRAINT `fk_marketing_campana_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_marketing_campana_producto`
    FOREIGN KEY (`producto_id`) REFERENCES `producto` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_marketing_campana_codigo_descuento`
    FOREIGN KEY (`codigo_descuento_id`) REFERENCES `codigo_descuento` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `marketing_sesion` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `sesion_uuid` VARCHAR(64) NOT NULL,
  `visitor_id` VARCHAR(64) NOT NULL,
  `first_touch_tipo` ENUM('directo','campana','receta') NOT NULL DEFAULT 'directo',
  `first_touch_campana_id` INT NULL,
  `first_touch_receta_codigo` VARCHAR(64) NULL,
  `first_touch_at` TIMESTAMP NOT NULL,
  `last_touch_tipo` ENUM('directo','campana','receta') NOT NULL DEFAULT 'directo',
  `last_touch_campana_id` INT NULL,
  `last_touch_receta_codigo` VARCHAR(64) NULL,
  `last_touch_at` TIMESTAMP NOT NULL,
  `expira_at` TIMESTAMP NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_marketing_sesion_restaurante_uuid` (`restaurante_id`, `sesion_uuid`),
  KEY `idx_marketing_sesion_restaurante_visitor` (`restaurante_id`, `visitor_id`, `last_touch_at`),
  KEY `idx_marketing_sesion_restaurante_expira` (`restaurante_id`, `expira_at`),
  KEY `idx_marketing_sesion_first_campana` (`first_touch_campana_id`),
  KEY `idx_marketing_sesion_last_campana` (`last_touch_campana_id`),
  CONSTRAINT `chk_marketing_sesion_touch` CHECK (`last_touch_at` >= `first_touch_at`),
  CONSTRAINT `chk_marketing_sesion_expira` CHECK (`expira_at` >= `last_touch_at`),
  CONSTRAINT `fk_marketing_sesion_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_marketing_sesion_first_campana`
    FOREIGN KEY (`first_touch_campana_id`) REFERENCES `marketing_campana` (`id`),
  CONSTRAINT `fk_marketing_sesion_last_campana`
    FOREIGN KEY (`last_touch_campana_id`) REFERENCES `marketing_campana` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `marketing_evento` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `marketing_sesion_id` INT NOT NULL,
  `evento_uuid` VARCHAR(64) NOT NULL,
  `tipo` ENUM('session_start','product_view','add_to_cart','checkout_start','purchase') NOT NULL,
  `producto_id` INT NULL,
  `pedido_unificado_id` INT NULL,
  `cantidad` INT NULL,
  `valor` DECIMAL(14,2) NULL,
  `metadata` JSON NULL,
  `ocurrido_at` TIMESTAMP NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_marketing_evento_restaurante_uuid` (`restaurante_id`, `evento_uuid`),
  KEY `idx_marketing_evento_sesion_fecha` (`marketing_sesion_id`, `ocurrido_at`),
  KEY `idx_marketing_evento_restaurante_tipo_fecha` (`restaurante_id`, `tipo`, `ocurrido_at`),
  KEY `idx_marketing_evento_pedido` (`pedido_unificado_id`),
  KEY `idx_marketing_evento_producto` (`producto_id`),
  CONSTRAINT `chk_marketing_evento_cantidad` CHECK (`cantidad` IS NULL OR `cantidad` > 0),
  CONSTRAINT `chk_marketing_evento_valor` CHECK (`valor` IS NULL OR `valor` >= 0),
  CONSTRAINT `fk_marketing_evento_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_marketing_evento_sesion`
    FOREIGN KEY (`marketing_sesion_id`) REFERENCES `marketing_sesion` (`id`),
  CONSTRAINT `fk_marketing_evento_producto`
    FOREIGN KEY (`producto_id`) REFERENCES `producto` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_marketing_evento_pedido`
    FOREIGN KEY (`pedido_unificado_id`) REFERENCES `pedido_unificado` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `pedido_marketing_atribucion` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `pedido_unificado_id` INT NOT NULL,
  `marketing_sesion_id` INT NOT NULL,
  `campana_id` INT NULL,
  `origen` ENUM('campana','receta') NOT NULL,
  `receta_codigo` VARCHAR(64) NULL,
  `modelo` ENUM('first_touch','last_touch') NOT NULL DEFAULT 'last_touch',
  `revenue_atribuido` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `descuento_atribuido` DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pedido_marketing_atrib_rest_pedido` (`restaurante_id`, `pedido_unificado_id`),
  KEY `idx_pedido_marketing_atrib_sesion` (`marketing_sesion_id`),
  KEY `idx_pedido_marketing_atrib_campana_fecha` (`restaurante_id`, `campana_id`, `created_at`),
  CONSTRAINT `chk_pedido_marketing_atrib_revenue` CHECK (`revenue_atribuido` >= 0),
  CONSTRAINT `chk_pedido_marketing_atrib_descuento` CHECK (`descuento_atribuido` >= 0),
  CONSTRAINT `fk_pedido_marketing_atrib_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_pedido_marketing_atrib_pedido`
    FOREIGN KEY (`pedido_unificado_id`) REFERENCES `pedido_unificado` (`id`),
  CONSTRAINT `fk_pedido_marketing_atrib_sesion`
    FOREIGN KEY (`marketing_sesion_id`) REFERENCES `marketing_sesion` (`id`),
  CONSTRAINT `fk_pedido_marketing_atrib_campana`
    FOREIGN KEY (`campana_id`) REFERENCES `marketing_campana` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- POSTCHECKS (sólo lectura):
--
-- 1. Las cuatro tablas deben existir (resultado esperado: 4).
-- SELECT COUNT(*) AS tablas_growth
-- FROM information_schema.TABLES
-- WHERE TABLE_SCHEMA = DATABASE()
--   AND TABLE_NAME IN ('marketing_campana', 'marketing_sesion',
--     'marketing_evento', 'pedido_marketing_atribucion');
--
-- 2. Conciliar claves foráneas (esperado: 3, 3, 4 y 4 respectivamente).
-- SELECT TABLE_NAME, COUNT(*) AS foreign_keys
-- FROM information_schema.TABLE_CONSTRAINTS
-- WHERE CONSTRAINT_SCHEMA = DATABASE()
--   AND CONSTRAINT_TYPE = 'FOREIGN KEY'
--   AND TABLE_NAME IN ('marketing_campana', 'marketing_sesion',
--     'marketing_evento', 'pedido_marketing_atribucion')
-- GROUP BY TABLE_NAME ORDER BY TABLE_NAME;
--
-- 3. Verificar unicidad/idempotencia por tenant (esperado: una fila por tabla).
-- SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columnas
-- FROM information_schema.STATISTICS
-- WHERE TABLE_SCHEMA = DATABASE() AND NON_UNIQUE = 0
--   AND INDEX_NAME LIKE 'uq_%marketing%'
-- GROUP BY TABLE_NAME, INDEX_NAME ORDER BY TABLE_NAME, INDEX_NAME;
--
-- 4. `pedido_unificado` no debe tener columnas Growth (esperado: 0).
-- SELECT COUNT(*) AS columnas_marketing_en_pedido
-- FROM information_schema.COLUMNS
-- WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pedido_unificado'
--   AND (COLUMN_NAME LIKE 'marketing_%' OR COLUMN_NAME LIKE '%campana%');
