CREATE TABLE "community_agent_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"henge_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_type" text,
	"revoked_by_id" text
);
--> statement-breakpoint
CREATE TABLE "community_agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"install_id" uuid NOT NULL,
	"device_public_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "community_audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"henge_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_avatars" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_bans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"henge_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"reason" text NOT NULL,
	"banned_by_type" text NOT NULL,
	"banned_by_id" text NOT NULL,
	"appeal_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by_id" text
);
--> statement-breakpoint
CREATE TABLE "community_categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"henge_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_channel_overrides" (
	"channel_id" uuid NOT NULL,
	"role_key" text NOT NULL,
	"perms" jsonb NOT NULL,
	CONSTRAINT "community_channel_overrides_channel_id_role_key_pk" PRIMARY KEY("channel_id","role_key")
);
--> statement-breakpoint
CREATE TABLE "community_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"henge_id" uuid NOT NULL,
	"category_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"slow_mode_s" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"public" boolean DEFAULT true NOT NULL,
	"agents_policy" text,
	"glyph_posts" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "community_events" (
	"id" text PRIMARY KEY NOT NULL,
	"henge_id" uuid NOT NULL,
	"channel_id" uuid,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"audience" uuid[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_handles" (
	"key" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"held_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "community_members" (
	"henge_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"roles" text[] NOT NULL,
	"nickname" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_members_henge_id_actor_id_pk" PRIMARY KEY("henge_id","actor_id")
);
--> statement-breakpoint
CREATE TABLE "community_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"henge_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"reply_to" text,
	"thread_root" text,
	"mention_actor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"mention_roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"mention_everyone" boolean DEFAULT false NOT NULL,
	"thread_reply_count" integer DEFAULT 0 NOT NULL,
	"thread_last_reply_at" timestamp with time zone,
	"held" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by_type" text,
	"deleted_by_id" text,
	"delete_reason" text,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_pins" (
	"channel_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	"pinned_by_type" text NOT NULL,
	"pinned_by_id" text NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_pins_channel_id_message_id_pk" PRIMARY KEY("channel_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "community_presence" (
	"henge_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_presence_henge_id_actor_id_pk" PRIMARY KEY("henge_id","actor_id")
);
--> statement-breakpoint
CREATE TABLE "community_profiles" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"bio" text DEFAULT '' NOT NULL,
	"avatar_sha256" text,
	"handle_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "community_rate_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_reactions" (
	"message_id" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_reactions_message_id_actor_id_emoji_pk" PRIMARY KEY("message_id","actor_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "community_read_state" (
	"actor_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"thread_root" text DEFAULT '' NOT NULL,
	"last_read_message_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_read_state_actor_id_channel_id_thread_root_pk" PRIMARY KEY("actor_id","channel_id","thread_root")
);
--> statement-breakpoint
CREATE TABLE "community_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"henge_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"message_id" text,
	"channel_id" uuid,
	"target_actor_id" uuid,
	"reporter_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"snapshot" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"outcome" text,
	"outcome_note" text,
	"resolved_by_type" text,
	"resolved_by_id" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_roles" (
	"henge_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"perms" jsonb NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "community_roles_henge_id_key_pk" PRIMARY KEY("henge_id","key")
);
--> statement-breakpoint
CREATE TABLE "community_timeouts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"henge_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"by_type" text NOT NULL,
	"by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "henges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"source_url" text,
	"pinned_digest" text NOT NULL,
	"henge_file" jsonb NOT NULL,
	"owner_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community_agent_tokens" ADD CONSTRAINT "community_agent_tokens_henge_id_henges_id_fk" FOREIGN KEY ("henge_id") REFERENCES "public"."henges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_agent_tokens" ADD CONSTRAINT "community_agent_tokens_agent_id_community_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."community_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_agents" ADD CONSTRAINT "community_agents_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_agents" ADD CONSTRAINT "community_agents_install_id_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."installs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_bans" ADD CONSTRAINT "community_bans_henge_id_henges_id_fk" FOREIGN KEY ("henge_id") REFERENCES "public"."henges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_categories" ADD CONSTRAINT "community_categories_henge_id_henges_id_fk" FOREIGN KEY ("henge_id") REFERENCES "public"."henges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_channel_overrides" ADD CONSTRAINT "community_channel_overrides_channel_id_community_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_channels" ADD CONSTRAINT "community_channels_henge_id_henges_id_fk" FOREIGN KEY ("henge_id") REFERENCES "public"."henges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_channels" ADD CONSTRAINT "community_channels_category_id_community_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."community_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_members" ADD CONSTRAINT "community_members_henge_id_henges_id_fk" FOREIGN KEY ("henge_id") REFERENCES "public"."henges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_henge_id_henges_id_fk" FOREIGN KEY ("henge_id") REFERENCES "public"."henges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_channel_id_community_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_pins" ADD CONSTRAINT "community_pins_channel_id_community_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_pins" ADD CONSTRAINT "community_pins_message_id_community_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."community_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_profiles" ADD CONSTRAINT "community_profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reactions" ADD CONSTRAINT "community_reactions_message_id_community_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."community_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_read_state" ADD CONSTRAINT "community_read_state_channel_id_community_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."community_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_henge_id_henges_id_fk" FOREIGN KEY ("henge_id") REFERENCES "public"."henges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_roles" ADD CONSTRAINT "community_roles_henge_id_henges_id_fk" FOREIGN KEY ("henge_id") REFERENCES "public"."henges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_timeouts" ADD CONSTRAINT "community_timeouts_henge_id_henges_id_fk" FOREIGN KEY ("henge_id") REFERENCES "public"."henges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "henges" ADD CONSTRAINT "henges_owner_account_id_accounts_id_fk" FOREIGN KEY ("owner_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_agent_tokens_hash_idx" ON "community_agent_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "community_agent_tokens_agent_idx" ON "community_agent_tokens" USING btree ("henge_id","agent_id");--> statement-breakpoint
CREATE INDEX "community_agents_owner_idx" ON "community_agents" USING btree ("owner_account_id");--> statement-breakpoint
CREATE INDEX "community_audit_henge_idx" ON "community_audit_log" USING btree ("henge_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "community_bans_active_idx" ON "community_bans" USING btree ("henge_id","actor_id") WHERE "community_bans"."lifted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "community_categories_key_idx" ON "community_categories" USING btree ("henge_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "community_channels_key_idx" ON "community_channels" USING btree ("henge_id","key");--> statement-breakpoint
CREATE INDEX "community_events_henge_idx" ON "community_events" USING btree ("henge_id","id");--> statement-breakpoint
CREATE INDEX "community_handles_owner_idx" ON "community_handles" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "community_members_owner_idx" ON "community_members" USING btree ("henge_id","owner_account_id");--> statement-breakpoint
CREATE INDEX "community_messages_channel_idx" ON "community_messages" USING btree ("channel_id","id");--> statement-breakpoint
CREATE INDEX "community_messages_thread_idx" ON "community_messages" USING btree ("thread_root","id");--> statement-breakpoint
CREATE INDEX "community_messages_author_idx" ON "community_messages" USING btree ("henge_id","author_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "community_reports_once_idx" ON "community_reports" USING btree ("kind","message_id","reporter_id");--> statement-breakpoint
CREATE INDEX "community_reports_queue_idx" ON "community_reports" USING btree ("henge_id","status","created_at");--> statement-breakpoint
CREATE INDEX "community_reports_target_idx" ON "community_reports" USING btree ("henge_id","target_actor_id","created_at");--> statement-breakpoint
CREATE INDEX "community_timeouts_actor_idx" ON "community_timeouts" USING btree ("henge_id","actor_id","until");--> statement-breakpoint
CREATE UNIQUE INDEX "henges_ref_idx" ON "henges" USING btree ("ref");--> statement-breakpoint
-- Spin-out spec 8.2: the community audit log is append-only for every role. Row triggers refuse UPDATE
-- and DELETE, a statement trigger refuses TRUNCATE. The table has no foreign keys, so no cascade reaches it.
CREATE OR REPLACE FUNCTION community_audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'community_audit_log is append-only (%)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER community_audit_log_no_update BEFORE UPDATE ON community_audit_log FOR EACH ROW EXECUTE FUNCTION community_audit_log_immutable();
--> statement-breakpoint
CREATE TRIGGER community_audit_log_no_delete BEFORE DELETE ON community_audit_log FOR EACH ROW EXECUTE FUNCTION community_audit_log_immutable();
--> statement-breakpoint
CREATE TRIGGER community_audit_log_no_truncate BEFORE TRUNCATE ON community_audit_log FOR EACH STATEMENT EXECUTE FUNCTION community_audit_log_immutable();