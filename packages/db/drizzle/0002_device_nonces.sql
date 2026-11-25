CREATE TABLE "device_nonces" (
	"install_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_nonces_install_id_nonce_pk" PRIMARY KEY("install_id","nonce")
);
--> statement-breakpoint
ALTER TABLE "nodes" ALTER COLUMN "disk_budget_bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "device_nonces" ADD CONSTRAINT "device_nonces_install_id_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."installs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_nonces_seen_idx" ON "device_nonces" USING btree ("seen_at");