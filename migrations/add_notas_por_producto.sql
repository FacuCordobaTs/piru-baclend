-- Configuración opt-in del paso de nota y snapshot de la aclaración por ítem.
-- Aditiva: los productos existentes mantienen el paso desactivado.
ALTER TABLE producto
  ADD COLUMN permite_nota BOOLEAN NOT NULL DEFAULT FALSE AFTER titulo_extras_secundarios,
  ADD COLUMN titulo_nota VARCHAR(120) NOT NULL DEFAULT '¿Querés aclarar algo?' AFTER permite_nota;

ALTER TABLE item_pedido_unificado
  ADD COLUMN nota VARCHAR(500) NULL AFTER agregados;
