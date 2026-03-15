-- Fix takeaway: el webhook matcheaba delivery#N en vez de takeaway#N (mismo id, distinta tabla).
-- tipo_pedido indica qué tabla consultar primero. NULL = legacy, busca delivery primero.
ALTER TABLE account_pool ADD COLUMN tipo_pedido ENUM('delivery', 'takeaway') NULL AFTER pedido_id_asignado;
