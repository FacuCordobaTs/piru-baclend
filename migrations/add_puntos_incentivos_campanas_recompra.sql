-- Puntos como incentivo de campañas y del Motor de Recompra.
--
-- ADITIVA: no recrea tablas ni modifica filas existentes. Aplicar ANTES de desplegar el
-- backend que lee/escribe estas columnas. Las columnas de puntos bonus nacen en 0/NULL, así
-- que el código anterior sigue operando sin cambios si la migración se adelanta.
--
-- Reglas que soporta:
--   · marketing_campana puede ofrecer puntos extra en vez de una oferta de producto;
--   · pedido_unificado guarda el bonus ya validado al crear el pedido (se acredita al cobrar);
--   · transaccion_puntos registra el bonus con idempotencia y campaña;
--   · configuracion_puntos define el techo de margen, el máximo por pedido y el cupo por cliente;
--   · recupero_cliente y cola_recompra auditan qué se mandó en cada toque.

-- 1. El ledger acepta el nuevo tipo de movimiento.
ALTER TABLE `transaccion_puntos`
  MODIFY COLUMN `tipo` ENUM(
    'suma_compra',
    'canje_producto',
    'canje_envio',
    'canje_descuento',
    'bonus_bienvenida',
    'bonus_promocion',
    'ajuste_manual',
    'devolucion_cancelacion',
    'expiracion'
  ) NOT NULL;

ALTER TABLE `transaccion_puntos`
  ADD COLUMN `marketing_campana_id` INT NULL DEFAULT NULL AFTER `pedido_unificado_id`,
  ADD COLUMN `clave_idempotencia` VARCHAR(128) NULL DEFAULT NULL AFTER `marketing_campana_id`,
  ADD INDEX `idx_transaccion_puntos_campana` (`restaurante_id`, `marketing_campana_id`, `created_at`),
  ADD UNIQUE INDEX `uq_transaccion_puntos_idempotencia` (`restaurante_id`, `clave_idempotencia`);

-- 2. Campaña: beneficio de puntos y sus límites (independientes de la oferta de producto).
ALTER TABLE `marketing_campana`
  ADD COLUMN `beneficio_tipo` ENUM('descuento', 'puntos') NOT NULL DEFAULT 'descuento' AFTER `descuento_producto_porcentaje`,
  ADD COLUMN `puntos_beneficio` INT NOT NULL DEFAULT 0 AFTER `beneficio_tipo`,
  ADD COLUMN `puntos_monto_minimo` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `puntos_beneficio`,
  ADD COLUMN `puntos_limite_otorgamientos` INT NULL DEFAULT NULL AFTER `puntos_monto_minimo`,
  ADD COLUMN `puntos_limite_por_cliente` INT NOT NULL DEFAULT 1 AFTER `puntos_limite_otorgamientos`;

-- 3. Pedido: el bonus resuelto en el alta, para acreditarlo cuando se cobra.
ALTER TABLE `pedido_unificado`
  ADD COLUMN `puntos_bonus` INT NOT NULL DEFAULT 0 AFTER `descuento_puntos`,
  ADD COLUMN `puntos_bonus_origen` VARCHAR(20) NULL DEFAULT NULL AFTER `puntos_bonus`,
  ADD COLUMN `puntos_bonus_clave` VARCHAR(128) NULL DEFAULT NULL AFTER `puntos_bonus_origen`,
  ADD INDEX `idx_pedido_unificado_puntos_bonus_clave` (`puntos_bonus_clave`),
  ADD INDEX `idx_pedido_unificado_puntos_bonus` (`restaurante_id`, `marketing_campana_id`, `puntos_bonus`);

-- 4. Configuración del club: los guardarraíles del bonus.
ALTER TABLE `configuracion_puntos`
  ADD COLUMN `puntos_bonus_tope_porcentaje` INT NOT NULL DEFAULT 12 AFTER `vencimiento_dias`,
  ADD COLUMN `puntos_bonus_maximo` INT NOT NULL DEFAULT 500 AFTER `puntos_bonus_tope_porcentaje`,
  ADD COLUMN `puntos_bonus_por_cliente_30_dias` INT NOT NULL DEFAULT 2 AFTER `puntos_bonus_maximo`;

-- 5. Auditoría de los envíos de recompra.
ALTER TABLE `recupero_cliente`
  ADD COLUMN `puntos_otorgados` INT NOT NULL DEFAULT 0 AFTER `descuento_porcentaje`,
  ADD COLUMN `beneficio_tipo` VARCHAR(20) NULL DEFAULT NULL AFTER `puntos_otorgados`;

ALTER TABLE `cola_recompra`
  ADD COLUMN `puntos_otorgados` INT NOT NULL DEFAULT 0 AFTER `descuento_enviado`,
  ADD COLUMN `beneficio_tipo` VARCHAR(20) NULL DEFAULT NULL AFTER `puntos_otorgados`;
