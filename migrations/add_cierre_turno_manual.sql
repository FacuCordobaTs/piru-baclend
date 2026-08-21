-- Módulo incluido: cierre manual de turnos operativos.
-- Aditiva e idempotente: no modifica pedidos ni el cierre diario legacy.

CREATE TABLE IF NOT EXISTS `turno_caja` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `apertura_at` TIMESTAMP NOT NULL,
  `cierre_at` TIMESTAMP NULL DEFAULT NULL,
  `abierto` BOOLEAN NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_turno_caja_restaurante_apertura` (`restaurante_id`, `apertura_at`),
  KEY `idx_turno_caja_restaurante_cierre` (`restaurante_id`, `cierre_at`),
  UNIQUE KEY `uq_turno_caja_un_abierto` (`restaurante_id`, `abierto`),
  CONSTRAINT `fk_turno_caja_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`) ON DELETE CASCADE
);

INSERT INTO `modulo`
  (`codigo`, `categoria_id`, `nombre`, `descripcion`, `tipo_modulo`, `precio_mensual`,
   `mensajes_utility_incluidos`, `mensajes_marketing_incluidos`, `estado_producto`,
   `activable`, `icono`, `orden`, `activo`)
SELECT 'cierre_turno_manual', c.id, 'Cerrar turno manualmente',
       'Agrupá la caja desde que abrís hasta que decidís cerrar, aunque el turno cruce la medianoche.',
       'incluido', 0.00, 0, 0, 'disponible', true, 'Clock3', 6, true
FROM `categoria_modulo` c
WHERE c.codigo = 'operacion_administracion'
ON DUPLICATE KEY UPDATE
  `categoria_id` = VALUES(`categoria_id`), `nombre` = VALUES(`nombre`),
  `descripcion` = VALUES(`descripcion`), `tipo_modulo` = VALUES(`tipo_modulo`),
  `estado_producto` = VALUES(`estado_producto`), `activable` = VALUES(`activable`),
  `icono` = VALUES(`icono`), `orden` = VALUES(`orden`), `activo` = true;
