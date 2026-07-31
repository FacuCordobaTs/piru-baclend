-- Migration: packs de recarga comprables + estado de pago en recarga_mensajes.
-- Depende de add_planes_suscripciones.sql (tabla recarga_mensajes ya creada).
-- Ejecutar en MySQL (prod). Si algo ya existe, omitir la sentencia que falle.

-- Packs de recarga (producto comprable, prepago). Precio editable sin deploy.
CREATE TABLE IF NOT EXISTS `pack_recarga` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `categoria_pack` ENUM('utility','marketing') NOT NULL DEFAULT 'utility',
  `nombre` VARCHAR(255) NOT NULL,
  `cantidad` INT NOT NULL,
  `precio` DECIMAL(10,2) NOT NULL,
  `orden` INT NOT NULL DEFAULT 0,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- Estado de pago + referencias MP + pack de origen sobre las compras de recarga.
ALTER TABLE `recarga_mensajes`
  ADD COLUMN `pack_recarga_id` INT NULL DEFAULT NULL,
  ADD COLUMN `estado_recarga` ENUM('pending','paid','failed') NOT NULL DEFAULT 'paid',
  ADD COLUMN `mp_preference_id` VARCHAR(255) DEFAULT NULL,
  ADD COLUMN `mp_payment_id` VARCHAR(255) DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- Seed: 3 packs utility. Precio = variable a calibrar (por encima del costo real
-- por mensaje y ~un orden de magnitud por debajo del salto de plan de $60.000).
-- ---------------------------------------------------------------------------
INSERT INTO `pack_recarga` (`categoria_pack`, `nombre`, `cantidad`, `precio`, `orden`, `activo`)
VALUES
  ('utility', 'Recarga 500',   500,   6000.00,  1, true),
  ('utility', 'Recarga 1.000', 1000, 11000.00,  2, true),
  ('utility', 'Recarga 2.500', 2500, 25000.00,  3, true);
