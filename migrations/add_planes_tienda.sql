-- Planes de tienda (estilo Tiendanube): Inicial, Esencial, Impulso, Escala y Evolución.
--
-- Un plan es un paquete de módulos. Los gates siguen siendo `requireModulo`: el plan sólo
-- decide qué módulos tiene el local (ver backend/src/lib/planes-tienda.ts y
-- docs/PLANES_TIENDA.md).
--
-- `restaurante.plan_tienda` nace con DEFAULT 'evolucion': todos los locales que ya existen
-- (y los que sigue creando interno o prospección) quedan en Evolución, que conserva EXACTAMENTE
-- la lógica anterior de suscripción y módulos (los 40.000 de siempre, sin restricciones nuevas).
-- Sólo el registro self-serve (`POST /api/auth/crear-tienda`) crea locales en 'inicial'.
--
-- Precios: datos, no constantes. Se cambian acá o con un UPDATE; NULL = precio a medida.
--
-- PRECONDICIÓN: backup lógico verificado. DDL en MySQL se confirma implícito.
-- Aplicar ANTES de desplegar el backend que lee `plan_tienda`. Es idempotente salvo el
-- ALTER TABLE (si la columna ya existe, saltear esa sentencia).

CREATE TABLE IF NOT EXISTS `plan_tienda` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `codigo` VARCHAR(32) NOT NULL,
  `nombre` VARCHAR(100) NOT NULL,
  `descripcion` VARCHAR(500) NULL,
  -- NULL = precio a medida (Evolución). 0 = gratis (Inicial).
  `precio_mensual` DECIMAL(10,2) NULL,
  `descuento_anual` INT NOT NULL DEFAULT 20,
  `orden` INT NOT NULL DEFAULT 0,
  `destacado` BOOLEAN NOT NULL DEFAULT false,
  -- Códigos de `modulo` que incluye el plan. Evolución no necesita lista: incluye todo.
  `modulos` JSON NOT NULL,
  -- Frases para la pantalla de planes (lo que se vende, no lo que se gatea).
  `beneficios` JSON NOT NULL,
  `activo` BOOLEAN NOT NULL DEFAULT true,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_plan_tienda_codigo` (`codigo`)
);

ALTER TABLE `restaurante`
  ADD COLUMN `plan_tienda` VARCHAR(32) NOT NULL DEFAULT 'evolucion' AFTER `requiere_suscripcion`;

-- Capacidades que sólo da un plan (no se activan sueltas: `activable = false`). Viven en el
-- catálogo de módulos para que el gate siga siendo `requireModulo`. La pantalla Módulos no
-- muestra esta categoría.
INSERT INTO `categoria_modulo` (`codigo`, `nombre`, `descripcion`, `orden`, `activo`) VALUES
  ('capacidades_plan', 'Incluido en tu plan', 'Capacidades que vienen con el plan de la tienda.', 99, true)
ON DUPLICATE KEY UPDATE
  `nombre` = VALUES(`nombre`), `descripcion` = VALUES(`descripcion`), `orden` = VALUES(`orden`), `activo` = VALUES(`activo`);

INSERT INTO `modulo`
  (`codigo`, `categoria_id`, `nombre`, `descripcion`, `tipo_modulo`, `precio_mensual`,
   `mensajes_utility_incluidos`, `mensajes_marketing_incluidos`, `estado_producto`,
   `activable`, `icono`, `orden`, `activo`)
SELECT s.codigo, c.id, s.nombre, s.descripcion, 'incluido', 0.00, 0, 0, 'disponible', false, s.icono, s.orden, true
FROM (
  SELECT 'diseno_personalizado' codigo, 'Diseño personalizado' nombre,
         'Elegí una plantilla y personalizala en el editor de Páginas.' descripcion, 'Palette' icono, 1 orden
  UNION ALL SELECT 'codigo_fuente', 'Código fuente',
         'Editá y descargá el código de tu página para diseñarla como quieras.', 'Code', 2
  UNION ALL SELECT 'estadisticas_avanzadas', 'Estadísticas avanzadas',
         'Rangos de fechas, ventas por hora, día y categoría, ranking completo y análisis de clientes.', 'LineChart', 3
  UNION ALL SELECT 'repositorio_propio', 'Repositorio propio',
         'Una tienda hecha a medida en su propio repositorio, mantenida con el equipo de Piru.', 'GitBranch', 4
) s
JOIN `categoria_modulo` c ON c.codigo = 'capacidades_plan'
ON DUPLICATE KEY UPDATE
  `categoria_id` = VALUES(`categoria_id`), `nombre` = VALUES(`nombre`), `descripcion` = VALUES(`descripcion`),
  `tipo_modulo` = 'incluido', `precio_mensual` = 0.00, `activable` = false, `icono` = VALUES(`icono`),
  `orden` = VALUES(`orden`), `activo` = true;

-- Catálogo. Cada plan repite los módulos del anterior a propósito: la lista es la verdad y se
-- puede editar sin calcular herencias.
INSERT INTO `plan_tienda`
  (`codigo`, `nombre`, `descripcion`, `precio_mensual`, `descuento_anual`, `orden`, `destacado`, `modulos`, `beneficios`, `activo`)
VALUES
  ('inicial', 'Inicial', 'Para empezar a vender online sin pagar nada.', 0.00, 0, 1, false,
   JSON_ARRAY('mercadopago', 'impresion_comandas'),
   JSON_ARRAY(
     'Pedidos y productos ilimitados',
     'Tienda online con el diseño de Piru',
     'Pedidos directo a tu WhatsApp',
     'Cobros con Mercado Pago, efectivo y transferencia',
     'Impresión de comandas',
     'Lista de clientes y estadísticas básicas'
   ), true),
  ('esencial', 'Esencial', 'Tu marca, tu diseño y las herramientas para vender más.', 19999.00, 20, 2, false,
   JSON_ARRAY('mercadopago', 'impresion_comandas', 'diseno_personalizado', 'talo', 'codigos_descuento',
              'puntos_clientes', 'pos', 'cierre_turno_manual'),
   JSON_ARRAY(
     'Todo lo del plan Inicial',
     'Elegí una plantilla y personalizala',
     'Punto de venta y cierre de caja',
     'Cupones de descuento',
     'Club de puntos',
     'Cobros con Talo'
   ), true),
  ('impulso', 'Impulso', 'Diseño libre en código y casi todas las herramientas.', 39999.00, 20, 3, true,
   JSON_ARRAY('mercadopago', 'impresion_comandas', 'diseno_personalizado', 'talo', 'codigos_descuento',
              'puntos_clientes', 'pos', 'cierre_turno_manual', 'codigo_fuente', 'mesas', 'gestion_stock',
              'gestion_cadetes', 'motor_recompra', 'dias_flojos', 'crecimiento',
              'avisos_automaticos_whatsapp', 'facturacion_arca'),
   JSON_ARRAY(
     'Todo lo del plan Esencial',
     'Descargá y editá el código de tu página',
     'Mesas, stock y cadetes',
     'Recompra, días flojos y campañas',
     'Avisos automáticos por WhatsApp',
     'Facturación electrónica ARCA'
   ), true),
  ('escala', 'Escala', 'Para locales que crecen y quieren medir todo.', 79999.00, 20, 4, false,
   JSON_ARRAY('mercadopago', 'impresion_comandas', 'diseno_personalizado', 'talo', 'codigos_descuento',
              'puntos_clientes', 'pos', 'cierre_turno_manual', 'codigo_fuente', 'mesas', 'gestion_stock',
              'gestion_cadetes', 'motor_recompra', 'dias_flojos', 'crecimiento',
              'avisos_automaticos_whatsapp', 'facturacion_arca', 'estadisticas_avanzadas', 'multisucursal'),
   JSON_ARRAY(
     'Todo lo del plan Impulso',
     'Estadísticas avanzadas',
     'Varias sucursales'
   ), true),
  ('evolucion', 'Evolución', 'Una solución a medida, con repositorio propio y acompañamiento del equipo de Piru.', NULL, 0, 5, false,
   JSON_ARRAY(),
   JSON_ARRAY(
     'Todo lo del plan Escala',
     'Tienda a medida en su propio repositorio',
     'Desarrollos propios',
     'Acompañamiento directo del equipo de Piru',
     'Precio a medida'
   ), true)
ON DUPLICATE KEY UPDATE
  `nombre` = VALUES(`nombre`), `descripcion` = VALUES(`descripcion`), `precio_mensual` = VALUES(`precio_mensual`),
  `descuento_anual` = VALUES(`descuento_anual`), `orden` = VALUES(`orden`), `destacado` = VALUES(`destacado`),
  `modulos` = VALUES(`modulos`), `beneficios` = VALUES(`beneficios`), `activo` = VALUES(`activo`),
  `updated_at` = CURRENT_TIMESTAMP;
