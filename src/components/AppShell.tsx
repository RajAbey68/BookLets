'use client';

import React, { useState } from 'react';
import Sidebar from './Sidebar';
import AppHeader from './AppHeader';

interface AppShellProps {
  children: React.ReactNode;
  orgName?: string;
  userName?: string;
  userImage?: string;
  userRole?: string;
}

export default function AppShell({ children, orgName, userName, userImage, userRole }: AppShellProps) {
  const [isSidebarOpen, setSidebarOpen] = useState(false);

  const toggleSidebar = () => setSidebarOpen(!isSidebarOpen);
  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="app-shell">
      {isSidebarOpen && (
        <div
          onClick={closeSidebar}
          className="mobile-overlay lg-hidden"
        />
      )}

      <Sidebar isOpen={isSidebarOpen} />

      <div className="main-wrapper">
        <AppHeader
          onMenuClick={toggleSidebar}
          orgName={orgName}
          userName={userName}
          userImage={userImage}
          userRole={userRole}
        />
        <main className="main-content" onClick={closeSidebar}>
          {children}
        </main>
      </div>
    </div>
  );
}
