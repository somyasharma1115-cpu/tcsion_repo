import { useEffect, useState } from 'react';
import {
  BarChart3,
  Cpu,
  LayoutDashboard,
  Navigation,
  Users,
} from 'lucide-react';
import { useRescueRouteSync } from './hooks/useRescueRouteSync';
import type { UserAccount } from './types';
import { ControlDashboardView } from './components/ControlDashboardView';
import { DriverMobileView } from './components/DriverMobileView';
import { ArduinoHardwareView } from './components/ArduinoHardwareView';
import { AnalyticsGovernanceView } from './components/AnalyticsGovernanceView';
import { FleetAndRolesView } from './components/FleetAndRolesView';

type WorkspaceSection = 'CONTROL' | 'DRIVER' | 'HARDWARE' | 'ANALYTICS' | 'FLEET';

const NAV_ITEMS: Array<{
  id: WorkspaceSection;
  label: string;
  shortLabel: string;
  breadcrumb: string;
  icon: typeof LayoutDashboard;
}> = [
  {
    id: 'CONTROL',
    label: 'Control Dashboard',
    shortLabel: 'Control',
    breadcrumb: 'Live Corridor Control',
    icon: LayoutDashboard,
  },
  {
    id: 'DRIVER',
    label: 'Driver Mobile App',
    shortLabel: 'Driver',
    breadcrumb: 'Emergency Route Broadcast',
    icon: Navigation,
  },
  {
    id: 'HARDWARE',
    label: 'Arduino Signal Rig',
    shortLabel: 'Hardware',
    breadcrumb: 'Signal Controller Model',
    icon: Cpu,
  },
  {
    id: 'ANALYTICS',
    label: 'Analytics & Reports',
    shortLabel: 'Analytics',
    breadcrumb: 'Delay & Governance Audit',
    icon: BarChart3,
  },
  {
    id: 'FLEET',
    label: 'Roles & Fleet',
    shortLabel: 'Fleet',
    breadcrumb: 'Users & Vehicle Registry',
    icon: Users,
  },
];

export default function App() {
  const {
    snapshot,
    connected,
    loading,
    error,
    wsRttMs,
    startEmergencyRun,
    broadcastLocation,
    rerouteRun,
    crossNextIntersection,
    endEmergencyRun,
    controlIntersection,
    registerVehicle,
  } = useRescueRouteSync();

  const [activeSection, setActiveSection] = useState<WorkspaceSection>('CONTROL');
  const [selectedUserId, setSelectedUserId] = useState<string>(() => {
    try {
      return localStorage.getItem('rescueroute_user_id') || 'USR-OPR-01';
    } catch {
      return 'USR-OPR-01';
    }
  });

  const currentUser: UserAccount =
    snapshot?.users.find((u) => u.id === selectedUserId) ??
    snapshot?.users[2] ?? {
      id: 'USR-OPR-01',
      name: 'Ananya Verma',
      role: 'OPERATOR',
      organization: 'Integrated Traffic Control Room (ITCR)',
      badgeCode: 'ITCR-OP-14',
    };

  useEffect(() => {
    try {
      localStorage.setItem('rescueroute_user_id', currentUser.id);
    } catch {
      // Ignore storage restriction
    }
  }, [currentUser.id]);

  function handleSelectUser(user: UserAccount) {
    setSelectedUserId(user.id);
    if (user.role === 'DRIVER') setActiveSection('DRIVER');
    else if (user.role === 'ADMIN') setActiveSection('ANALYTICS');
    else setActiveSection('CONTROL');
  }

  const currentNavMeta = NAV_ITEMS.find((n) => n.id === activeSection) ?? NAV_ITEMS[0];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col lg:flex-row">
      {/* Desktop Left Sidebar Navigation (260px) */}
      <aside className="hidden lg:flex lg:w-64 lg:shrink-0 bg-white border-r border-slate-200 flex-col justify-between sticky top-0 h-screen">
        <div className="p-5 space-y-6">
          {/* Brand Wordmark */}
          <div className="px-2">
            <div className="text-lg font-bold tracking-tight text-slate-900 font-display whitespace-nowrap">
              RescueRoute
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              Signal Sync &amp; Green Corridor
            </div>
          </div>

          {/* Primary Workspace Links */}
          <nav className="space-y-1" aria-label="Workspace Navigation">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveSection(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </span>
                  {item.id === 'CONTROL' && snapshot && snapshot.activeRuns.length > 0 && (
                    <span
                      className={`font-mono text-xs tabular-nums ${
                        isActive ? 'text-emerald-300' : 'text-emerald-700 font-semibold'
                      }`}
                    >
                      {snapshot.activeRuns.length}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Authenticated Profile Card */}
        <div className="p-4 border-t border-slate-200">
          <button
            type="button"
            onClick={() => setActiveSection('FLEET')}
            className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <div className="text-xs font-mono text-slate-500">
              {currentUser.role} · {currentUser.badgeCode}
            </div>
            <div className="text-sm font-semibold text-slate-900 truncate mt-0.5">
              {currentUser.name}
            </div>
            <div className="text-[11px] text-slate-500 truncate mt-0.5">
              {connected ? `Live WebSocket (${wsRttMs}ms)` : 'Reconnecting stream...'}
            </div>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col pb-20 lg:pb-0">
        {/* Top Bar Contract: Breadcrumb Trail on Left — Primary Action on Right */}
        <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-xs border-b border-slate-200 px-4 sm:px-6 lg:px-8 h-14 flex items-center justify-between gap-8">
          <div className="flex items-center gap-2 text-sm min-w-0 truncate">
            <span className="font-bold text-slate-900 lg:font-medium lg:text-slate-500 whitespace-nowrap">
              RescueRoute
            </span>
            <span className="text-slate-300" aria-hidden="true">
              /
            </span>
            <span className="hidden sm:inline text-slate-500 whitespace-nowrap">Delhi NCR</span>
            <span className="hidden sm:inline text-slate-300" aria-hidden="true">
              /
            </span>
            <span className="font-semibold text-slate-900 truncate">
              {currentNavMeta.breadcrumb}
            </span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {activeSection !== 'DRIVER' ? (
              <button
                type="button"
                onClick={() => setActiveSection('DRIVER')}
                className="px-4 py-2 text-xs font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors whitespace-nowrap shrink-0"
              >
                New Emergency Run
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setActiveSection('CONTROL')}
                className="px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                Open Control Map
              </button>
            )}
          </div>
        </header>

        {/* Page Viewport */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {loading && !snapshot ? (
            <div className="space-y-6">
              <div className="h-24 bg-white border border-slate-200 rounded-xl animate-pulse" />
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8 h-[440px] bg-white border border-slate-200 rounded-xl animate-pulse" />
                <div className="lg:col-span-4 h-[440px] bg-white border border-slate-200 rounded-xl animate-pulse" />
              </div>
            </div>
          ) : error && !snapshot ? (
            <div className="bg-white border border-red-200 rounded-xl p-6 text-sm text-red-800">
              Unable to connect to RescueRoute Signal Sync server: {error}
            </div>
          ) : snapshot ? (
            <>
              {activeSection === 'CONTROL' && (
                <ControlDashboardView
                  snapshot={snapshot}
                  operatorName={currentUser.name}
                  wsRttMs={wsRttMs}
                  onControlIntersection={controlIntersection}
                  onStartRun={startEmergencyRun}
                  onEndRun={endEmergencyRun}
                  onCrossNext={crossNextIntersection}
                  onOpenDriverConsole={() => setActiveSection('DRIVER')}
                />
              )}

              {activeSection === 'DRIVER' && (
                <DriverMobileView
                  snapshot={snapshot}
                  onStartRun={startEmergencyRun}
                  onBroadcastLocation={broadcastLocation}
                  onRerouteRun={rerouteRun}
                  onCrossNext={crossNextIntersection}
                  onEndRun={endEmergencyRun}
                />
              )}

              {activeSection === 'HARDWARE' && (
                <ArduinoHardwareView
                  snapshot={snapshot}
                  operatorName={currentUser.name}
                  onControlIntersection={controlIntersection}
                />
              )}

              {activeSection === 'ANALYTICS' && (
                <AnalyticsGovernanceView snapshot={snapshot} />
              )}

              {activeSection === 'FLEET' && (
                <FleetAndRolesView
                  snapshot={snapshot}
                  currentUser={currentUser}
                  onSelectUser={handleSelectUser}
                  onRegisterVehicle={registerVehicle}
                />
              )}
            </>
          ) : null}
        </main>
      </div>

      {/* Mobile Fixed Bottom Navigation Bar (<15% viewport height cap, >=44px touch targets) */}
      <nav
        aria-label="Mobile Navigation"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200 grid grid-cols-5 h-15"
      >
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = activeSection === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveSection(item.id)}
              className={`min-h-[44px] flex flex-col items-center justify-center transition-colors ${
                isActive ? 'text-red-600 font-semibold' : 'text-slate-500 hover:text-slate-900'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] mt-0.5 tracking-tight whitespace-nowrap">
                {item.shortLabel}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
