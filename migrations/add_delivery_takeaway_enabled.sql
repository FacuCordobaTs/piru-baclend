ALTER TABLE `restaurante`
  ADD COLUMN `delivery_enabled` boolean NOT NULL DEFAULT true,
  ADD COLUMN `takeaway_enabled` boolean NOT NULL DEFAULT true;
