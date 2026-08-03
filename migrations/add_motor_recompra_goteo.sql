-- Motor de Recompra · goteo (piloto automático)
-- Rediseño: de "batch masivo por click" a CAMPAÑA PERSISTENTE que gotea al ritmo del cupo diario.
--
-- 1) `campana_recompra` pasa a ser (además del historial batch legacy) la campaña viva del local:
--    una fila con `estado` no-null = campaña activa/pausada. Se agregan cupo/contadores del goteo.
-- 2) `cola_recompra` (NUEVA): la cola de envíos que el job diario drena (flujo + stock).
--
-- Todo aditivo: nada existente se elimina ni cambia de tipo. Correr en la VPS antes de deployar.

-- ── 1. Campos del goteo en campana_recompra ──────────────────────────────────
ALTER TABLE `campana_recompra`
  ADD COLUMN `estado` VARCHAR(20) NULL,
  ADD COLUMN `cupo_diario` INT NOT NULL DEFAULT 30,
  ADD COLUMN `dia_contador` VARCHAR(10) NULL,
  ADD COLUMN `enviados_hoy` INT NOT NULL DEFAULT 0,
  ADD COLUMN `total_enviados` INT NOT NULL DEFAULT 0,
  ADD COLUMN `aviso_sin_saldo_at` TIMESTAMP NULL,
  ADD COLUMN `activada_at` TIMESTAMP NULL,
  ADD COLUMN `pausada_at` TIMESTAMP NULL;

-- Índice para encontrar rápido la campaña activa de un local (job diario + estado del motor).
CREATE INDEX `idx_campana_recompra_estado` ON `campana_recompra` (`restaurante_id`, `estado`);

-- ── 2. Cola de envíos ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `cola_recompra` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `campana_id` INT NOT NULL,
  `cliente_id` INT NOT NULL,
  `telefono` VARCHAR(50) NULL,
  `segmento` VARCHAR(20) NULL,
  `prioridad` DECIMAL(14,2) NULL DEFAULT 0.00,
  `poblacion` VARCHAR(10) NOT NULL,
  `rol` VARCHAR(20) NOT NULL DEFAULT 'contactado',
  `due_date` TIMESTAMP NULL,
  `estado` VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  `nivel` INT NULL,
  `codigo_descuento` VARCHAR(50) NULL,
  `enviado_at` TIMESTAMP NULL,
  `total_gastado_snapshot` DECIMAL(12,2) NULL DEFAULT 0.00,
  `ultimo_pedido_at_snapshot` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_cola_recompra_campana` (`campana_id`),
  KEY `idx_cola_recompra_drenar` (`restaurante_id`, `estado`, `due_date`),
  KEY `idx_cola_recompra_cliente` (`restaurante_id`, `cliente_id`),
  CONSTRAINT `fk_cola_recompra_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_cola_recompra_campana` FOREIGN KEY (`campana_id`) REFERENCES `campana_recompra` (`id`),
  CONSTRAINT `fk_cola_recompra_cliente` FOREIGN KEY (`cliente_id`) REFERENCES `cliente` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
