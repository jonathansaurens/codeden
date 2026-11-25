CREATE TABLE `member_credentials` (
	`id` text PRIMARY KEY,
	`member_id` text NOT NULL,
	`kind` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE TABLE `member_invites` (
	`id` text PRIMARY KEY,
	`secret_hash` text NOT NULL,
	`role` text NOT NULL,
	`project_roles` text NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`used_by` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`project_roles` text NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`may_answer_approvals` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `member_credentials_member` ON `member_credentials` (`member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_credentials_hash` ON `member_credentials` (`hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_invites_secret` ON `member_invites` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `members_name` ON `members` (`name`);