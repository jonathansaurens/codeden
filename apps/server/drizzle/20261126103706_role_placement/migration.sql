CREATE TABLE `member_preferences` (
	`member_id` text PRIMARY KEY,
	`orchestrator_runs_on` text DEFAULT 'server' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `pm_runs_on` text DEFAULT 'server' NOT NULL;