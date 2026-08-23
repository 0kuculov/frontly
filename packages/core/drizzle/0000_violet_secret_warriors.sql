CREATE TABLE `appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`service_id` text NOT NULL,
	`staff_id` text NOT NULL,
	`customer_name` text NOT NULL,
	`customer_phone` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'booked' NOT NULL,
	`channel` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `appointments_staff_slot_unique` ON `appointments` (`staff_id`,`starts_at`) WHERE "appointments"."status" in ('booked', 'completed');--> statement-breakpoint
CREATE INDEX `appointments_business_time_idx` ON `appointments` (`business_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `appointments_staff_time_idx` ON `appointments` (`staff_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `appointments_customer_phone_idx` ON `appointments` (`business_id`,`customer_phone`);--> statement-breakpoint
CREATE TABLE `businesses` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`phone_number` text,
	`twilio_number` text,
	`timezone` text DEFAULT 'Europe/Skopje' NOT NULL,
	`languages` text DEFAULT '["mk"]' NOT NULL,
	`working_hours` text NOT NULL,
	`greeting_template` text NOT NULL,
	`owner_mobile` text,
	`brand_color` text DEFAULT '#0F766E' NOT NULL,
	`voice_config` text DEFAULT '{"mk":{"voiceName":"mk-MK-AleksandarNeural","rate":"-6%","pitch":"0%","greetingBreakMs":300},"sq":{"voiceName":"sq-AL-IlirNeural","rate":"-6%","pitch":"0%","greetingBreakMs":300},"en":{"voiceName":"en-US-AvaMultilingualNeural","rate":"0%","pitch":"0%","greetingBreakMs":300}}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `businesses_slug_unique` ON `businesses` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `businesses_twilio_number_unique` ON `businesses` (`twilio_number`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`from_identifier` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`language_detected` text,
	`outcome` text,
	`transcript` text DEFAULT '[]' NOT NULL,
	`appointment_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_channel_external_unique` ON `conversations` (`channel`,`external_id`);--> statement-breakpoint
CREATE INDEX `conversations_business_started_idx` ON `conversations` (`business_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `conversations_outcome_idx` ON `conversations` (`business_id`,`outcome`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`name_mk` text NOT NULL,
	`name_sq` text,
	`name_en` text,
	`duration_minutes` integer NOT NULL,
	`price` integer,
	`currency` text DEFAULT 'MKD' NOT NULL,
	`description_mk` text,
	`description_sq` text,
	`description_en` text,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `services_business_idx` ON `services` (`business_id`,`active`);--> statement-breakpoint
CREATE TABLE `staff` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`name` text NOT NULL,
	`service_ids` text DEFAULT '[]' NOT NULL,
	`working_hours` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`business_id`) REFERENCES `businesses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `staff_business_idx` ON `staff` (`business_id`,`active`);