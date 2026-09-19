-- Motor de Recompra · toques 1, 2 y 3 (goteo de hasta 3 contactos por cliente)
--
-- Hasta ahora el motor contactaba a cada cliente UNA sola vez: `sincronizarFlujo` excluía a
-- cualquiera que ya tuviera una fila en la campaña viva, y los toques 2 y 3 existían sólo como
-- acción voluntaria del operador, cliente por cliente. Ahora el motor vuelve a encolar al cliente
-- cuando pasó el cooldown de 48 hs y le quedan toques, así que la fila de la cola tiene que saber
-- QUÉ TOQUE es (mientras está `pendiente` no hay `nivel` —se escribe recién al enviar— ni fila en
-- `recupero_cliente`, así que el toque no se puede reconstruir después).
--
-- Aditiva y retrocompatible: todo lo existente queda como toque 1.

-- ── 1. cola_recompra: qué toque es la fila y con qué link/descuento salió ────────────────────────
ALTER TABLE `cola_recompra`
  -- 1..3. NULL sólo en el grupo de control, que nunca recibe toques.
  ADD COLUMN `toque` TINYINT NULL AFTER `nivel`,
  -- 'lo_mismo' | 'reactivacion'. Se registra porque `lo_mismo` NUNCA lleva descuento: sin esto el
  -- invariante no es auditable una vez enviado.
  ADD COLUMN `link_modalidad` VARCHAR(20) NULL AFTER `toque`,
  -- % efectivamente aplicado en ese envío (0 = sin descuento). Puede diferir del escalón si el
  -- operador forzó otro a mano.
  ADD COLUMN `descuento_enviado` INT NULL AFTER `link_modalidad`;

-- Lo ya enviado conserva su escalón como toque; lo pendiente es, por definición, el 1º.
UPDATE `cola_recompra` SET `toque` = GREATEST(1, LEAST(3, `nivel`))
  WHERE `toque` IS NULL AND `nivel` IS NOT NULL;
UPDATE `cola_recompra` SET `toque` = 1
  WHERE `toque` IS NULL AND `rol` = 'contactado';

-- ── 2. recupero_cliente: el ledger inmutable de qué copy se mandó ────────────────────────────────
-- `nivel` sigue siendo la autoridad del avance de la escalera; `toque` es el tramo que el operador
-- eligió. Difieren SÓLO en el envío manual forzado, y esa divergencia es justo lo que hay que auditar.
ALTER TABLE `recupero_cliente`
  ADD COLUMN `toque` TINYINT NULL AFTER `nivel`,
  ADD COLUMN `modalidad` VARCHAR(20) NULL AFTER `segmento`;

UPDATE `recupero_cliente` SET `toque` = GREATEST(1, LEAST(3, `nivel`)) WHERE `toque` IS NULL;

-- ── 3. POSTCHECK — correr ANTES del índice único; si devuelve filas, deduplicar primero ──────────
-- El motor viejo no podía generar duplicados (excluía a todo cliente con cualquier fila), pero un
-- contacto manual y una sincronización concurrente sí. Si hay filas, quedarse con la de menor `id`.
--
-- SELECT `campana_id`, `cliente_id`, `toque`, COUNT(*) AS `dup`, GROUP_CONCAT(`id`) AS `ids`
--   FROM `cola_recompra` WHERE `toque` IS NOT NULL
--   GROUP BY `campana_id`, `cliente_id`, `toque` HAVING `dup` > 1;

-- ── 4. Garantía de idempotencia del reencolado ───────────────────────────────────────────────────
-- Un cliente no puede tener dos filas del mismo toque en la misma campaña. Es lo que hace imposible
-- el bucle (y lo que protege de dos sincronizaciones concurrentes desde los GET de la UI: la segunda
-- recibe ER_DUP_ENTRY y lo ignora). El control queda con `toque` NULL y MySQL admite múltiples NULL
-- en un índice único, así que no colisiona.
CREATE UNIQUE INDEX `uq_cola_recompra_toque`
  ON `cola_recompra` (`campana_id`, `cliente_id`, `toque`);
