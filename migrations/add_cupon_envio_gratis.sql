-- El valor se guarda en 0 para envío gratis: se bonifica el costo real del envío.
ALTER TABLE codigo_descuento
  MODIFY COLUMN tipo ENUM('porcentaje', 'monto_fijo', 'envio_gratis') NOT NULL;
