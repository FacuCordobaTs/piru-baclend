-- Actualiza el precio comercial vigente de la suscripción base Piru.
--
-- Los comprobantes y suscripciones existentes conservan sus snapshots para
-- auditoría. Los próximos checkouts toman siempre este valor del catálogo.
UPDATE `configuracion_suscripcion`
SET `precio_mensual` = 40000.00,
    `updated_at` = CURRENT_TIMESTAMP
WHERE `codigo` = 'piru'
  AND `precio_mensual` <> 40000.00;
