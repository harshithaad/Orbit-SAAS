-- DropIndex
DROP INDEX "Subscription_stripeCustomerId_key";

-- DropIndex
DROP INDEX "Subscription_stripeSubscriptionId_key";

-- DropIndex
DROP INDEX "WebhookEvent_stripeEventId_key";

-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "stripeCustomerId",
DROP COLUMN "stripePriceId",
DROP COLUMN "stripeSubscriptionId",
ADD COLUMN     "gatewayCustomerId" TEXT,
ADD COLUMN     "gatewayEventAt" TIMESTAMP(3),
ADD COLUMN     "gatewayPlanId" TEXT,
ADD COLUMN     "gatewaySubscriptionId" TEXT,
ADD COLUMN     "pendingTier" "PlanTier";

-- AlterTable
ALTER TABLE "WebhookEvent" DROP COLUMN "stripeEventId",
ADD COLUMN     "eventId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_gatewaySubscriptionId_key" ON "Subscription"("gatewaySubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");
