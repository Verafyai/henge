CREATE TABLE "fit_calibrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"runtime" text NOT NULL,
	"catalog_version" integer NOT NULL,
	"runs_well_min_tps" real NOT NULL,
	"runs_slowly_min_tps" real NOT NULL,
	"status" "review_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "license_acceptances" (
	"account_id" uuid NOT NULL,
	"model_artifact_id" uuid NOT NULL,
	"license_id" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_acceptances_account_id_model_artifact_id_pk" PRIMARY KEY("account_id","model_artifact_id")
);
--> statement-breakpoint
ALTER TABLE "model_artifacts" ADD COLUMN "source_ref" text NOT NULL;--> statement-breakpoint
ALTER TABLE "license_acceptances" ADD CONSTRAINT "license_acceptances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_acceptances" ADD CONSTRAINT "license_acceptances_model_artifact_id_model_artifacts_id_fk" FOREIGN KEY ("model_artifact_id") REFERENCES "public"."model_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fit_calibrations_runtime_version_idx" ON "fit_calibrations" USING btree ("runtime","catalog_version");