-- Migration: RAJ-649 BI Cube Notes/Minutes layer
-- Reason: The BI Cube page reads a separate, read-only Ko Lake Supabase fact
--         table (scrap.cube_bi). The value-add is a writable Notes/Minutes
--         layer stored in BookLets' OWN Postgres — bookkeeping minutes,
--         bad-debtor flags, queries, and upload flags on uploaded extracts.
--         Follows the maker/checker four-eyes pattern (authorIdentity = maker,
--         checkerIdentity + verifiedAt = a DISTINCT checker's sign-off).

CREATE TYPE "CubeNoteTag" AS ENUM ('BAD_DEBTOR', 'UPLOAD_FLAG', 'QUERY', 'MINUTE');

CREATE TABLE "CubeNote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tag" "CubeNoteTag" NOT NULL,
    "period" TEXT,
    "uploadBatchId" TEXT,
    "linkedRef" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "authorIdentity" TEXT NOT NULL,
    "checkerIdentity" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CubeNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CubeNote_organizationId_idx" ON "CubeNote"("organizationId");
CREATE INDEX "CubeNote_organizationId_tag_idx" ON "CubeNote"("organizationId", "tag");
CREATE INDEX "CubeNote_organizationId_period_idx" ON "CubeNote"("organizationId", "period");
CREATE INDEX "CubeNote_organizationId_resolved_idx" ON "CubeNote"("organizationId", "resolved");
