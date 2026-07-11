-- Registro self-serve por WhatsApp (OTP).
-- 1) email y password pasan a ser nullable: las cuentas creadas por WhatsApp no los tienen.
-- 2) Se agrega telefono_verificado para marcar cuentas verificadas por código.
-- 3) Nueva tabla registro_telefono: sesiones de verificación (una por UUID).

ALTER TABLE `restaurante`
  MODIFY COLUMN `email` VARCHAR(255) NULL,
  MODIFY COLUMN `password` VARCHAR(255) NULL,
  ADD COLUMN `telefono_verificado` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `registro_telefono` (
  `id` VARCHAR(36) NOT NULL,
  `telefono` VARCHAR(50) NOT NULL,
  `nombre` VARCHAR(255) NULL,
  `codigo_hash` VARCHAR(255) NOT NULL,
  `intentos` INT NOT NULL DEFAULT 0,
  `verificado` BOOLEAN NOT NULL DEFAULT false,
  `restaurante_id` INT NULL,
  `expira_en` TIMESTAMP NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_registro_telefono_restaurante` FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);

CREATE INDEX `idx_registro_telefono_telefono` ON `registro_telefono` (`telefono`);
