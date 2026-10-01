-- Conexión de cada local con la aplicación de Mercado Pago creada para "Código QR" (pagos presenciales).
--
-- Mercado Pago crea cada aplicación para UNA solución (pagos online o pagos presenciales) y, para un QR
-- de terceros, exige el OAuth (Authorization code) de la aplicación de QR. Los tokens de la aplicación
-- online siguen en `restaurante.mp_*`; los de QR viven acá, uno por local.
--
-- ADITIVA: sólo crea una tabla nueva (no toca `restaurante` ni nada existente). Aplicar ANTES de
-- desplegar el backend que la consume, junto con `add_pos_cobros_qr_mercadopago.sql`.
--
-- Los instantes (`expira_at`, `created_at`, `updated_at`) los escribe la aplicación con Drizzle y son
-- DATETIME (sin conversión de zona), igual que en `pos_cobro_qr`. Nunca compararlos en SQL con NOW().
--
-- PRECONDICIÓN: backup lógico verificado antes de ejecutar (MySQL confirma DDL de forma implícita).
-- `CREATE TABLE IF NOT EXISTS` hace la migración reintentable.

CREATE TABLE IF NOT EXISTS `mp_conexion_qr` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `restaurante_id` INT NOT NULL,
  `mp_user_id` VARCHAR(50) NOT NULL,
  `access_token` VARCHAR(512) NOT NULL,
  `refresh_token` VARCHAR(512) NULL DEFAULT NULL,
  `scope` VARCHAR(255) NULL DEFAULT NULL,
  `expira_at` DATETIME NULL DEFAULT NULL,
  `conectado` BOOLEAN NOT NULL DEFAULT true,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_mp_conexion_qr_restaurante` (`restaurante_id`),
  CONSTRAINT `fk_mp_conexion_qr_restaurante`
    FOREIGN KEY (`restaurante_id`) REFERENCES `restaurante` (`id`)
);
