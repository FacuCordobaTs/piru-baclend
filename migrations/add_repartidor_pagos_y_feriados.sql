-- Pagos de cadetes y calendario de feriados.
--
-- Cada repartidor guarda cuatro importes para que el panel pueda liquidar lo que
-- se le paga en un período: un monto por envío asignado y un fijo por día
-- trabajado, distinto según sea hábil, fin de semana o feriado. Los nacionales
-- se calculan por ley en el backend; `feriado` guarda sólo los que el local
-- declara (puentes turísticos, feriados locales) y no se pisa al reaplicar.
--
-- PRECONDICIÓN: backup lógico verificado. DDL en MySQL se confirma implícito.
-- Aplicar antes de desplegar el backend que lee las columnas y la tabla.

ALTER TABLE `repartidor`
  ADD COLUMN `precio_envio` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `estado`,
  ADD COLUMN `pago_dia_habil` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `precio_envio`,
  ADD COLUMN `pago_fin_de_semana` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `pago_dia_habil`,
  ADD COLUMN `pago_feriado` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `pago_fin_de_semana`;

CREATE TABLE IF NOT EXISTS `feriado` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `fecha` DATE NOT NULL,
  `nombre` VARCHAR(255) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_feriado_restaurante_fecha` (`restaurante_id`, `fecha`),
  CONSTRAINT `fk_feriado_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE
);
