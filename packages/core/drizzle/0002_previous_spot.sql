ALTER TABLE `appointments` ADD `confirmation_sent_at` integer;--> statement-breakpoint
ALTER TABLE `appointments` ADD `reminder_sent_at` integer;--> statement-breakpoint
CREATE INDEX `appointments_reminder_idx` ON `appointments` (`reminder_sent_at`,`starts_at`);