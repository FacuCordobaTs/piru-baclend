-- Motor de Recompra · observabilidad operativa
-- Agrega a la cola los datos mínimos para auditar despachos automáticos y
-- contactos manuales desde una única fuente.

ALTER TABLE `cola_recompra`
  ADD COLUMN `plantilla_whatsapp` VARCHAR(100) NULL AFTER `enviado_at`,
  ADD COLUMN `origen_contacto` VARCHAR(20) NOT NULL DEFAULT 'automatico' AFTER `plantilla_whatsapp`,
  ADD COLUMN `ultimo_intento_at` TIMESTAMP NULL AFTER `origen_contacto`,
  ADD COLUMN `error_envio` VARCHAR(500) NULL AFTER `ultimo_intento_at`;

CREATE INDEX `idx_cola_recompra_historial`
  ON `cola_recompra` (`restaurante_id`, `campana_id`, `estado`, `ultimo_intento_at`);
