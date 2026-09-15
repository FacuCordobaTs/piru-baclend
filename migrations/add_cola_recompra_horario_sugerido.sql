-- Migración: add_cola_recompra_horario_sugerido.sql
-- Agrega columna horario_sugerido para indicar el día y hora óptimo de envío (ej: "Viernes 21:00 hs (habitual)" o "Martes 20:00 hs (día valle)").

ALTER TABLE cola_recompra ADD COLUMN horario_sugerido VARCHAR(100) NULL AFTER due_date;

