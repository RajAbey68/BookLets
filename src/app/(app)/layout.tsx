import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import AppShell from '@/components/AppShell';
import { fetchDraftReviewCount } from '@/app/actions/approval.actions';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  let orgName = 'Portfolio';
  let userRole = '';
  let reviewCount = 0;
  if (session?.user?.id) {
    try {
      // Sidebar "Review" badge (S6): org-scoped DRAFT count, resolved
      // server-side per request — fetchDraftReviewCount degrades to 0 itself.
      const [membership, draftCount] = await Promise.all([
        prisma.membership.findFirst({
          where: { userId: session.user.id },
          orderBy: { createdAt: 'desc' },
          include: { organization: true },
        }),
        fetchDraftReviewCount(),
      ]);
      if (membership) {
        orgName = membership.organization.name;
        userRole = membership.role;
      }
      reviewCount = draftCount;
    } catch {
      // DB unavailable during early boot — fall back to defaults
    }
  }

  return (
    <AppShell
      orgName={orgName}
      userName={session?.user?.name ?? undefined}
      userImage={session?.user?.image ?? undefined}
      userRole={userRole}
      reviewCount={reviewCount}
    >
      {children}
    </AppShell>
  );
}
