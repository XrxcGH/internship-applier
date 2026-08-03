CREATE TABLE `answer_template` (
	`id` text PRIMARY KEY NOT NULL,
	`question_key` text NOT NULL,
	`canonical_text` text NOT NULL,
	`variants` text,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`approved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `answer_template_question_key_unique` ON `answer_template` (`question_key`);--> statement-breakpoint
CREATE TABLE `application` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`apply_url` text NOT NULL,
	`ats_vendor` text DEFAULT 'unknown' NOT NULL,
	`resume_document_id` text,
	`submitted_at` text,
	`deadline_at` text,
	`screenshot_path` text,
	`skipped_fields` text,
	`notes` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `match`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resume_document_id`) REFERENCES `resume_document`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `application_status_idx` ON `application` (`status`,`deadline_at`);--> statement-breakpoint
CREATE TABLE `application_answer` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`question_text` text NOT NULL,
	`field_key` text NOT NULL,
	`answer_type` text NOT NULL,
	`draft_text` text DEFAULT '' NOT NULL,
	`final_text` text DEFAULT '' NOT NULL,
	`edit_distance` integer DEFAULT 0 NOT NULL,
	`evidence` text,
	`flags` text,
	`approved_at` text,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `application_answer_app_idx` ON `application_answer` (`application_id`);--> statement-breakpoint
CREATE TABLE `application_event` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `application`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `application_event_app_idx` ON `application_event` (`application_id`,`at`);--> statement-breakpoint
CREATE TABLE `credential_ref` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`label` text,
	`storage_state_path` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credential_ref_domain_unique` ON `credential_ref` (`domain`);--> statement-breakpoint
CREATE TABLE `decision` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`reason_tags` text,
	`decided_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `match`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `filter_preset` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`filters` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `filter_preset_name_unique` ON `filter_preset` (`name`);--> statement-breakpoint
CREATE TABLE `job_posting` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text,
	`canonical_url` text NOT NULL,
	`apply_url` text NOT NULL,
	`company` text NOT NULL,
	`company_domain` text,
	`title` text NOT NULL,
	`description_html` text,
	`description_text` text NOT NULL,
	`locations` text,
	`position_type` text,
	`work_arrangement` text,
	`hybrid_days_onsite` integer,
	`remote_eligible_in` text,
	`program_flags` text,
	`term` text,
	`compensation` text,
	`requires` text,
	`posted_at` text,
	`closes_at` text,
	`is_open` integer DEFAULT true NOT NULL,
	`ats_vendor` text DEFAULT 'unknown' NOT NULL,
	`apply_effort` text,
	`fingerprint` text NOT NULL,
	`embedding` blob,
	`first_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_posting_canonical_url_idx` ON `job_posting` (`canonical_url`);--> statement-breakpoint
CREATE INDEX `job_posting_fingerprint_idx` ON `job_posting` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `job_posting_open_idx` ON `job_posting` (`is_open`,`closes_at`);--> statement-breakpoint
CREATE INDEX `job_posting_filter_idx` ON `job_posting` (`position_type`,`work_arrangement`,`is_open`);--> statement-breakpoint
CREATE TABLE `job_posting_source` (
	`posting_id` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text,
	`seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `job_posting`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `source`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_posting_source_pk` ON `job_posting_source` (`posting_id`,`source_id`);--> statement-breakpoint
CREATE TABLE `job_requirement` (
	`id` text PRIMARY KEY NOT NULL,
	`posting_id` text NOT NULL,
	`kind` text NOT NULL,
	`operator` text NOT NULL,
	`value` text,
	`necessity` text NOT NULL,
	`source_quote` text NOT NULL,
	`confidence` integer NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `job_posting`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_requirement_posting_idx` ON `job_requirement` (`posting_id`);--> statement-breakpoint
CREATE TABLE `llm_call` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd_micros` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`stop_reason` text,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `match` (
	`id` text PRIMARY KEY NOT NULL,
	`posting_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`eligibility` text NOT NULL,
	`rules` text NOT NULL,
	`blockers` text NOT NULL,
	`score` integer NOT NULL,
	`breakdown` text NOT NULL,
	`rationale` text NOT NULL,
	`computed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`posting_id`) REFERENCES `job_posting`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profile`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_posting_profile_idx` ON `match` (`posting_id`,`profile_id`);--> statement-breakpoint
CREATE INDEX `match_rank_idx` ON `match` (`eligibility`,`score`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` text PRIMARY KEY NOT NULL,
	`full_name` text NOT NULL,
	`email` text NOT NULL,
	`phone` text,
	`date_of_birth` text,
	`address` text,
	`links` text,
	`work_authorization` text,
	`citizenships` text,
	`education` text,
	`experience` text,
	`projects` text,
	`skills` text,
	`certifications` text,
	`languages` text,
	`availability` text,
	`location_prefs` text,
	`preferences` text,
	`derived` text,
	`confirmed_at` text,
	`needs_review` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `resume_document` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`path` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`raw_text` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`config` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`last_status` text
);
--> statement-breakpoint
CREATE TABLE `style_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`metrics` text NOT NULL,
	`qualitative_notes` text,
	`sample_ids` text NOT NULL,
	`computed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`run_after` text,
	`started_at` text,
	`finished_at` text,
	`error` text,
	`progress` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_queue_idx` ON `task` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `writing_sample` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`word_count` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
