import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { EmergencyRun, Intersection, LightColor, RouteWaypoint } from '../types';

interface CorridorMapViewProps {
  intersections: Intersection[];
  activeRuns: EmergencyRun[];
  selectedRunId?: string | null;
  selectedIntersectionId?: string | null;
  previewWaypoints?: RouteWaypoint[];
  onSelectIntersection?: (id: string) => void;
  onSelectRun?: (runId: string) => void;
  heightClass?: string;
}

function hexForLight(color: LightColor): string {
  if (color === 'GREEN') return '#16a34a';
  if (color === 'AMBER') return '#d97706';
  return '#dc2626';
}

function statusSummaryLabel(int: Intersection): { text: string; borderHex: string } {
  if (int.operationalStatus === 'OFFLINE') {
    return { text: 'Offline Fault', borderHex: '#dc2626' };
  }
  if (int.operationalStatus === 'PRIORITY_ACTIVE') {
    return { text: `Priority ${int.activePriorityDirection ?? ''}`.trim(), borderHex: '#16a34a' };
  }
  if (int.operationalStatus === 'MANUAL_OVERRIDE') {
    return { text: 'Manual Hold', borderHex: '#2563eb' };
  }
  if (int.operationalStatus === 'APPROACHING') {
    return { text: `ETA ${int.nextArrivalEtaSec ?? '--'}s`, borderHex: '#d97706' };
  }
  return { text: 'Auto Cycle', borderHex: '#475569' };
}

// Schematic coordinates (0..800 x 0..420) matching Central-South Delhi geography
const SCHEMATIC_COORDS: Record<string, { x: number; y: number }> = {
  I6: { x: 620, y: 72 },   // ITO Main Junction (North-East)
  I5: { x: 430, y: 135 },  // India Gate C-Hexagon (North-Central)
  I4: { x: 300, y: 235 },  // Lodhi Road Crossing (Central)
  I1: { x: 185, y: 345 },  // AIIMS Ring Road (South-West)
  I2: { x: 415, y: 335 },  // South Ex Crossing (South-Central)
  I3: { x: 640, y: 345 },  // Moolchand Signal (South-East)
};

const SCHEMATIC_EDGES: Array<[string, string]> = [
  ['I6', 'I5'],
  ['I5', 'I4'],
  ['I4', 'I1'],
  ['I1', 'I2'],
  ['I2', 'I3'],
  ['I4', 'I2'],
  ['I5', 'I2'],
  ['I3', 'I4'],
];

export function CorridorMapView({
  intersections,
  activeRuns,
  selectedRunId,
  selectedIntersectionId,
  previewWaypoints,
  onSelectIntersection,
  onSelectRun,
  heightClass = 'h-[430px]',
}: CorridorMapViewProps) {
  const [mapMode, setMapMode] = useState<'STREET' | 'SCHEMATIC'>('STREET');
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const leafletMapRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);

  // Initialize Leaflet map when in STREET mode
  useEffect(() => {
    if (mapMode !== 'STREET' || !mapContainerRef.current) return;

    if (!leafletMapRef.current) {
      const map = L.map(mapContainerRef.current, {
        center: [28.594, 77.225],
        zoom: 13,
        zoomControl: true,
      });

      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        subdomains: 'abcd',
        maxZoom: 19,
      }).addTo(map);

      const group = L.layerGroup().addTo(map);
      leafletMapRef.current = map;
      layerGroupRef.current = group;
    }

    return () => {
      if (leafletMapRef.current) {
        leafletMapRef.current.remove();
        leafletMapRef.current = null;
        layerGroupRef.current = null;
      }
    };
  }, [mapMode]);

  // Sync markers & polylines on state ticks
  useEffect(() => {
    if (mapMode !== 'STREET' || !leafletMapRef.current || !layerGroupRef.current) return;
    const group = layerGroupRef.current;
    group.clearLayers();

    // Optional planned preview route (when configuring a run in Driver Console)
    if (previewWaypoints && previewWaypoints.length > 1 && activeRuns.length === 0) {
      const latlngs = previewWaypoints.map((w) => [w.lat, w.lng] as [number, number]);
      L.polyline(latlngs, {
        color: '#475569',
        weight: 4,
        dashArray: '8 8',
        opacity: 0.75,
      }).addTo(group);
    }

    // Active emergency run polylines & vehicle markers
    for (const run of activeRuns) {
      const isSelected = !selectedRunId || selectedRunId === run.id;
      const routeColor = run.vehicleType === 'FIRE' ? '#dc2626' : '#0f766e';
      const latlngs = run.waypoints.map((w) => [w.lat, w.lng] as [number, number]);

      L.polyline(latlngs, {
        color: routeColor,
        weight: isSelected ? 5 : 3,
        opacity: isSelected ? 0.9 : 0.45,
      }).addTo(group);

      const unitIcon = L.divIcon({
        className: 'rescueroute-vehicle-marker',
        html: `
          <div style="
            display:flex;align-items:center;gap:6px;
            background:${routeColor};color:#ffffff;
            padding:4px 8px;border-radius:6px;
            border:2px solid #ffffff;
            box-shadow:0 2px 8px rgba(15,23,42,0.28);
            font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;
            white-space:nowrap;transform:translate(-50%,-50%);
          ">
            <span>${run.vehicleType === 'FIRE' ? 'FIRE' : 'AMB'}</span>
            <span>·</span>
            <span>${run.vehicleId}</span>
            <span>(${run.currentSpeedKmh}km/h)</span>
          </div>
        `,
        iconSize: [0, 0],
      });

      const vMarker = L.marker([run.currentLat, run.currentLng], { icon: unitIcon, zIndexOffset: 900 });
      if (onSelectRun) {
        vMarker.on('click', () => onSelectRun(run.id));
      }
      vMarker.addTo(group);
    }

    // Signalized Intersections
    for (const int of intersections) {
      const meta = statusSummaryLabel(int);
      const isSelected = selectedIntersectionId === int.id;

      if (int.operationalStatus === 'PRIORITY_ACTIVE') {
        L.circle([int.locationLat, int.locationLng], {
          radius: 210,
          color: '#16a34a',
          weight: 1.5,
          fillColor: '#16a34a',
          fillOpacity: 0.12,
        }).addTo(group);
      }

      const nsHex = hexForLight(int.signals.NS);
      const ewHex = hexForLight(int.signals.EW);

      const intIcon = L.divIcon({
        className: 'rescueroute-int-marker',
        html: `
          <div style="
            background:#ffffff;
            border:2px solid ${isSelected ? '#0f172a' : meta.borderHex};
            border-radius:8px;
            padding:4px 7px;
            box-shadow:0 2px 6px rgba(15,23,42,0.16);
            font-family:'JetBrains Mono',monospace;
            font-size:10px;
            color:#0f172a;
            white-space:nowrap;
            transform:translate(-50%,-50%);
            cursor:pointer;
          ">
            <div style="display:flex;align-items:center;gap:5px;font-weight:600;">
              <span>${int.id}</span>
              <span style="display:inline-flex;align-items:center;gap:2px;">
                <span style="width:7px;height:7px;border-radius:50%;background:${nsHex};display:inline-block;"></span>
                <span style="font-size:9px;color:#475569;">NS</span>
              </span>
              <span style="display:inline-flex;align-items:center;gap:2px;">
                <span style="width:7px;height:7px;border-radius:50%;background:${ewHex};display:inline-block;"></span>
                <span style="font-size:9px;color:#475569;">EW</span>
              </span>
            </div>
            <div style="font-size:9px;color:#475569;margin-top:1px;">${meta.text}</div>
          </div>
        `,
        iconSize: [0, 0],
      });

      const marker = L.marker([int.locationLat, int.locationLng], {
        icon: intIcon,
        zIndexOffset: int.operationalStatus === 'PRIORITY_ACTIVE' ? 600 : 300,
      });
      if (onSelectIntersection) {
        marker.on('click', () => onSelectIntersection(int.id));
      }
      marker.addTo(group);
    }
  }, [
    mapMode,
    intersections,
    activeRuns,
    selectedRunId,
    selectedIntersectionId,
    previewWaypoints,
    onSelectIntersection,
    onSelectRun,
  ]);

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
      {/* Toolbar */}
      <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Central–South Delhi Arterial Signal Network
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            <span>6 signalized junctions</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span>Preemption threshold 48s ETA</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span>Click any junction or unit to inspect</span>
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0">
          <button
            type="button"
            onClick={() => setMapMode('STREET')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              mapMode === 'STREET'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Street Map
          </button>
          <button
            type="button"
            onClick={() => setMapMode('SCHEMATIC')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              mapMode === 'SCHEMATIC'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Schematic Grid
          </button>
        </div>
      </div>

      {/* Viewport */}
      {mapMode === 'STREET' ? (
        <div ref={mapContainerRef} className={`w-full ${heightClass}`} />
      ) : (
        <div className={`w-full ${heightClass} bg-slate-50 flex items-center justify-center p-4 overflow-x-auto`}>
          <svg
            viewBox="0 0 800 420"
            className="w-full h-full max-h-[410px] select-none"
            role="img"
            aria-label="Schematic Arterial Signal Grid"
          >
            {/* Subtle coordinate grid */}
            <defs>
              <pattern id="corridorGrid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e2e8f0" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="800" height="420" fill="url(#corridorGrid)" rx="8" />

            {/* Arterial road links */}
            {SCHEMATIC_EDGES.map(([a, b]) => {
              const pa = SCHEMATIC_COORDS[a];
              const pb = SCHEMATIC_COORDS[b];
              if (!pa || !pb) return null;

              const isPartOfActiveCorridor = activeRuns.some((run) => {
                const ids = run.intersectionProgress.map((p) => p.intersectionId);
                for (let i = 0; i < ids.length - 1; i++) {
                  if ((ids[i] === a && ids[i + 1] === b) || (ids[i] === b && ids[i + 1] === a)) {
                    return true;
                  }
                }
                return false;
              });

              return (
                <g key={`${a}-${b}`}>
                  <line
                    x1={pa.x}
                    y1={pa.y}
                    x2={pb.x}
                    y2={pb.y}
                    stroke={isPartOfActiveCorridor ? '#16a34a' : '#cbd5e1'}
                    strokeWidth={isPartOfActiveCorridor ? 7 : 4}
                    strokeLinecap="round"
                  />
                  {isPartOfActiveCorridor && (
                    <line
                      x1={pa.x}
                      y1={pa.y}
                      x2={pb.x}
                      y2={pb.y}
                      stroke="#bbf7d0"
                      strokeWidth="2"
                      strokeDasharray="6 6"
                    />
                  )}
                </g>
              );
            })}

            {/* Intersection Nodes */}
            {intersections.map((int) => {
              const pos = SCHEMATIC_COORDS[int.id] ?? { x: 400, y: 210 };
              const meta = statusSummaryLabel(int);
              const isSelected = selectedIntersectionId === int.id;

              return (
                <g
                  key={int.id}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  className="cursor-pointer"
                  onClick={() => onSelectIntersection?.(int.id)}
                >
                  {int.operationalStatus === 'PRIORITY_ACTIVE' && (
                    <circle r="38" fill="#16a34a" fillOpacity="0.14" stroke="#16a34a" strokeWidth="1.5" />
                  )}
                  <rect
                    x="-54"
                    y="-28"
                    width="108"
                    height="56"
                    rx="8"
                    fill="#ffffff"
                    stroke={isSelected ? '#0f172a' : meta.borderHex}
                    strokeWidth={isSelected ? 2.5 : 1.75}
                  />
                  <text
                    x="0"
                    y="-10"
                    textAnchor="middle"
                    className="font-mono text-[11px] font-semibold fill-slate-900"
                  >
                    {int.id} · {int.name.split(' ')[0]}
                  </text>

                  {/* NS and EW Signal Indicators */}
                  <circle cx="-26" cy="6" r="5" fill={hexForLight(int.signals.NS)} />
                  <text x="-16" y="10" className="font-mono text-[9px] fill-slate-600">
                    NS
                  </text>

                  <circle cx="12" cy="6" r="5" fill={hexForLight(int.signals.EW)} />
                  <text x="22" y="10" className="font-mono text-[9px] fill-slate-600">
                    EW
                  </text>

                  <text
                    x="0"
                    y="22"
                    textAnchor="middle"
                    className="font-mono text-[9px] fill-slate-500"
                  >
                    {meta.text}
                  </text>
                </g>
              );
            })}

            {/* Active Emergency Vehicles interpolated between schematic nodes */}
            {activeRuns.map((run, idx) => {
              const intIds = run.intersectionProgress.map((p) => p.intersectionId);
              const nextIdx = run.intersectionProgress.findIndex((p) => p.status !== 'PASSED');
              let vx = 400;
              let vy = 200;

              if (intIds.length > 0) {
                if (nextIdx === -1) {
                  const lastCoord = SCHEMATIC_COORDS[intIds[intIds.length - 1]];
                  if (lastCoord) {
                    vx = lastCoord.x;
                    vy = lastCoord.y;
                  }
                } else if (nextIdx === 0) {
                  const c0 = SCHEMATIC_COORDS[intIds[0]];
                  if (c0) {
                    vx = c0.x + 28;
                    vy = c0.y - 36;
                  }
                } else {
                  const prevC = SCHEMATIC_COORDS[intIds[nextIdx - 1]];
                  const nextC = SCHEMATIC_COORDS[intIds[nextIdx]];
                  if (prevC && nextC) {
                    vx = (prevC.x + nextC.x) / 2;
                    vy = (prevC.y + nextC.y) / 2 - idx * 18;
                  }
                }
              }

              const fillHex = run.vehicleType === 'FIRE' ? '#dc2626' : '#0f766e';
              return (
                <g
                  key={run.id}
                  transform={`translate(${vx}, ${vy})`}
                  className="cursor-pointer"
                  onClick={() => onSelectRun?.(run.id)}
                >
                  <rect
                    x="-56"
                    y="-14"
                    width="112"
                    height="26"
                    rx="6"
                    fill={fillHex}
                    stroke="#ffffff"
                    strokeWidth="2"
                  />
                  <text
                    x="0"
                    y="3"
                    textAnchor="middle"
                    className="font-mono text-[10px] font-semibold fill-white"
                  >
                    {run.vehicleId} · {run.currentSpeedKmh}km/h
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* Legend Bar (clean unboxed text with separators) */}
      <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
        <div className="flex flex-wrap items-center gap-3">
          <span>Green border: Priority Corridor Active</span>
          <span aria-hidden="true">·</span>
          <span>Amber border: Emergency Approaching (&lt;90s)</span>
          <span aria-hidden="true">·</span>
          <span>Blue border: Operator Manual Hold</span>
          <span aria-hidden="true">·</span>
          <span>Red border: Controller Offline</span>
        </div>
        <span className="font-mono tabular-nums text-[11px] text-slate-500">
          Active units: {activeRuns.length}
        </span>
      </div>
    </div>
  );
}
