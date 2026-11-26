CREATE TABLE `machine_credentials` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`hash` text NOT NULL,
	`member_id` text NOT NULL,
	`machine_id` text,
	`created_at` text NOT NULL,
	`expires_at` text,
	`used_at` text,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
ALTER TABLE `runners` ADD `owner_member_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `machine_credentials_hash` ON `machine_credentials` (`hash`);--> statement-breakpoint
CREATE INDEX `machine_credentials_machine` ON `machine_credentials` (`machine_id`);