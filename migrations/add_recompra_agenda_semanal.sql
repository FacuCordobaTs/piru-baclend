ALTER TABLE config_motor_recompra ADD COLUMN toque_hasta TINYINT NOT NULL DEFAULT 3;
ALTER TABLE cola_recompra
  ADD COLUMN toque_enviado TINYINT NULL,
  ADD COLUMN dia_semana TINYINT NULL,
  ADD COLUMN minuto_dia INT NULL,
  ADD COLUMN ciclo VARCHAR(40) NOT NULL DEFAULT 'inicial',
  ADD COLUMN tipo_mensaje VARCHAR(20) NOT NULL DEFAULT 'recompra',
  ADD COLUMN mensaje_personalizado TEXT NULL;
ALTER TABLE marketing_campana ADD COLUMN dia_semana TINYINT NULL;
SET @agenda_tz_anterior = @@session.time_zone;
SET time_zone = '-03:00';
UPDATE cola_recompra SET dia_semana = DAYOFWEEK(due_date) - 1,
  minuto_dia = HOUR(due_date) * 60 + MINUTE(due_date)
WHERE due_date IS NOT NULL;
UPDATE cola_recompra q JOIN campana_recompra c ON c.id = q.campana_id AND c.restaurante_id = q.restaurante_id
SET q.tipo_mensaje = 'dia_flojo', q.mensaje_personalizado = c.mensaje_personalizado
WHERE c.origen = 'dia_flojo';
UPDATE cola_recompra SET toque_enviado = toque WHERE enviado_at IS NOT NULL;
SET time_zone = @agenda_tz_anterior;
ALTER TABLE cola_recompra DROP INDEX uq_cola_recompra_toque,
  ADD UNIQUE INDEX uq_cola_recompra_toque(campana_id, cliente_id, ciclo, toque),
  ADD INDEX idx_cola_recompra_semana(restaurante_id, estado, dia_semana);
UPDATE config_motor_recompra SET estado = 'activa';
UPDATE campana_recompra SET estado = 'activa' WHERE estado IN ('pausada_manual', 'pausada_sin_saldo');
