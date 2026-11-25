CREATE TYPE "public"."account_status" AS ENUM('active', 'frozen', 'closed');--> statement-breakpoint
CREATE TYPE "public"."badge_status" AS ENUM('none', 'pending', 'verified', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."release_channel" AS ENUM('stable', 'beta', 'internal');--> statement-breakpoint
CREATE TYPE "public"."config_status" AS ENUM('proposal', 'approved', 'retired');--> statement-breakpoint
CREATE TYPE "public"."credit_owner_type" AS ENUM('account', 'publisher', 'pool', 'platform');--> statement-breakpoint
CREATE TYPE "public"."featured_status" AS ENUM('none', 'featured', 'removed_pending_review');--> statement-breakpoint
CREATE TYPE "public"."fit_status" AS ENUM('runs_well', 'runs_slowly', 'will_not_fit', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."funded_mode" AS ENUM('volunteer', 'funded');--> statement-breakpoint
CREATE TYPE "public"."harness_runtime" AS ENUM('wasm', 'container');--> statement-breakpoint
CREATE TYPE "public"."key_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."lease_status" AS ENUM('leased', 'running', 'submitted', 'verifying', 'pending', 'settled', 'rejected', 'abandoned', 'expired', 'clawed_back');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('joining', 'qualifying', 'active', 'paused', 'reconsent_required', 'left');--> statement-breakpoint
CREATE TYPE "public"."model_source" AS ENUM('ollama', 'huggingface');--> statement-breakpoint
CREATE TYPE "public"."movement_type" AS ENUM('purchase', 'donation', 'lease_reserve', 'reserve_release', 'accept_pending', 'settle', 'clawback', 'job_reserve', 'refund', 'correction');--> statement-breakpoint
CREATE TYPE "public"."node_mode" AS ENUM('local', 'api', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."node_status" AS ENUM('setup', 'ready', 'paused', 'offline', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."platform_role" AS ENUM('none', 'reviewer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."profile_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TYPE "public"."publisher_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."purchase_status" AS ENUM('created', 'paid', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."qualification_outcome" AS ENUM('in_progress', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'reviewing', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."review_outcome" AS ENUM('approved', 'rejected', 'changes_requested');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('draft', 'in_review', 'approved', 'rejected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."review_target" AS ENUM('swarm_release', 'harness_release', 'model', 'publisher');--> statement-breakpoint
CREATE TYPE "public"."revocation_target" AS ENUM('swarm', 'swarm_release', 'harness_release', 'model_artifact', 'publisher_key', 'client_version');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('low', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('ollama', 'llama_cpp', 'openrouter', 'anthropic', 'openai', 'xai');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('available', 'unavailable', 'disabled_by_policy', 'key_failed');--> statement-breakpoint
CREATE TYPE "public"."swarm_category" AS ENUM('governance', 'mathematics', 'security', 'science', 'healthcare', 'public_goods', 'gaming');--> statement-breakpoint
CREATE TYPE "public"."swarm_status" AS ENUM('draft', 'in_review', 'listed', 'publisher_paused', 'halted', 'retired');--> statement-breakpoint
CREATE TYPE "public"."swarm_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'leased', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."team_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."team_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TYPE "public"."verification_method" AS ENUM('machine-check', 'known-answers', 'redundancy', 'jury', 'publisher-review');--> statement-breakpoint
CREATE TYPE "public"."verification_outcome" AS ENUM('accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "access_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"install_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_badges" (
	"account_id" uuid NOT NULL,
	"badge_id" uuid NOT NULL,
	"awarded_for_result_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_badges_account_id_badge_id_pk" PRIMARY KEY("account_id","badge_id")
);
--> statement-breakpoint
CREATE TABLE "account_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"verified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"email_hash" text,
	"profile_visibility" "profile_visibility" DEFAULT 'private' NOT NULL,
	"reputation_overall" integer DEFAULT 0 NOT NULL,
	"platform_role" "platform_role" DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "badges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category" "swarm_category",
	"criterion_version" text NOT NULL,
	"display_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"channel" "release_channel" NOT NULL,
	"platform" text NOT NULL,
	"arch" text NOT NULL,
	"url" text NOT NULL,
	"sha256" text NOT NULL,
	"manifest" text NOT NULL,
	"signature" text NOT NULL,
	"notes_md" text DEFAULT '' NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rollout_pct" smallint DEFAULT 100 NOT NULL,
	"yanked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "compute_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"kind" "source_kind" NOT NULL,
	"status" "source_status" NOT NULL,
	"provider_enabled_by_policy" boolean DEFAULT false NOT NULL,
	"local_key_ref" text,
	"last_success_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_type" "credit_owner_type" NOT NULL,
	"owner_id" uuid,
	"currency" text DEFAULT 'credit' NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_purchases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"publisher_id" uuid NOT NULL,
	"processor_ref" text,
	"amount_currency_minor" bigint NOT NULL,
	"credits_issued" bigint NOT NULL,
	"price_config_version" uuid NOT NULL,
	"take_rate_config_version" uuid NOT NULL,
	"status" "purchase_status" DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economic_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"credit_price_minor" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"take_rate_bp" integer NOT NULL,
	"hosted_free_task_volume" integer,
	"private_seat_price_minor" integer,
	"status" "config_status" DEFAULT 'proposal' NOT NULL,
	"approved_by" uuid,
	"effective_at" timestamp with time zone,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "harness_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"harness_id" uuid NOT NULL,
	"version" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"runtime" "harness_runtime" NOT NULL,
	"min_model_class" text NOT NULL,
	"output_schema_hash" text NOT NULL,
	"signature" text NOT NULL,
	"sbom_hash" text NOT NULL,
	"review_status" "review_status" DEFAULT 'in_review' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "harnesses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"publisher_id" uuid NOT NULL,
	"name" text NOT NULL,
	"review_status" "review_status" DEFAULT 'draft' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"key" text NOT NULL,
	"account_id" uuid NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" smallint NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_account_id_key_pk" PRIMARY KEY("account_id","key")
);
--> statement-breakpoint
CREATE TABLE "impact_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"swarm_id" uuid NOT NULL,
	"category" "swarm_category" NOT NULL,
	"units" integer NOT NULL,
	"result_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "impact_units_check" CHECK ("impact_events"."units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "installs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"platform" text NOT NULL,
	"arch" text NOT NULL,
	"client_version" text NOT NULL,
	"channel" text NOT NULL,
	"device_public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "lease_status" DEFAULT 'leased' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"abandoned_at" timestamp with time zone,
	"idempotency_key" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"txn_id" uuid NOT NULL,
	"credit_account_id" uuid NOT NULL,
	"debit_credits" bigint DEFAULT 0 NOT NULL,
	"credit_credits" bigint DEFAULT 0 NOT NULL,
	"movement_type" "movement_type" NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_one_side" CHECK (("ledger_entries"."debit_credits" > 0 and "ledger_entries"."credit_credits" = 0) or ("ledger_entries"."credit_credits" > 0 and "ledger_entries"."debit_credits" = 0))
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"swarm_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"status" "membership_status" DEFAULT 'joining' NOT NULL,
	"share_bp" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "memberships_share_check" CHECK ("memberships"."share_bp" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "model_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model_id" uuid NOT NULL,
	"version_label" text NOT NULL,
	"content_hash" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"context_length" integer NOT NULL,
	"quantization" text NOT NULL,
	"runtime_formats" text[] NOT NULL,
	"catalog_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"source" "model_source" NOT NULL,
	"family" text NOT NULL,
	"display_name" text NOT NULL,
	"model_class" text NOT NULL,
	"license_id" text NOT NULL,
	"review_status" "review_status" DEFAULT 'in_review' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_capabilities" (
	"node_id" uuid NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"os" text NOT NULL,
	"cpu_class" text,
	"ram_bytes" bigint,
	"gpu_family" text,
	"vram_bytes" bigint,
	"free_disk_bytes" bigint,
	"enforcement_support_json" jsonb NOT NULL,
	"confidence" text NOT NULL,
	CONSTRAINT "node_capabilities_node_id_observed_at_pk" PRIMARY KEY("node_id","observed_at")
);
--> statement-breakpoint
CREATE TABLE "node_models" (
	"node_id" uuid NOT NULL,
	"model_artifact_id" uuid NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_hash" text NOT NULL,
	"benchmark_tps" real,
	"fit_status" "fit_status" DEFAULT 'unknown' NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "node_models_node_id_model_artifact_id_pk" PRIMARY KEY("node_id","model_artifact_id")
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"install_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" "node_mode" DEFAULT 'local' NOT NULL,
	"status" "node_status" DEFAULT 'setup' NOT NULL,
	"run_rules_json" jsonb NOT NULL,
	"disk_budget_bytes" bigint NOT NULL,
	"concurrency_local" smallint DEFAULT 1 NOT NULL,
	"concurrency_api" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_concurrency_check" CHECK ("nodes"."concurrency_local" >= 0 and "nodes"."concurrency_api" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"weekly_summary" boolean DEFAULT false NOT NULL,
	"channels_json" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"membership_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"permissions_hash" text NOT NULL,
	"granted_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"swarm_id" uuid NOT NULL,
	"publisher_id" uuid NOT NULL,
	"credit_account_id" uuid NOT NULL,
	"funded_mode" "funded_mode" NOT NULL,
	"available_cached" bigint DEFAULT 0 NOT NULL,
	"reserved_cached" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "pools_nonnegative" CHECK ("pools"."available_cached" >= 0 and "pools"."reserved_cached" >= 0)
);
--> statement-breakpoint
CREATE TABLE "publisher_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"publisher_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"public_key" text NOT NULL,
	"algorithm" text DEFAULT 'ed25519' NOT NULL,
	"status" "key_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "publishers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"verified_domain" text,
	"verified_github_org" text,
	"badge_status" "badge_status" DEFAULT 'none' NOT NULL,
	"status" "publisher_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qualifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"membership_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"passed" smallint DEFAULT 0 NOT NULL,
	"outcome" "qualification_outcome" DEFAULT 'in_progress' NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"install_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"swarm_id" uuid NOT NULL,
	"reporter_account_id" uuid NOT NULL,
	"category" text NOT NULL,
	"details_redacted" text NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reputation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"node_id" uuid,
	"swarm_id" uuid,
	"event_type" text NOT NULL,
	"delta" integer NOT NULL,
	"score_version" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lease_id" uuid NOT NULL,
	"output_ref" text NOT NULL,
	"output_hash" text NOT NULL,
	"schema_valid" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_type" "review_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"checklist_json" jsonb NOT NULL,
	"outcome" "review_outcome" NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_type" "revocation_target" NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"severity" "severity" NOT NULL,
	"signed_payload" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lease_id" uuid NOT NULL,
	"model_id_claim" text NOT NULL,
	"model_artifact_hash" text,
	"provider" text,
	"harness_hash" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"elapsed_ms" integer NOT NULL,
	"cost_usd_micros_reported" bigint,
	"run_record_signature" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"result_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"visibility" "profile_visibility" DEFAULT 'private' NOT NULL,
	"rendered_image_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_caps" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"daily_usd_micros" bigint NOT NULL,
	"monthly_usd_micros" bigint NOT NULL,
	"per_task_usd_micros" bigint NOT NULL,
	"per_swarm_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swarm_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"swarm_id" uuid NOT NULL,
	"manifest_version" smallint NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"harness_release_id" uuid NOT NULL,
	"coordinator_config" jsonb NOT NULL,
	"signature" jsonb NOT NULL,
	"permissions_hash" text NOT NULL,
	"review_status" "review_status" DEFAULT 'in_review' NOT NULL,
	"published_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swarms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"publisher_id" uuid NOT NULL,
	"category" "swarm_category" NOT NULL,
	"visibility" "swarm_visibility" DEFAULT 'public' NOT NULL,
	"funded_mode" "funded_mode" NOT NULL,
	"status" "swarm_status" DEFAULT 'draft' NOT NULL,
	"featured_status" "featured_status" DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"swarm_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"coordinator_task_id" text NOT NULL,
	"input_ref" text NOT NULL,
	"input_hash" text NOT NULL,
	"model_requirement_json" jsonb NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"reward_credits" bigint,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_reward_check" CHECK ("tasks"."reward_credits" is null or "tasks"."reward_credits" > 0)
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"team_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "team_role" DEFAULT 'member' NOT NULL,
	"consent_impact_rollup" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_account_id_pk" PRIMARY KEY("team_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"visibility" "team_visibility" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"result_id" uuid NOT NULL,
	"method" "verification_method" NOT NULL,
	"verifier_version" text NOT NULL,
	"evidence_hashes" text[] NOT NULL,
	"outcome" "verification_outcome" NOT NULL,
	"rationale_code" text NOT NULL,
	"panel_json" jsonb,
	"signature" text NOT NULL,
	"pending_window_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_install_id_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_badges" ADD CONSTRAINT "account_badges_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_badges" ADD CONSTRAINT "account_badges_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_badges" ADD CONSTRAINT "account_badges_awarded_for_result_id_results_id_fk" FOREIGN KEY ("awarded_for_result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_identities" ADD CONSTRAINT "account_identities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_sources" ADD CONSTRAINT "compute_sources_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_purchases" ADD CONSTRAINT "credit_purchases_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economic_configs" ADD CONSTRAINT "economic_configs_approved_by_accounts_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_releases" ADD CONSTRAINT "harness_releases_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harnesses" ADD CONSTRAINT "harnesses_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impact_events" ADD CONSTRAINT "impact_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impact_events" ADD CONSTRAINT "impact_events_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impact_events" ADD CONSTRAINT "impact_events_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impact_events" ADD CONSTRAINT "impact_events_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installs" ADD CONSTRAINT "installs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installs" ADD CONSTRAINT "installs_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_release_id_swarm_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."swarm_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_artifacts" ADD CONSTRAINT "model_artifacts_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_capabilities" ADD CONSTRAINT "node_capabilities_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_models" ADD CONSTRAINT "node_models_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_models" ADD CONSTRAINT "node_models_model_artifact_id_model_artifacts_id_fk" FOREIGN KEY ("model_artifact_id") REFERENCES "public"."model_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_install_id_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."installs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_release_id_swarm_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."swarm_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publisher_keys" ADD CONSTRAINT "publisher_keys_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publishers" ADD CONSTRAINT "publishers_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualifications" ADD CONSTRAINT "qualifications_release_id_swarm_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."swarm_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_install_id_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_account_id_accounts_id_fk" FOREIGN KEY ("reporter_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_accounts_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_records" ADD CONSTRAINT "run_records_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_cards" ADD CONSTRAINT "share_cards_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_cards" ADD CONSTRAINT "share_cards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_caps" ADD CONSTRAINT "spend_caps_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_releases" ADD CONSTRAINT "swarm_releases_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_releases" ADD CONSTRAINT "swarm_releases_harness_release_id_harness_releases_id_fk" FOREIGN KEY ("harness_release_id") REFERENCES "public"."harness_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_release_id_swarm_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."swarm_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_records" ADD CONSTRAINT "verification_records_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_tokens_install_idx" ON "access_tokens" USING btree ("install_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_identities_subject_idx" ON "account_identities" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_handle_idx" ON "accounts" USING btree (lower("handle"));--> statement-breakpoint
CREATE UNIQUE INDEX "client_releases_identity_idx" ON "client_releases" USING btree ("version","channel","platform","arch");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_accounts_owner_idx" ON "credit_accounts" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_releases_version_idx" ON "harness_releases" USING btree ("harness_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "harness_releases_hash_idx" ON "harness_releases" USING btree ("bundle_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "harnesses_publisher_name_idx" ON "harnesses" USING btree ("publisher_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "impact_events_result_idx" ON "impact_events" USING btree ("result_id");--> statement-breakpoint
CREATE INDEX "installs_account_idx" ON "installs" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leases_idempotency_idx" ON "leases" USING btree ("node_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "leases_task_idx" ON "leases" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("credit_account_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_txn_idx" ON "ledger_entries" USING btree ("txn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_idempotency_idx" ON "ledger_entries" USING btree ("idempotency_key","credit_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_active_idx" ON "memberships" USING btree ("node_id","swarm_id") WHERE "memberships"."left_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "model_artifacts_hash_idx" ON "model_artifacts" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "models_slug_idx" ON "models" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_install_idx" ON "nodes" USING btree ("install_id");--> statement-breakpoint
CREATE INDEX "notifications_account_idx" ON "notifications" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_unprocessed_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "pools_slug_idx" ON "pools" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "publisher_keys_key_id_idx" ON "publisher_keys" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publishers_slug_idx" ON "publishers" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_idx" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "results_lease_hash_idx" ON "results" USING btree ("lease_id","output_hash");--> statement-breakpoint
CREATE INDEX "revocations_effective_idx" ON "revocations" USING btree ("effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "swarm_releases_hash_idx" ON "swarm_releases" USING btree ("manifest_hash");--> statement-breakpoint
CREATE INDEX "swarm_releases_swarm_idx" ON "swarm_releases" USING btree ("swarm_id");--> statement-breakpoint
CREATE UNIQUE INDEX "swarms_slug_idx" ON "swarms" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_coordinator_idx" ON "tasks" USING btree ("swarm_id","coordinator_task_id");