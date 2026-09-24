-- Motor de Recompra · PROGRAMACIONES explícitas (adiós al goteo que se agenda solo)
--
-- Hasta ahora el motor era autónomo: `activarMotor` encendía UNA campaña persistente que después
-- goteaba sola, para siempre, y `sincronizarFlujo` detectaba clientes nuevos y reencolaba los toques
-- 2 y 3 por su cuenta en cada lectura. El dueño era espectador.
--
-- El modelo nuevo invierte eso: NADA sale si el dueño no programó la tanda. Cada "programación" es
-- una fila de `campana_recompra` con su especificación (a quiénes, cuántos, hasta qué toque y cada
-- cuánto), y sus envíos concretos son filas de `cola_recompra` con `dueDate`, que el tick único ya
-- sabe drenar. No se introduce ningún scheduler nuevo.
--
-- Consecuencias de diseño que explica este SQL:
--   1) La configuración (cupo, modo, pausa, intervalos) deja de ser de la campaña y pasa a ser DEL
--      LOCAL: con varias tandas corriendo a la vez, el cupo protege el número de WhatsApp del local,
--      no una tanda puntual. Por eso nace `config_motor_recompra` (una fila por restaurante, como
--      `configuracion_puntos`).
--   2) La pausa también sube al local. Un local pausado pausa TODO su goteo, no una tanda.
--   3) Las campañas viejas quedan como `origen = 'goteo'`: sus filas `pendiente` YA están agendadas y
--      se siguen drenando, pero no generan toques nuevos (`toque_hasta = 1`). El cambio no borra en
--      silencio lo que el motor viejo ya había prometido.
--
-- Aditiva y retrocompatible. Correr ANTES del deploy del backend nuevo.

-- ── 1. La configuración del motor sube al nivel del local ────────────────────────────────────────
-- Sigue la convención de `configuracion_puntos`: `restaurante_id` UNIQUE + defaults NOT NULL, para
-- que un local sin fila funcione igual (el código devuelve los defaults y no hace falta backfill).
CREATE TABLE `config_motor_recompra` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `restaurante_id` INT NOT NULL UNIQUE,
  -- 'activa' | 'pausada_manual' | 'pausada_sin_saldo' — la pausa es del LOCAL: pausa todo su goteo.
  `estado` VARCHAR(20) NOT NULL DEFAULT 'activa',
  -- 'automatico' (drena con Meta Cloud API, consume 1 crédito marketing) | 'manual' (el operador copia).
  `modo` VARCHAR(20) NOT NULL DEFAULT 'automatico',
  -- Techo de envíos por día del local. NO es una promesa: cada cliente cae en su día y horario
  -- recomendado, así que un lunes puede haber menos de `cupo_diario` contactables.
  `cupo_diario` INT NOT NULL DEFAULT 30,
  -- Días entre el 1º y el 2º toque, y entre el 2º y el 3º (default = los 48 hs de siempre).
  -- El piso de 48 hs es un INVARIANTE anti-spam: la configuración sólo puede estirarlo, nunca acortarlo.
  `dias_toque_2` INT NOT NULL DEFAULT 2,
  `dias_toque_3` INT NOT NULL DEFAULT 2,
  -- % del lote que se aparta como grupo de control (atribución honesta). No recibe toques ni gasta cupo.
  `porcentaje_control` INT NOT NULL DEFAULT 10,
  -- Último día de Argentina ("YYYY-MM-DD") en que el local drenó: sello operativo del goteo.
  `ultimo_drenaje_dia` VARCHAR(10) NULL,
  -- Aviso al dueño cuando el motor se pausa por saldo: uno solo, después 1 recordatorio por semana.
  `aviso_sin_saldo_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP NOT NULL
);

-- ── 2. La especificación de la tanda, dentro de la campaña ───────────────────────────────────────
-- Se agrega sobre `campana_recompra` en vez de crear una tabla nueva: la campaña YA trae grupo de
-- control, contadores y dashboard de atribución, y `cola_recompra.campana_id` + el índice único
-- `uq_cola_recompra_toque` (campaña, cliente, toque) siguen siendo la garantía anti-duplicado.
ALTER TABLE `campana_recompra`
  -- 'goteo' (campaña persistente legacy) | 'programada' (una tanda que el dueño programó).
  -- El default 'goteo' clasifica correctamente todo lo que ya existe.
  ADD COLUMN `origen` VARCHAR(20) NOT NULL DEFAULT 'goteo' AFTER `modo`,
  -- Segmento elegido en la tanda. NULL = "en general" (todos los segmentos recuperables).
  ADD COLUMN `segmento` VARCHAR(20) NULL AFTER `origen`,
  -- N que pidió el dueño: mensajes ENVIADOS. El grupo de control se aparta de los siguientes de la
  -- misma lista, así que no descuenta de N ni gasta cupo.
  ADD COLUMN `cantidad_objetivo` INT NULL AFTER `segmento`,
  -- Hasta qué toque llega la tanda (1 = sólo primeros toques, 2 = 1º y 2º, 3 = los tres).
  ADD COLUMN `toque_hasta` TINYINT NOT NULL DEFAULT 1 AFTER `cantidad_objetivo`,
  -- Overrides de espaciado de ESTA tanda. NULL = usa los días de `config_motor_recompra`.
  ADD COLUMN `dias_toque_2` INT NULL AFTER `toque_hasta`,
  ADD COLUMN `dias_toque_3` INT NULL AFTER `dias_toque_2`,
  -- Override del % de control de ESTA tanda. NULL = usa el del local.
  ADD COLUMN `porcentaje_control` INT NULL AFTER `dias_toque_3`,
  -- Cuándo se programó (la `activada_at` de las tandas nuevas; se conserva la vieja por compatibilidad).
  ADD COLUMN `programada_at` TIMESTAMP NULL AFTER `porcentaje_control`;

-- ── 3. Índice para el cupo compartido del día ────────────────────────────────────────────────────
-- El cupo del día ya no se lleva con contadores de campaña (driftgean cuando corren varias tandas):
-- se cuenta lo que REALMENTE salió, `COUNT(*) ... WHERE restaurante_id = ? AND enviado_at >= hoy`.
-- Ya existen `idx_cola_recompra_drenar` (restaurante_id, estado, due_date) y
-- `idx_campana_recompra_estado` (restaurante_id, estado); faltaba éste.
CREATE INDEX `idx_cola_recompra_restaurante_enviado` ON `cola_recompra` (`restaurante_id`, `enviado_at`);

-- ── 4. Backfill: la config arranca con lo que hoy vive en la campaña viva de cada local ──────────
-- Sin esto, un local que hoy tiene cupo 45 y modo manual volvería a los defaults (30 / automático)
-- en el primer tick y cambiaría de ritmo sin que nadie lo pidiera. Sólo se copia la campaña MÁS
-- RECIENTE por local (`ult.id`), que es la que `getCampanaActual` consideraba viva.
INSERT INTO `config_motor_recompra`
  (`restaurante_id`, `estado`, `modo`, `cupo_diario`, `aviso_sin_saldo_at`)
SELECT c.`restaurante_id`,
       CASE c.`estado`
         WHEN 'pausada_manual' THEN 'pausada_manual'
         WHEN 'pausada_sin_saldo' THEN 'pausada_sin_saldo'
         ELSE 'activa'
       END,
       c.`modo`, c.`cupo_diario`, c.`aviso_sin_saldo_at`
  FROM `campana_recompra` c
  JOIN (
    SELECT `restaurante_id`, MAX(`id`) AS `id`
      FROM `campana_recompra`
     WHERE `estado` IS NOT NULL
     GROUP BY `restaurante_id`
  ) ult ON ult.`id` = c.`id`
 WHERE NOT EXISTS (
   SELECT 1 FROM `config_motor_recompra` k WHERE k.`restaurante_id` = c.`restaurante_id`
 );

-- ── 5. La pausa deja de ser un estado de campaña y pasa a serlo del local ────────────────────────
-- Si no se normaliza, una campaña legacy 'pausada_manual' quedaría fuera de `esProcesable` para
-- siempre y su backlog pendiente se strandearía en silencio (ahora que nada lo vuelve a encolar).
-- Con esto, reanudar el local reanuda también ese backlog, que es lo que el dueño esperaba.
UPDATE `campana_recompra` SET `estado` = 'activa'
 WHERE `origen` = 'goteo' AND `estado` IN ('pausada_sin_saldo', 'pausada_manual');

-- ── 6. POSTCHECK — correr DESPUÉS de la migración ────────────────────────────────────────────────
-- Debe devolver: una config por cada local que tenía campaña viva, ninguna campaña en
-- 'pausada_*', y ninguna campaña `programada` (todavía no existe ninguna).
--
-- SELECT COUNT(*) AS `locales_con_config` FROM `config_motor_recompra`;
-- SELECT `estado`, COUNT(*) FROM `config_motor_recompra` GROUP BY `estado`;
-- SELECT `origen`, `estado`, COUNT(*) FROM `campana_recompra` GROUP BY `origen`, `estado`;
-- SELECT COUNT(*) AS `colas_pendientes_legacy`
--   FROM `cola_recompra` c JOIN `campana_recompra` k ON k.`id` = c.`campana_id`
--  WHERE k.`origen` = 'goteo' AND c.`estado` = 'pendiente';
