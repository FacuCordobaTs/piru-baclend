-- Link de recarga con SELECCIÓN de pack (aviso de saldo bajo por WhatsApp al dueño).
-- La recarga nace SIN pack definido (packRecargaId/cantidad/monto en 0); la página pública
-- /pago/:token muestra los packs y recién al elegir uno se fija el pack y se crea la
-- preferencia de MercadoPago. Aditivo y retrocompatible: las recargas existentes quedan
-- con seleccion_pack = 0 (link ya resuelto, comportamiento actual).
ALTER TABLE recarga_mensajes
  ADD COLUMN seleccion_pack TINYINT(1) NOT NULL DEFAULT 0;

-- Flag anti-reenvío del aviso por WhatsApp al dueño cuando el saldo utility está bajo
-- (plantilla saldo_bajo_v1). Nivel del último aviso enviado este ciclo: NULL = no se avisó,
-- 1 = 80% del cupo consumido, 2 = 95%, 3 = saldo agotado (<= 0). Se resetea a NULL al
-- renovar el ciclo. Progresión 1→2→3: máximo 3 avisos por ciclo.
ALTER TABLE saldo_mensajes
  ADD COLUMN aviso_saldo_bajo_nivel INT NULL;
