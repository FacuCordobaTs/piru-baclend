-- Non-destructive: new JSON column + widen metodo_pago + notificacion enum value.
-- Run manually against production MySQL when deploying.

ALTER TABLE restaurante
  ADD COLUMN metodos_pago_config JSON NULL
  AFTER transferencia_alias;

ALTER TABLE pedido_unificado
  MODIFY COLUMN metodo_pago VARCHAR(64) NULL;

ALTER TABLE notificacion
  MODIFY COLUMN tipo ENUM(
    'NUEVO_PEDIDO',
    'NUEVO_PEDIDO_PENDIENTE_PAGO',
    'PEDIDO_CONFIRMADO',
    'PEDIDO_CERRADO',
    'LLAMADA_MOZO',
    'PAGO_RECIBIDO',
    'PRODUCTO_AGREGADO'
  ) NOT NULL;
