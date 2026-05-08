CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`booking_id` text,
	`trace_id` text,
	`data` text
);
--> statement-breakpoint
CREATE TABLE `booking_events` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`seq` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`recorded_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`payload` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ux_booking_events_booking_seq` ON `booking_events` (`booking_id`,`seq`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`state` text NOT NULL,
	`service_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`resource_ids` text NOT NULL,
	`slot_start` text NOT NULL,
	`slot_end` text NOT NULL,
	`source` text NOT NULL,
	`name_kana` text,
	`phone_last4` text,
	`free_text` text,
	`held_at` text,
	`expires_at` text,
	`confirmed_at` text,
	`cancelled_at` text,
	`cancelled_by` text,
	`cancel_reason` text,
	`completed_at` text,
	`marked_at` text,
	`marked_by` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_code_unique` ON `bookings` (`code`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`snapshot` text NOT NULL,
	`enqueued_at` text NOT NULL,
	`next_attempt_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `ix_outbox_next_attempt` ON `outbox` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `outbox_dead` (
	`id` text PRIMARY KEY NOT NULL,
	`booking_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`snapshot` text NOT NULL,
	`enqueued_at` text NOT NULL,
	`died_at` text NOT NULL,
	`attempts` integer NOT NULL,
	`last_error` text NOT NULL
);
