'use client';

import React, { useState } from 'react';
import Sidebar from './Sidebar';
import AppHeader from './AppHeader';

interface AppShellProps {
  children: React.ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const [isSidebarOpen, setSidebarOpen] = useState(false);

  const toggleSidebar = () => setSidebarOpen(!isSidebarOpen);
  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="app-shell">
      {/* Overlay for mobile when sidebar is open */}
      {isSidebarOpen && (
        <div
          onClick={closeSidebar}
          className="mobile-overlay lg-hidden"
        />
      )}
      
      <Sidebar isOpen={isSidebarOpen} />
      
      <div className="main-wrapper">
        <AppHeader onMenuClick={toggleSidebar} />
        <main className="main-content" onClick={closeSidebar}>
          {children}
        </main>
      </div>
    </div>
  );
}
