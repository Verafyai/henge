ALTER TYPE "public"."revocation_target" ADD VALUE 'platform';--> statement-breakpoint
CREATE TABLE "platform_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key_id" text NOT NULL,
	"public_key" text NOT NULL,
	"purpose" text NOT NULL,
	"status" "key_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"result_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"receipt_json" jsonb NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_artifacts" ALTER COLUMN "context_length" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "revocations" ADD COLUMN "action" text DEFAULT 'revoke' NOT NULL;--> statement-breakpoint
ALTER TABLE "revocations" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "revocations" ADD COLUMN "actor_account_id" uuid;--> statement-breakpoint
ALTER TABLE "revocations" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_result_id_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_keys_key_id_idx" ON "platform_keys" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "receipts_account_idx" ON "receipts" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "revocations" ADD CONSTRAINT "revocations_actor_account_id_accounts_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revocations_idempotency_idx" ON "revocations" USING btree ("idempotency_key");