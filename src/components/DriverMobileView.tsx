import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Compass,
  LocateFixed,
  Navigation,
  Route,
  Square,
  Truck,
} from 'lucide-react';
import type { AgencyType, EmergencyRun, SystemSnapshot } from '../types';
import type { StartRunPayload } from '../hooks/useRescueRouteSync';
import { CorridorMapView } from './CorridorMapView';

interface DriverMobileViewProps {
  snapshot: SystemSnapshot;
  onStartRun: (payload: StartRunPayload) => Promise<EmergencyRun>;
  onBroadcastLocation: (
    runId: string,
    payload: {
      lat?: number;
      lng?: number;
      speedKmh?: number;
      advanceMeters?: number;
      autoDrive?: boolean;
    }
  ) => Promise<{ ok: boolean; latencyMs: number; run: EmergencyRun }>;
  onRerouteRun: (runId: string) => Promise<EmergencyRun>;
  onCrossNext: (runId: string) => Promise<EmergencyRun>;
  onEndRun: (runId: string, status?: 'COMPLETED' | 'CANCELLED') => Promise<EmergencyRun>;
}

export function DriverMobileView({
  snapshot,
  onStartRun,
  onBroadcastLocation,
  onRerouteRun,
  onCrossNext,
  onEndRun,
}: DriverMobileViewProps) {
  const [agencyFilter, setAgencyFilter] = useState<AgencyType>('AMBULANCE');
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>('AMB-DL-023');
  const [routeMode, setRouteMode] = useState<'PRESET' | 'CUSTOM'>('PRESET');
  const [selectedCorridorId, setSelectedCorridorId] = useState<string>('COR-TRAUMA-EW');
  const [customOriginId, setCustomOriginId] = useState<string>('I3');
  const [customDestId, setCustomDestId] = useState<string>('I1');
  const [targetSpeedKmh, setTargetSpeedKmh] = useState<number>(60);
  const [incidentNote, setIncidentNote] = useState<string>(
    'Critical Trauma Priority 1 — Green Corridor Request'
  );
  const [deviceGpsStreaming, setDeviceGpsStreaming] = useState<boolean>(false);
  const [gpsStatusMsg, setGpsStatusMsg] = useState<string | null>(null);
  const [lastCompletedSummary, setLastCompletedSummary] = useState<EmergencyRun | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [formError, setFormError] = useState<string | null>(null);

  const vehiclesForAgency = snapshot.vehicles.filter((v) => v.type === agencyFilter);

  // Keep selected vehicle synced with agency toggle unless an active run is already bound
  useEffect(() => {
    const currentVeh = snapshot.vehicles.find((v) => v.id === selectedVehicleId);
    if (!currentVeh || currentVeh.type !== agencyFilter) {
      const firstMatch = snapshot.vehicles.find((v) => v.type === agencyFilter);
      if (firstMatch) setSelectedVehicleId(firstMatch.id);
    }
    const matchingCorridor = snapshot.corridors.find((c) => c.recommendedType === agencyFilter);
    if (matchingCorridor) {
      setSelectedCorridorId(matchingCorridor.id);
    }
    setIncidentNote(
      agencyFilter === 'AMBULANCE'
        ? 'Critical Trauma Priority 1 — Green Corridor Request'
        : 'Multi-Tender Fire Suppression — Clear Arterial Junctions'
    );
  }, [agencyFilter, snapshot.vehicles, snapshot.corridors]);

  // Active run belonging to the currently selected vehicle (or first active run if any)
  const myActiveRun =
    snapshot.activeRuns.find((r) => r.vehicleId === selectedVehicleId) ?? null;

  // Browser HTML5 Geolocation API streaming when enabled during an active run
  useEffect(() => {
    if (!deviceGpsStreaming || !myActiveRun) return;
    if (!('geolocation' in navigator)) {
      setGpsStatusMsg('Device Geolocation unavailable; using corridor telemetry stream.');
      setDeviceGpsStreaming(false);
      return;
    }

    setGpsStatusMsg('Acquiring live device GPS coordinates...');
    const watchId = navigator.geolocation.watchPosition(
      async (pos) => {
        try {
          const speedFromGps =
            pos.coords.speed && pos.coords.speed > 1
              ? Math.round(pos.coords.speed * 3.6)
              : myActiveRun.targetSpeedKmh;
          const res = await onBroadcastLocation(myActiveRun.id, {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            speedKmh: speedFromGps,
          });
          setGpsStatusMsg(
            `GPS synced (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(
              4
            )}) · ${res.latencyMs}ms`
          );
        } catch {
          setGpsStatusMsg('GPS packet retry queued');
        }
      },
      (err) => {
        setGpsStatusMsg(`GPS permission notice (${err.message}); corridor telemetry active.`);
        setDeviceGpsStreaming(false);
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [deviceGpsStreaming, myActiveRun, onBroadcastLocation]);

  const selectedPreset =
    snapshot.corridors.find((c) => c.id === selectedCorridorId) ?? snapshot.corridors[0];

  async function handleStartEmergencyRun(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    setLastCompletedSummary(null);
    try {
      await onStartRun({
        vehicleId: selectedVehicleId,
        corridorId: routeMode === 'PRESET' ? selectedCorridorId : 'CUSTOM',
        customOriginIntersectionId: customOriginId,
        customDestIntersectionId: customDestId,
        targetSpeedKmh,
        autoDrive: true,
        incidentNote,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not activate emergency corridor');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEndCurrentRun() {
    if (!myActiveRun) return;
    setSubmitting(true);
    try {
      const completed = await onEndRun(myActiveRun.id, 'COMPLETED');
      setDeviceGpsStreaming(false);
      setLastCompletedSummary(completed);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to finalize run');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReroute() {
    if (!myActiveRun) return;
    setFormError(null);
    try {
      await onRerouteRun(myActiveRun.id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Alternate route unavailable');
    }
  }

  const nextIntersectionProg = myActiveRun
    ? myActiveRun.intersectionProgress.find((p) => p.status !== 'PASSED')
    : null;
  const nextIntersectionLive = nextIntersectionProg
    ? snapshot.intersections.find((i) => i.id === nextIntersectionProg.intersectionId)
    : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left 5 Columns: Tactile In-Cab Driver Mobile Unit Console */}
      <div className="lg:col-span-5 space-y-5">
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          {/* Driver Unit Header */}
          <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] text-slate-300 font-mono">
                In-Cab Emergency Dispatch Terminal
              </div>
              <h2 className="text-base font-bold tracking-wide mt-0.5">
                {myActiveRun
                  ? `${myActiveRun.vehicleId} · Corridor Active`
                  : 'Activate Green Corridor'}
              </h2>
            </div>
            <div className="text-right font-mono text-xs text-slate-300 tabular-nums">
              {myActiveRun ? `${myActiveRun.currentSpeedKmh} km/h` : 'Standby'}
            </div>
          </div>

          {formError && (
            <div className="px-5 py-3 bg-red-50 border-b border-red-200 text-xs text-red-800">
              {formError}
            </div>
          )}

          {/* Post-Run Summary Banner (shown right after completing an emergency run) */}
          {!myActiveRun && lastCompletedSummary && (
            <div className="p-5 bg-emerald-50/70 border-b border-emerald-200">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-emerald-900 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-700" />
                  Emergency Run Completed ({lastCompletedSummary.id})
                </span>
                <button
                  type="button"
                  onClick={() => setLastCompletedSummary(null)}
                  className="text-xs text-emerald-800 underline whitespace-nowrap shrink-0"
                >
                  Dismiss
                </button>
              </div>
              <div className="mt-2 text-xs text-slate-700 leading-relaxed font-mono tabular-nums">
                <span>
                  {lastCompletedSummary.intersectionsPrioritized} intersections prioritized
                </span>
                <span className="mx-1.5" aria-hidden="true">·</span>
                <span>Total junction delay: {lastCompletedSummary.totalDelaySec}s</span>
                <span className="mx-1.5" aria-hidden="true">·</span>
                <span className="font-semibold text-emerald-800">
                  Saved {lastCompletedSummary.totalSecondsSaved}s vs baseline
                </span>
              </div>
            </div>
          )}

          {!myActiveRun ? (
            /* STEP 1 & 2: 3-Tap Emergency Run Setup */
            <form onSubmit={handleStartEmergencyRun} className="p-5 space-y-5">
              {/* 1. Select Agency Type (Large >=48px Touch Targets) */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">
                  1. Emergency Service Agency
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setAgencyFilter('AMBULANCE')}
                    className={`min-h-[48px] px-4 py-2.5 rounded-xl border text-sm font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
                      agencyFilter === 'AMBULANCE'
                        ? 'bg-emerald-700 text-white border-emerald-700'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <Navigation className="w-4 h-4" />
                    <span>Ambulance</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAgencyFilter('FIRE')}
                    className={`min-h-[48px] px-4 py-2.5 rounded-xl border text-sm font-semibold flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 ${
                      agencyFilter === 'FIRE'
                        ? 'bg-red-600 text-white border-red-600'
                        : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <Truck className="w-4 h-4" />
                    <span>Fire Brigade</span>
                  </button>
                </div>
              </div>

              {/* 2. Select Registered Vehicle ID */}
              <div>
                <label
                  htmlFor="driver-vehicle-select"
                  className="block text-xs font-semibold text-slate-700 mb-1.5"
                >
                  2. Assigned Vehicle Unit
                </label>
                <select
                  id="driver-vehicle-select"
                  value={selectedVehicleId}
                  onChange={(e) => setSelectedVehicleId(e.target.value)}
                  className="w-full min-h-[46px] px-3.5 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  {vehiclesForAgency.map((v) => {
                    const busy = snapshot.activeRuns.some((r) => r.vehicleId === v.id);
                    return (
                      <option key={v.id} value={v.id}>
                        {v.id} — {v.callsign} ({v.baseStation}){busy ? ' [ACTIVE]' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>

              {/* 3. Select Corridor or Custom Origin/Destination */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-slate-700">
                    3. Emergency Destination &amp; Route
                  </label>
                  <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setRouteMode('PRESET')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        routeMode === 'PRESET'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600'
                      }`}
                    >
                      Saved Corridors
                    </button>
                    <button
                      type="button"
                      onClick={() => setRouteMode('CUSTOM')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                        routeMode === 'CUSTOM'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600'
                      }`}
                    >
                      Custom Stops
                    </button>
                  </div>
                </div>

                {routeMode === 'PRESET' ? (
                  <div className="space-y-2">
                    {snapshot.corridors.map((c) => {
                      const active = selectedCorridorId === c.id;
                      const intCount = c.waypoints.filter((w) => w.intersectionId).length;
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setSelectedCorridorId(c.id)}
                          className={`w-full text-left p-3.5 rounded-xl border transition-colors ${
                            active
                              ? 'border-slate-900 bg-slate-50'
                              : 'border-slate-200 bg-white hover:bg-slate-50/60'
                          }`}
                        >
                          <div className="text-sm font-semibold text-slate-900">{c.name}</div>
                          <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                            <span>{c.distanceKm} km</span>
                            <span className="mx-1.5" aria-hidden="true">·</span>
                            <span>{intCount} signalized junctions</span>
                            <span className="mx-1.5" aria-hidden="true">·</span>
                            <span>{c.recommendedType}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3.5 bg-slate-50 rounded-xl border border-slate-200">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        Origin Sector Junction
                      </label>
                      <select
                        value={customOriginId}
                        onChange={(e) => setCustomOriginId(e.target.value)}
                        className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-900"
                      >
                        {snapshot.intersections.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.id} — {i.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1">
                        Destination Hospital / Incident
                      </label>
                      <select
                        value={customDestId}
                        onChange={(e) => setCustomDestId(e.target.value)}
                        className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-900"
                      >
                        {snapshot.intersections.map((i) => (
                          <option key={i.id} value={i.id} disabled={i.id === customOriginId}>
                            {i.id} — {i.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>

              {/* Dispatch Speed & Note */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Target Speed ({targetSpeedKmh} km/h)
                  </label>
                  <input
                    type="range"
                    min={35}
                    max={90}
                    step={5}
                    value={targetSpeedKmh}
                    onChange={(e) => setTargetSpeedKmh(Number(e.target.value))}
                    className="w-full accent-slate-900 mt-2"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Dispatch Note
                  </label>
                  <input
                    type="text"
                    value={incidentNote}
                    onChange={(e) => setIncidentNote(e.target.value)}
                    className="w-full min-h-[42px] px-3 py-1.5 rounded-lg border border-slate-300 text-xs text-slate-900"
                  />
                </div>
              </div>

              {/* Primary Thumb-Zone CTA */}
              <button
                type="submit"
                disabled={submitting}
                className="w-full min-h-[52px] px-5 py-3 rounded-xl bg-red-600 text-white text-sm font-bold hover:bg-red-700 active:scale-[0.99] transition-all flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
              >
                <Compass className="w-4 h-4" />
                <span>Start Run &amp; Broadcast Green Corridor</span>
              </button>
            </form>
          ) : (
            /* ACTIVE EMERGENCY RUN IN-CAB HUD */
            <div className="p-5 space-y-5">
              {/* Next Signal Priority Banner */}
              <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200">
                <div className="text-xs font-medium text-emerald-900">
                  {nextIntersectionProg
                    ? `Approaching ${nextIntersectionProg.intersectionId} · ${nextIntersectionProg.intersectionName}`
                    : 'Final Approach to Destination'}
                </div>

                {nextIntersectionProg && nextIntersectionLive ? (
                  <div className="mt-1.5 flex items-baseline justify-between gap-2">
                    <div className="text-lg font-bold text-emerald-950">
                      {nextIntersectionLive.signals[nextIntersectionProg.approachDirection] ===
                      'GREEN'
                        ? `${nextIntersectionProg.approachDirection} GREEN — Priority Active`
                        : `${nextIntersectionProg.approachDirection} ${
                            nextIntersectionLive.signals[nextIntersectionProg.approachDirection]
                          } — Preempting`}
                    </div>
                    <div className="font-mono text-base font-bold tabular-nums text-emerald-900">
                      ETA {nextIntersectionProg.etaSec ?? '--'}s
                    </div>
                  </div>
                ) : (
                  <div className="mt-1 text-base font-bold text-emerald-950">
                    All corridor junctions cleared
                  </div>
                )}

                <div className="mt-2 text-xs text-emerald-800 font-mono tabular-nums">
                  <span>
                    {
                      myActiveRun.intersectionProgress.filter((p) => p.status !== 'PASSED').length
                    }{' '}
                    junctions ahead
                  </span>
                  <span className="mx-1.5" aria-hidden="true">·</span>
                  <span>Sync latency {myActiveRun.lastSyncLatencyMs}ms</span>
                  <span className="mx-1.5" aria-hidden="true">·</span>
                  <span>Time saved +{myActiveRun.totalSecondsSaved}s</span>
                </div>
              </div>

              {/* Live GPS & Telemetry Controls */}
              <div className="space-y-3 pt-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-800">
                    Live GPS Broadcast ({myActiveRun.currentLat.toFixed(4)},{' '}
                    {myActiveRun.currentLng.toFixed(4)})
                  </span>
                  <span className="font-mono tabular-nums text-slate-500">
                    Packets: {myActiveRun.broadcastPacketsReceived}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() =>
                      onBroadcastLocation(myActiveRun.id, {
                        autoDrive: !myActiveRun.autoDrive,
                      })
                    }
                    className="min-h-[46px] px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    {myActiveRun.autoDrive ? 'Pause Auto-Drive' : 'Resume Auto-Drive'}
                  </button>

                  <button
                    type="button"
                    onClick={() => setDeviceGpsStreaming((v) => !v)}
                    className={`min-h-[46px] px-3 py-2 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                      deviceGpsStreaming
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <LocateFixed className="w-3.5 h-3.5" />
                    <span>{deviceGpsStreaming ? 'Device GPS On' : 'Use Device GPS'}</span>
                  </button>
                </div>

                {gpsStatusMsg && (
                  <p className="text-[11px] font-mono text-slate-600">{gpsStatusMsg}</p>
                )}

                {/* Speed & Prototype Step Controls */}
                <div className="pt-2">
                  <div className="flex items-center justify-between text-xs text-slate-600 mb-1">
                    <span>Vehicle Cruise Speed</span>
                    <span className="font-mono font-semibold tabular-nums text-slate-900">
                      {myActiveRun.targetSpeedKmh} km/h
                    </span>
                  </div>
                  <input
                    type="range"
                    min={30}
                    max={95}
                    step={5}
                    value={myActiveRun.targetSpeedKmh}
                    onChange={(e) =>
                      onBroadcastLocation(myActiveRun.id, {
                        speedKmh: Number(e.target.value),
                      })
                    }
                    className="w-full accent-slate-900"
                  />
                </div>

                {/* Dynamic Reroute (Road Blockage) & Geofence Crossing Test */}
                <div className="grid grid-cols-2 gap-2.5 pt-1">
                  <button
                    type="button"
                    disabled={myActiveRun.rerouted}
                    onClick={handleReroute}
                    className="min-h-[46px] px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-45 transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <Route className="w-3.5 h-3.5" />
                    <span>{myActiveRun.rerouted ? 'Rerouted Active' : 'Blockage Reroute'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onCrossNext(myActiveRun.id)}
                    className="min-h-[46px] px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    Cross Next Junction
                  </button>
                </div>
              </div>

              {/* End Emergency Run Primary Button */}
              <div className="pt-2 border-t border-slate-200">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleEndCurrentRun}
                  className="w-full min-h-[50px] px-4 py-3 rounded-xl bg-slate-900 text-white text-sm font-bold hover:bg-slate-800 transition-colors flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>End Emergency Run (Arrived)</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right 7 Columns: Live Driver Route Preview & Corridor Signal Sequence */}
      <div className="lg:col-span-7 space-y-6">
        <CorridorMapView
          intersections={snapshot.intersections}
          activeRuns={myActiveRun ? [myActiveRun] : snapshot.activeRuns}
          selectedRunId={myActiveRun?.id ?? null}
          previewWaypoints={!myActiveRun && routeMode === 'PRESET' ? selectedPreset?.waypoints : undefined}
          heightClass="h-[380px]"
        />

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900">
              {myActiveRun
                ? `Live Corridor Checkpoints — ${myActiveRun.originName} to ${myActiveRun.destinationName}`
                : `Planned Corridor Signal Sequence — ${selectedPreset?.name}`}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Signals automatically switch to green when emergency vehicle ETA enters the 48-second
              window
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 bg-slate-50/70">
                  <th className="py-2.5 px-4">Junction</th>
                  <th className="py-2.5 px-4">Approach</th>
                  <th className="py-2.5 px-4">Live Signal</th>
                  <th className="py-2.5 px-4 text-right">Distance / ETA</th>
                  <th className="py-2.5 px-4 text-right">Corridor State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {myActiveRun
                  ? myActiveRun.intersectionProgress.map((p) => {
                      const intObj = snapshot.intersections.find((i) => i.id === p.intersectionId);
                      const aspect = intObj ? intObj.signals[p.approachDirection] : 'RED';
                      return (
                        <tr key={p.intersectionId} className="hover:bg-slate-50/60">
                          <td className="py-3 px-4 font-medium text-slate-900">
                            {p.intersectionId} · {p.intersectionName}
                          </td>
                          <td className="py-3 px-4 font-mono text-slate-600">
                            {p.approachDirection}
                          </td>
                          <td className="py-3 px-4 font-mono font-semibold">
                            <span
                              className={
                                aspect === 'GREEN'
                                  ? 'text-emerald-700'
                                  : aspect === 'AMBER'
                                  ? 'text-amber-700'
                                  : 'text-red-700'
                              }
                            >
                              {aspect}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700">
                            {p.status === 'PASSED'
                              ? '0m'
                              : `${p.distanceRemainingM}m · ${p.etaSec ?? '--'}s`}
                          </td>
                          <td className="py-3 px-4 text-right font-mono text-slate-700">
                            {p.status === 'PASSED'
                              ? `Passed (-${p.secondsSaved ?? 0}s saved)`
                              : p.status === 'PRIORITY_SYNCED' || p.status === 'CROSSING'
                              ? 'Green Priority Active'
                              : 'Monitoring ETA'}
                          </td>
                        </tr>
                      );
                    })
                  : selectedPreset?.waypoints
                      .filter((w) => w.intersectionId)
                      .map((w) => {
                        const intObj = snapshot.intersections.find(
                          (i) => i.id === w.intersectionId
                        );
                        const axis = w.approachDirection ?? 'NS';
                        const aspect = intObj ? intObj.signals[axis] : 'RED';
                        return (
                          <tr key={w.intersectionId} className="hover:bg-slate-50/60">
                            <td className="py-3 px-4 font-medium text-slate-900">
                              {w.intersectionId} · {intObj?.name ?? w.label}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-600">{axis}</td>
                            <td className="py-3 px-4 font-mono font-semibold">
                              <span
                                className={
                                  aspect === 'GREEN'
                                    ? 'text-emerald-700'
                                    : aspect === 'AMBER'
                                    ? 'text-amber-700'
                                    : 'text-red-700'
                                }
                              >
                                {aspect}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-500">
                              Awaiting start
                            </td>
                            <td className="py-3 px-4 text-right text-slate-500">
                              {intObj?.controlMode === 'AUTO' ? 'Ready (Auto)' : 'Manual Hold'}
                            </td>
                          </tr>
                        );
                      })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
