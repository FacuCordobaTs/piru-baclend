-- Migración para agregar la tabla pago_subtotal (split payment)
-- Esta tabla trackea los pagos individuales de cada cliente en un pedido

CREATE TABLE IF NOT EXISTS `pago_subtotal` (
  `id` INT PRIMARY KEY AUTO_INCREMENT,
  `pedido_id` INT NOT NULL,
  `pago_id` INT NULL,
  `cliente_nombre` VARCHAR(100) NOT NULL,
  `monto` DECIMAL(10, 2) NOT NULL,
  `estado` ENUM('pending', 'paid', 'failed') DEFAULT 'pending',
  `metodo` ENUM('efectivo', 'mercadopago') NOT NULL,
  `mp_payment_id` VARCHAR(255) NULL,
  `mp_preference_id` VARCHAR(255) NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX `idx_pago_subtotal_pedido` (`pedido_id`),
  INDEX `idx_pago_subtotal_cliente` (`cliente_nombre`),
  INDEX `idx_pago_subtotal_estado` (`estado`),
  INDEX `idx_pago_subtotal_mp_payment` (`mp_payment_id`)
);

-- Comentario: Esta tabla permite implementar split payment donde cada cliente
-- puede pagar su parte del pedido individualmente


