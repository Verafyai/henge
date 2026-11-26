CREATE TYPE "public"."credit_bucket" AS ENUM('available', 'reserved', 'pending', 'settled', 'issued');--> statement-breakpoint
CREATE TABLE "task_known_answers" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"expected_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"swarm_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"review_window_s" integer,
	"known_answer_rate" real,
	"redundancy_count" integer,
	"jury_panel_size" integer,
	"status" "config_status" DEFAULT 'proposal' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_rules_positive" CHECK (("verification_rules"."review_window_s" is null or "verification_rules"."review_window_s" >= 0) and ("verification_rules"."redundancy_count" is null or "verification_rules"."redundancy_count" >= 2) and ("verification_rules"."jury_panel_size" is null or "verification_rules"."jury_panel_size" >= 1))
);
--> statement-breakpoint
CREATE TABLE "verifier_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"public_key" text NOT NULL,
	"kind" text NOT NULL,
	"methods" text[] NOT NULL,
	"status" "key_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifier_nonces" (
	"key_id" text NOT NULL,
	"nonce" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verifier_nonces_key_id_nonce_pk" PRIMARY KEY("key_id","nonce")
);
--> statement-breakpoint
DROP INDEX "credit_accounts_owner_idx";--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD COLUMN "bucket" "credit_bucket" DEFAULT 'available' NOT NULL;--> statement-breakpoint
ALTER TABLE "impact_events" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "verifying_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "clawed_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "qualification_attempts" ADD COLUMN "output_json" jsonb;--> statement-breakpoint
ALTER TABLE "qualification_attempts" ADD COLUMN "check_status" text;--> statement-breakpoint
ALTER TABLE "qualification_attempts" ADD COLUMN "check_record_json" jsonb;--> statement-breakpoint
ALTER TABLE "qualification_tasks" ADD COLUMN "machine_check" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "redundancy_group" text;--> statement-breakpoint
ALTER TABLE "verification_records" ADD COLUMN "lease_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_records" ADD COLUMN "release_id" uuid;--> statement-breakpoint
ALTER TABLE "verification_records" ADD COLUMN "verifier_key_id" text;--> statement-breakpoint
ALTER TABLE "verification_records" ADD COLUMN "result_hash" text;--> statement-breakpoint
ALTER TABLE "verification_records" ADD COLUMN "dispute_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_known_answers" ADD CONSTRAINT "task_known_answers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_rules" ADD CONSTRAINT "verification_rules_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_rules_version_idx" ON "verification_rules" USING btree ("swarm_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "verifier_keys_key_id_idx" ON "verifier_keys" USING btree ("key_id");--> statement-breakpoint
ALTER TABLE "verification_records" ADD CONSTRAINT "verification_records_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_records" ADD CONSTRAINT "verification_records_release_id_swarm_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."swarm_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reputation_events_evidence_idx" ON "reputation_events" USING btree ("event_type","evidence_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "run_records_signature_idx" ON "run_records" USING btree ("run_record_signature");--> statement-breakpoint
CREATE INDEX "tasks_redundancy_idx" ON "tasks" USING btree ("swarm_id","redundancy_group");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_records_result_method_idx" ON "verification_records" USING btree ("result_id","method");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_accounts_owner_idx" ON "credit_accounts" USING btree ("owner_type","owner_id","bucket");