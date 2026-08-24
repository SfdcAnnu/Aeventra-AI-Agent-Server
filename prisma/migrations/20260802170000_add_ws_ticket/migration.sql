-- CreateTable
CREATE TABLE "WsTicket" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentApiName" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WsTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WsTicket_orgId_idx" ON "WsTicket"("orgId");
