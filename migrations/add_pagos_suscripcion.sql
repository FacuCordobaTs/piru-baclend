-- Migration: pagos de la cuota mensual del plan (suscripción) vía Checkout Pro.
-- NO usamos las suscripciones recurrentes de MercadoPago: cada cobro es un pago
-- único que paga a la cuenta de la plataforma (Piru) y extiende la suscripción
-- un ciclo. Depende de add_planes_suscripciones.sql (tablas plan / suscripcion).
-- Ejecutar en MySQL (prod). Si algo ya existe, omitir la sentencia que falle.

CREATE TABLE IF NOT EXISTS `pago_suscripcion` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `plan_id` INT NOT NULL,
  `ciclo_pago` ENUM('mensual','anual') NOT NULL DEFAULT 'mensual',
  `monto` DECIMAL(10,2) NOT NULL,
  `periodo_desde` TIMESTAMP NULL DEFAULT NULL,
  `periodo_hasta` TIMESTAMP NULL DEFAULT NULL,
  `estado_pago_suscripcion` ENUM('pending','paid','failed') NOT NULL DEFAULT 'pending',
  `mp_preference_id` VARCHAR(255) DEFAULT NULL,
  `mp_payment_id` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pago_suscripcion_restaurante` (`restaurante_id`),
  CONSTRAINT `fk_pago_suscripcion_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`),
  CONSTRAINT `fk_pago_suscripcion_plan` FOREIGN KEY (`plan_id`) REFERENCES `plan` (`id`)
);
