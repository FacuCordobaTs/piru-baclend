-- Add cliente_telefono and cliente_id to item_pedido_unificado
ALTER TABLE item_pedido_unificado ADD COLUMN cliente_telefono VARCHAR(50) NULL;
ALTER TABLE item_pedido_unificado ADD COLUMN cliente_id INT NULL;
ALTER TABLE item_pedido_unificado ADD CONSTRAINT fk_item_pedido_unificado_cliente FOREIGN KEY (cliente_id) REFERENCES cliente(id) ON DELETE SET NULL;

-- Add cliente_telefono to item_pedido (legacy mesa)
ALTER TABLE item_pedido ADD COLUMN cliente_telefono VARCHAR(50) NULL;
