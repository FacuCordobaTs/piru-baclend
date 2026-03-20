-- Checkout: toggles para ocultar tarjeta o transferencia sin desconectar integraciones
ALTER TABLE `restaurante`
ADD COLUMN `cucuru_enabled` BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN `cards_payments_enabled` BOOLEAN NOT NULL DEFAULT TRUE;
