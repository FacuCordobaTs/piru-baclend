
CREATE TABLE `config_motor_recompra` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurante_id` INT NOT NULL UNIQUE,
  `estado` VARCHAR(20) NOT NULL DEFAULT 'activa',
  `modo` VARCHAR(20) NOT NULL DEFAULT 'automatico',
  `cupo_diario` INT NOT NULL DEFAULT 30,
  `dias_toque_2` INT NOT NULL DEFAULT 2,
  `dias_toque_3` INT NOT NULL DEFAULT 2,
  `porcentaje_control` INT NOT NULL DEFAULT 10,
  `ultimo_drenaje_dia` VARCHAR(10) NULL,
  `aviso_sin_saldo_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE `campana_recompra`
  ADD COLUMN `origen` VARCHAR(20) NOT NULL DEFAULT 'goteo' AFTER `modo`,
  ADD COLUMN `segmento` VARCHAR(20) NULL AFTER `origen`,
  ADD COLUMN `cantidad_objetivo` INT NULL AFTER `segmento`,
  ADD COLUMN `toque_hasta` TINYINT NOT NULL DEFAULT 1 AFTER `cantidad_objetivo`,
  ADD COLUMN `dias_toque_2` INT NULL AFTER `toque_hasta`,
  ADD COLUMN `dias_toque_3` INT NULL AFTER `dias_toque_2`,
  ADD COLUMN `porcentaje_control` INT NULL AFTER `dias_toque_3`,
  ADD COLUMN `programada_at` TIMESTAMP NULL AFTER `porcentaje_control`;

CREATE INDEX `idx_cola_recompra_restaurante_enviado` ON `cola_recompra` (`restaurante_id`, `enviado_at`);

INSERT INTO `config_motor_recompra`
  (`restaurante_id`, `estado`, `modo`, `cupo_diario`, `aviso_sin_saldo_at`)
SELECT c.`restaurante_id`,
       CASE c.`estado`
         WHEN 'pausada_manual' THEN 'pausada_manual'
         WHEN 'pausada_sin_saldo' THEN 'pausada_sin_saldo'
         ELSE 'activa'
       END,
       c.`modo`, c.`cupo_diario`, c.`aviso_sin_saldo_at`
  FROM `campana_recompra` c
  JOIN (
    SELECT `restaurante_id`, MAX(`id`) AS `id`
      FROM `campana_recompra`
     WHERE `estado` IS NOT NULL
     GROUP BY `restaurante_id`
  ) ult ON ult.`id` = c.`id`
 WHERE NOT EXISTS (
   SELECT 1 FROM `config_motor_recompra` k WHERE k.`restaurante_id` = c.`restaurante_id`
 );

UPDATE `campana_recompra` SET `estado` = 'activa'
 WHERE `origen` = 'goteo' AND `estado` IN ('pausada_sin_saldo', 'pausada_manual');
