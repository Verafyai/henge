CREATE TABLE "qualification_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"qualification_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"output_hash" text,
	"correct" boolean
);
--> statement-breakpoint
CREATE TABLE "qualification_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"swarm_id" uuid NOT NULL,
	"input_json" jsonb NOT NULL,
	"expected_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "qualification_attempts" ADD CONSTRAINT "qualification_attempts_qualification_id_qualifications_id_fk" FOREIGN KEY ("qualification_id") REFERENCES "public"."qualifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_attempts" ADD CONSTRAINT "qualification_attempts_task_id_qualification_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."qualification_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_tasks" ADD CONSTRAINT "qualification_tasks_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "qualification_attempts_task_idx" ON "qualification_attempts" USING btree ("qualification_id","task_id");--> statement-breakpoint
CREATE INDEX "qualification_tasks_swarm_idx" ON "qualification_tasks" USING btree ("swarm_id");