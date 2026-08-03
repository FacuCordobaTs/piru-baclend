-- Motor de Recompra · 4.5 — Protección de la base.
-- Opt-out de mensajes de MARKETING por cliente (recupero/campañas). Es aditivo y retrocompatible:
-- por default nadie está dado de baja (marketing_opt_out = false). No toca los mensajes
-- transaccionales (pedido/pago), que siempre salen.
--
-- El tope de mensajes por cliente/mes y los horarios de silencio NO necesitan columnas: se
-- derivan del ledger existente (recupero_cliente.created_at) y de la hora del envío. Viven como
-- config en Backend/src/lib/proteccion-base.ts.

ALTER TABLE cliente
  ADD COLUMN marketing_opt_out TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN marketing_opt_out_at TIMESTAMP NULL DEFAULT NULL;
