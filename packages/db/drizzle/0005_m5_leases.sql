CREATE TABLE "deadline_misses" (
	"node_id" uuid NOT NULL,
	"swarm_id" uuid NOT NULL,
	"rule_version" integer NOT NULL,
	"misses" integer DEFAULT 0 NOT NULL,
	"last_missed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deadline_misses_node_id_swarm_id_rule_version_pk" PRIMARY KEY("node_id","swarm_id","rule_version")
);
--> statement-breakpoint
CREATE TABLE "lease_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"swarm_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"repeated_miss_threshold" integer,
	"max_renewals" integer,
	"status" "config_status" DEFAULT 'proposal' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "results" ALTER COLUMN "schema_valid" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "membership_id" uuid;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "urgent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "renewals" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "requeued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "shares_customized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "output_json" jsonb;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "disposition" text DEFAULT 'on_time' NOT NULL;--> statement-breakpoint
ALTER TABLE "run_records" ADD COLUMN "record_json" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "input_json" jsonb;--> statement-breakpoint
ALTER TABLE "deadline_misses" ADD CONSTRAINT "deadline_misses_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deadline_misses" ADD CONSTRAINT "deadline_misses_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_rules" ADD CONSTRAINT "lease_rules_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lease_rules_version_idx" ON "lease_rules" USING btree ("swarm_id","version");--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leases_open_idx" ON "leases" USING btree ("status","deadline_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_records_lease_idx" ON "run_records" USING btree ("lease_id");--> statement-breakpoint
CREATE INDEX "tasks_queue_idx" ON "tasks" USING btree ("swarm_id","status");