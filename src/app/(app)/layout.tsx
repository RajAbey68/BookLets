import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import AppShell from '@/components/AppShell';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  let orgName = 'Portfolio';
  let userRole = '';
  if (session?.user?.id) {
    try {
      const membership = await prisma.membership.findFirst({
        where: { userId: session.user.id },
        orderBy: { createdAt: 'desc' },
        include: { organization: true },
      });
      if (membership) {
        orgName = membership.organization.name;
        userRole = membership.role;
      }
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
    >
      {children}
    </AppShell>
  );
}
