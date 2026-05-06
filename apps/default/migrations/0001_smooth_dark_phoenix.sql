CREATE TABLE `business_hours` (
	`id` text PRIMARY KEY NOT NULL,
	`weekday` integer NOT NULL,
	`windows` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `closures` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_absences` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`skills` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`duration_minutes` integer NOT NULL,
	`buffer_before_minutes` integer NOT NULL,
	`buffer_after_minutes` integer NOT NULL,
	`holding_days` integer NOT NULL,
	`required_skills` text NOT NULL,
	`required_resource_types` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE `outbox` DROP COLUMN `snapshot`;--> statement-breakpoint
ALTER TABLE `outbox_dead` DROP COLUMN `snapshot`;