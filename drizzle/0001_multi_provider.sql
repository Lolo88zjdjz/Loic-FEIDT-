ALTER TABLE "model_definitions" ADD COLUMN "cost_class" text DEFAULT 'paid' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_definitions" ADD COLUMN "quality_tier" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_definitions" ADD COLUMN "quality_basis" text;--> statement-breakpoint
ALTER TABLE "model_definitions" ADD COLUMN "supports_tools" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_definitions" ADD COLUMN "supports_web_search" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_definitions" ADD COLUMN "parameter_size" text;--> statement-breakpoint
ALTER TABLE "model_definitions" ADD COLUMN "free_limits" text;--> statement-breakpoint
ALTER TABLE "model_definitions" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;