-- The carrier changed from Twilio to Telnyx, and a column named after a vendor
-- is a trap: the next number on this row is expected to be a +389 one from a
-- third provider. RENAME rather than drop-and-add so nothing is lost if a
-- number was already assigned.
ALTER TABLE `businesses` RENAME COLUMN `twilio_number` TO `inbound_number`;--> statement-breakpoint
DROP INDEX IF EXISTS `businesses_twilio_number_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `businesses_inbound_number_unique` ON `businesses` (`inbound_number`);
