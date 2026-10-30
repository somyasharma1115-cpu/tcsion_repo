import { useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Navigation,
  RotateCcw,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react';
import type { EmergencyRun, Intersection, LightColor, SystemSnapshot } from '../types';
import type { StartRunPayload } from '../hooks/useRescueRouteSync';
import { CorridorMapView } from './CorridorMapView';

interface ControlDashboardViewProps {
  snapshot: SystemSnapshot;
  operatorName: string;
  wsRttMs: number;
  onControlIntersection: (
    intersectionId: string,
    action: 'FORCE_NS_GREEN' | 'FORCE_EW_GREEN' | 'SET_AUTO' | 'TOGGLE_OFFLINE',
    durationSec?: number,
    operatorName?: string
  ) => Promise<void>;
  onStartRun: (payload: StartRunPayload) => Promise<EmergencyRun>;
  onEndRun: (runId: string, status?: 'COMPLETED' | 'CANCELLED') => Promise<EmergencyRun>;
  onCrossNext: (runId: string) => Promise<EmergencyRun>;
  onOpenDriverConsole: () => void;
}

function lampStyle(color: LightColor, active: boolean) {
  if (!active) return 'bg-slate-200 border-slate-300';
  if (color === 'GREEN') return 'bg-emerald-600 border-emerald-700';
  if (color === 'AMBER') return 'bg-amber-500 border-amber-600';
  return 'bg-red-600 border-red-700';
}

function operationalStateText(int: Intersection): { label: string; toneClass: string } {
  if (int.operationalStatus === 'OFFLINE') {
    return { label: 'Controller Offline (Amber Blink)', toneClass: 'text-red-700 font-semibold' };
  }
  if (int.operationalStatus === 'PRIORITY_ACTIVE') {
    return {
      label: `Green Corridor Active (${int.activePriorityDirection} Priority)`,
      toneClass: 'text-emerald-700 font-semibold',
    };
  }
  if (int.operationalStatus === 'MANUAL_OVERRIDE') {
    return { label: 'Operator Manual Override', toneClass: 'text-blue-700 font-semibold' };
  }
  if (int.operationalStatus === 'APPROACHING') {
    return {
      label: `Emergency Approaching (${int.nextArrivalEtaSec ?? '--'}s)`,
      toneClass: 'text-amber-700 font-medium',
    };
  }
  return { label: 'Auto Fixed-Time Cycle', toneClass: 'text-slate-600' };
}

export function ControlDashboardView({
  snapshot,
  operatorName,
  wsRttMs,
  onControlIntersection,
  onStartRun,
  onEndRun,
  onCrossNext,
  onOpenDriverConsole,
}: ControlDashboardViewProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedIntersectionId, setSelectedIntersectionId] = useState<string>('I1');
  const [zoneFilter, setZoneFilter] = useState<string>('ALL');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  const activeRun =
    snapshot.activeRuns.find((r) => r.id === selectedRunId) ?? snapshot.activeRuns[0] ?? null;

  const priorityActiveCount = snapshot.intersections.filter(
    (i) => i.operationalStatus === 'PRIORITY_ACTIVE'
  ).length;

  const avgSyncLatency =
    snapshot.commandLogs.length > 0
      ? Math.round(
          snapshot.commandLogs.slice(0, 12).reduce((acc, c) => acc + c.latencyMs, 0) /
            Math.min(12, snapshot.commandLogs.length)
        )
      : wsRttMs;

  const cumulativeSavedSec =
    snapshot.completedRuns.reduce((s, r) => s + r.totalSecondsSaved, 0) +
    snapshot.activeRuns.reduce((s, r) => s + r.totalSecondsSaved, 0);

  const zones = ['ALL', ...Array.from(new Set(snapshot.intersections.map((i) => i.zone)))];
  const filteredIntersections =
    zoneFilter === 'ALL'
      ? snapshot.intersections
      : snapshot.intersections.filter((i) => i.zone === zoneFilter);

  async function handleQuickDispatchDemo(type: 'AMBULANCE' | 'FIRE') {
    setBusyAction(`demo-${type}`);
    setActionFeedback(null);
    try {
      const candidateVehicles = snapshot.vehicles.filter(
        (v) =>
          v.type === type && !snapshot.activeRuns.some((active) => active.vehicleId === v.id)
      );
      const vehicle = candidateVehicles[0] ?? snapshot.vehicles[0];
      const corridor =
        snapshot.corridors.find((c) => c.recommendedType === type) ?? snapshot.corridors[0];
      const created = await onStartRun({
        vehicleId: vehicle.id,
        corridorId: corridor.id,
        targetSpeedKmh: type === 'AMBULANCE' ? 62 : 54,
        autoDrive: true,
        incidentNote:
          type === 'AMBULANCE'
            ? 'Control room initiated Trauma Priority Corridor'
            : 'Control room initiated Structural Fire Corridor',
      });
      setSelectedRunId(created.id);
    } catch (err) {
      setActionFeedback(err instanceof Error ? err.message : 'Unable to start dispatch');
    } finally {
      setBusyAction(null);
    }
  }

  async function triggerIntersectionControl(
    id: string,
    action: 'FORCE_NS_GREEN' | 'FORCE_EW_GREEN' | 'SET_AUTO' | 'TOGGLE_OFFLINE'
  ) {
    setBusyAction(`${id}-${action}`);
    setActionFeedback(null);
    try {
      await onControlIntersection(id, action, 15, operatorName);
    } catch (err) {
      setActionFeedback(err instanceof Error ? err.message : 'Command rejected');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* KPI Strip: Flat single-elevation container with hairline column dividers */}
      <section className="bg-white border border-slate-200 rounded-xl grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Active Emergency Runs</div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {snapshot.activeRuns.length}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            <span>{snapshot.completedRuns.length} completed today</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span>Live GPS sync</span>
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Signals Holding Priority</div>
          <div className="mt-1.5 text-2xl font-bold text-emerald-700 font-mono tabular-nums">
            {priorityActiveCount} / {snapshot.intersections.length}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            <span>Auto green corridor window</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span>&le;48s ETA</span>
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Controller Sync Latency</div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {avgSyncLatency} ms
          </div>
          <div className="mt-1 text-xs text-slate-500">
            <span>WS RTT {wsRttMs} ms</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span>Target &lt;1000 ms</span>
          </div>
        </div>

        <div className="p-5">
          <div className="text-xs font-medium text-slate-500">Cumulative Response Time Saved</div>
          <div className="mt-1.5 text-2xl font-bold text-slate-900 font-mono tabular-nums">
            {Math.floor(cumulativeSavedSec / 60)}m {cumulativeSavedSec % 60}s
          </div>
          <div className="mt-1 text-xs text-slate-500">
            <span>Compared to fixed-time signal baseline</span>
          </div>
        </div>
      </section>

      {actionFeedback && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-xs text-red-800 flex items-center justify-between">
          <span>{actionFeedback}</span>
          <button
            type="button"
            onClick={() => setActionFeedback(null)}
            className="text-xs font-medium underline whitespace-nowrap shrink-0 ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Primary 2-Column Operations Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 8 Columns: Live Map + Intersection Signal Controller Matrix */}
        <div className="lg:col-span-8 space-y-6">
          <CorridorMapView
            intersections={snapshot.intersections}
            activeRuns={snapshot.activeRuns}
            selectedRunId={activeRun?.id ?? null}
            selectedIntersectionId={selectedIntersectionId}
            onSelectIntersection={(id) => setSelectedIntersectionId(id)}
            onSelectRun={(id) => setSelectedRunId(id)}
          />

          {/* Signal Controller Matrix */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Intersection Signal Controllers
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Monitor live approach aspects or issue 15-second manual operator overrides
                </p>
              </div>

              {/* Zone Filter Segmented Control */}
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
                {zones.map((z) => (
                  <button
                    key={z}
                    type="button"
                    onClick={() => setZoneFilter(z)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      zoneFilter === z
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {z === 'ALL' ? 'All Zones' : z.replace(' Zone', '')}
                  </button>
                ))}
              </div>
            </div>

            <div className="divide-y divide-slate-200">
              {filteredIntersections.map((int) => {
                const stateMeta = operationalStateText(int);
                const isSelected = selectedIntersectionId === int.id;

                return (
                  <div
                    key={int.id}
                    onClick={() => setSelectedIntersectionId(int.id)}
                    className={`p-5 transition-colors cursor-pointer ${
                      isSelected ? 'bg-slate-50/90' : 'hover:bg-slate-50/50'
                    }`}
                  >
                    <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                      {/* Junction Identity & Ownership */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs text-slate-500 font-mono">
                          <span className="font-semibold text-slate-900">{int.id}</span>
                          <span aria-hidden="true">·</span>
                          <span>{int.controllerId}</span>
                          <span aria-hidden="true">·</span>
                          <span>{int.departmentOwner}</span>
                        </div>
                        <h3 className="text-sm font-semibold text-slate-900 mt-1">
                          {int.name}
                        </h3>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                          <span className={stateMeta.toneClass}>{stateMeta.label}</span>
                          <span className="text-slate-400" aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums text-slate-600">
                            Phase window: {int.phaseRemainingSec}s
                          </span>
                          {int.nextArrivalEtaSec !== null && (
                            <>
                              <span className="text-slate-400" aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums text-slate-800 font-medium">
                                Next unit {int.nextArrivalVehicleId} in {int.nextArrivalEtaSec}s
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* NS & EW Live Signal Heads */}
                      <div className="flex items-center gap-5 shrink-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-medium text-slate-600">NS</span>
                          <div className="flex items-center gap-1 px-2 py-1 bg-slate-900 rounded-md">
                            <span
                              className={`w-3 h-3 rounded-full border ${lampStyle(
                                'RED',
                                int.signals.NS === 'RED'
                              )}`}
                              title="NS Red"
                            />
                            <span
                              className={`w-3 h-3 rounded-full border ${lampStyle(
                                'AMBER',
                                int.signals.NS === 'AMBER'
                              )}`}
                              title="NS Amber"
                            />
                            <span
                              className={`w-3 h-3 rounded-full border ${lampStyle(
                                'GREEN',
                                int.signals.NS === 'GREEN'
                              )}`}
                              title="NS Green"
                            />
                          </div>
                          <span className="text-xs font-mono text-slate-700 w-11">
                            {int.signals.NS}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono font-medium text-slate-600">EW</span>
                          <div className="flex items-center gap-1 px-2 py-1 bg-slate-900 rounded-md">
                            <span
                              className={`w-3 h-3 rounded-full border ${lampStyle(
                                'RED',
                                int.signals.EW === 'RED'
                              )}`}
                              title="EW Red"
                            />
                            <span
                              className={`w-3 h-3 rounded-full border ${lampStyle(
                                'AMBER',
                                int.signals.EW === 'AMBER'
                              )}`}
                              title="EW Amber"
                            />
                            <span
                              className={`w-3 h-3 rounded-full border ${lampStyle(
                                'GREEN',
                                int.signals.EW === 'GREEN'
                              )}`}
                              title="EW Green"
                            />
                          </div>
                          <span className="text-xs font-mono text-slate-700 w-11">
                            {int.signals.EW}
                          </span>
                        </div>
                      </div>

                      {/* Direct Operator Override Controls */}
                      <div
                        className="flex flex-wrap items-center gap-2 shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          disabled={busyAction === `${int.id}-FORCE_NS_GREEN`}
                          onClick={() => triggerIntersectionControl(int.id, 'FORCE_NS_GREEN')}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                        >
                          Force NS Green
                        </button>
                        <button
                          type="button"
                          disabled={busyAction === `${int.id}-FORCE_EW_GREEN`}
                          onClick={() => triggerIntersectionControl(int.id, 'FORCE_EW_GREEN')}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
                        >
                          Force EW Green
                        </button>
                        {int.controlMode === 'MANUAL' || int.operationalStatus === 'OFFLINE' ? (
                          <button
                            type="button"
                            onClick={() => triggerIntersectionControl(int.id, 'SET_AUTO')}
                            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-900 text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>Return Auto</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => triggerIntersectionControl(int.id, 'TOGGLE_OFFLINE')}
                            className="px-2.5 py-1.5 text-xs font-medium rounded-lg text-slate-500 hover:text-red-700 hover:bg-red-50 transition-colors whitespace-nowrap shrink-0"
                            title="Simulate non-responsive controller fault"
                          >
                            Simulate Fault
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right 4 Columns: Active Emergency Run Detail Inspector */}
        <aside className="lg:col-span-4 space-y-6">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  Live Corridor Runs
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Real-time route progression &amp; junction ETA queue
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenDriverConsole}
                className="text-xs font-medium text-slate-700 hover:text-slate-900 underline whitespace-nowrap shrink-0"
              >
                Driver App
              </button>
            </div>

            {snapshot.activeRuns.length === 0 ? (
              <div className="p-6">
                <div className="text-sm font-medium text-slate-900">
                  No active emergency runs right now
                </div>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                  All 6 New Delhi junctions are operating on standard fixed-time cycles. Start an
                  emergency run from the Driver Console or trigger a live simulation below to watch
                  automated Green Corridor preemption.
                </p>
                <div className="mt-4 flex flex-col gap-2.5">
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => handleQuickDispatchDemo('AMBULANCE')}
                    className="w-full py-2.5 px-4 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <Navigation className="w-3.5 h-3.5" />
                    <span>Simulate Ambulance Trauma Run</span>
                  </button>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => handleQuickDispatchDemo('FIRE')}
                    className="w-full py-2.5 px-4 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-medium hover:bg-slate-50 transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
                  >
                    <span>Simulate Fire Brigade Dispatch</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <div>
                {/* Selector tabs if multiple emergency vehicles are active simultaneously */}
                {snapshot.activeRuns.length > 1 && (
                  <div className="px-4 pt-3 pb-2 border-b border-slate-100 flex items-center gap-1.5 overflow-x-auto">
                    {snapshot.activeRuns.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setSelectedRunId(r.id)}
                        className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                          activeRun?.id === r.id
                            ? 'bg-slate-900 text-white'
                            : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                      >
                        {r.vehicleId}
                      </button>
                    ))}
                  </div>
                )}

                {activeRun && (
                  <div className="p-5 space-y-5">
                    <div>
                      <div className="flex items-center justify-between text-xs text-slate-500 font-mono">
                        <span>
                          {activeRun.id} · {activeRun.vehicleType}
                        </span>
                        <span className="tabular-nums">
                          {Math.round(activeRun.progressFraction * 100)}% route complete
                        </span>
                      </div>
                      <h3 className="text-base font-bold text-slate-900 mt-1">
                        {activeRun.vehicleId} ({activeRun.callsign})
                      </h3>
                      <p className="text-xs text-slate-600 mt-1">
                        {activeRun.originName} &rarr; {activeRun.destinationName}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">{activeRun.incidentNote}</p>

                      {/* Progress bar */}
                      <div className="mt-3 h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-transform duration-300 origin-left ${
                            activeRun.vehicleType === 'FIRE' ? 'bg-red-600' : 'bg-emerald-600'
                          }`}
                          style={{
                            transform: `scaleX(${Math.max(0.04, activeRun.progressFraction)})`,
                          }}
                        />
                      </div>

                      <div className="mt-3 grid grid-cols-3 gap-2 pt-3 border-t border-slate-100 text-xs">
                        <div>
                          <div className="text-slate-500">Speed</div>
                          <div className="font-mono font-semibold tabular-nums text-slate-900 mt-0.5">
                            {activeRun.currentSpeedKmh} km/h
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-500">Telemetry</div>
                          <div className="font-mono font-semibold tabular-nums text-slate-900 mt-0.5">
                            {Math.round(
                              (activeRun.broadcastPacketsReceived /
                                Math.max(1, activeRun.broadcastPacketsExpected)) *
                                100
                            )}
                            % ok
                          </div>
                        </div>
                        <div>
                          <div className="text-slate-500">Time Saved</div>
                          <div className="font-mono font-semibold tabular-nums text-emerald-700 mt-0.5">
                            +{activeRun.totalSecondsSaved}s
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Upcoming & Passed Intersections along active route */}
                    <div>
                      <div className="text-xs font-semibold text-slate-900 mb-2.5">
                        Corridor Intersection Sequence
                      </div>
                      <div className="divide-y divide-slate-100 border-t border-b border-slate-100">
                        {activeRun.intersectionProgress.map((prog) => {
                          const liveInt = snapshot.intersections.find(
                            (i) => i.id === prog.intersectionId
                          );
                          const approachAspect = liveInt
                            ? liveInt.signals[prog.approachDirection]
                            : 'RED';

                          return (
                            <div
                              key={prog.intersectionId}
                              onClick={() => setSelectedIntersectionId(prog.intersectionId)}
                              className="py-2.5 flex items-center justify-between gap-3 cursor-pointer hover:bg-slate-50 px-1 rounded"
                            >
                              <div className="min-w-0">
                                <div className="text-xs font-medium text-slate-900 truncate">
                                  {prog.intersectionId} · {prog.intersectionName}
                                </div>
                                <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                                  <span>Approach {prog.approachDirection}</span>
                                  <span className="mx-1.5" aria-hidden="true">·</span>
                                  <span>
                                    {prog.status === 'PASSED'
                                      ? `Cleared (Delay ${prog.delaySec ?? 0}s · Saved ${prog.secondsSaved ?? 0}s)`
                                      : `${prog.distanceRemainingM}m ahead`}
                                  </span>
                                </div>
                              </div>

                              <div className="text-right shrink-0 font-mono text-xs tabular-nums">
                                {prog.status === 'PASSED' ? (
                                  <span className="text-slate-500 inline-flex items-center gap-1">
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                    Passed
                                  </span>
                                ) : prog.status === 'PRIORITY_SYNCED' || prog.status === 'CROSSING' ? (
                                  <div>
                                    <div className="text-emerald-700 font-semibold">
                                      {approachAspect} · {prog.etaSec}s
                                    </div>
                                    <div className="text-[10px] text-emerald-600">Priority Synced</div>
                                  </div>
                                ) : (
                                  <div>
                                    <div className="text-slate-800 font-medium">
                                      ETA {prog.etaSec}s
                                    </div>
                                    <div className="text-[10px] text-slate-500">
                                      Now {approachAspect}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Operator Run Controls */}
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => onCrossNext(activeRun.id)}
                        className="flex-1 py-2 px-3 rounded-lg border border-slate-300 bg-white text-slate-800 text-xs font-medium hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                      >
                        Step Next Junction
                      </button>
                      <button
                        type="button"
                        onClick={() => onEndRun(activeRun.id, 'COMPLETED')}
                        className="py-2 px-3 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                      >
                        Complete Run
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Live Signal Command Stream Preview */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                Recent Hardware Signal Commands
              </h3>
              <SlidersHorizontal className="w-4 h-4 text-slate-400" />
            </div>
            <div className="divide-y divide-slate-100 max-h-[260px] overflow-y-auto">
              {snapshot.commandLogs.slice(0, 8).map((cmd) => (
                <div key={cmd.id} className="px-5 py-2.5 text-xs">
                  <div className="flex items-center justify-between text-slate-500 font-mono text-[11px]">
                    <span>
                      {cmd.intersectionId} · {cmd.controllerId}
                    </span>
                    <span className="tabular-nums">
                      {new Date(cmd.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}{' '}
                      ({cmd.latencyMs}ms)
                    </span>
                  </div>
                  <div className="font-mono text-xs text-slate-900 mt-1 truncate">
                    {cmd.serialFrame}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1.5">
                    {cmd.commandType === 'FAULT_SIMULATION' ? (
                      <TriangleAlert className="w-3 h-3 text-red-600 shrink-0" />
                    ) : (
                      <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                    )}
                    <span className="truncate">{cmd.issuedBy}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
