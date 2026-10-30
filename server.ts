import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  AgencyType,
  CorridorPreset,
  DirectionAxis,
  EmergencyRun,
  Intersection,
  IntersectionPassageLog,
  IntersectionRunProgress,
  RouteWaypoint,
  SignalAspectState,
  SignalCommandLog,
  SystemSnapshot,
  UserAccount,
  Vehicle,
} from './src/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'rescueroute_db.json');

// Haversine distance in meters
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function polylineTotalMeters(waypoints: RouteWaypoint[]): number {
  let total = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    total += haversineMeters(
      waypoints[i].lat,
      waypoints[i].lng,
      waypoints[i + 1].lat,
      waypoints[i + 1].lng
    );
  }
  return total;
}

function interpolateAlongPolyline(
  waypoints: RouteWaypoint[],
  distanceAlongM: number
): { lat: number; lng: number; fraction: number; totalM: number } {
  const totalM = polylineTotalMeters(waypoints);
  if (totalM <= 0 || waypoints.length === 0) {
    return { lat: 28.5672, lng: 77.21, fraction: 1, totalM: 0 };
  }
  const clamped = Math.max(0, Math.min(totalM, distanceAlongM));
  let acc = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const seg = haversineMeters(
      waypoints[i].lat,
      waypoints[i].lng,
      waypoints[i + 1].lat,
      waypoints[i + 1].lng
    );
    if (acc + seg >= clamped || i === waypoints.length - 2) {
      const t = seg > 0 ? Math.min(1, Math.max(0, (clamped - acc) / seg)) : 1;
      return {
        lat: waypoints[i].lat + (waypoints[i + 1].lat - waypoints[i].lat) * t,
        lng: waypoints[i].lng + (waypoints[i + 1].lng - waypoints[i].lng) * t,
        fraction: clamped / totalM,
        totalM,
      };
    }
    acc += seg;
  }
  const last = waypoints[waypoints.length - 1];
  return { lat: last.lat, lng: last.lng, fraction: 1, totalM };
}

function distanceFromStartToWaypointIndex(waypoints: RouteWaypoint[], targetIdx: number): number {
  let dist = 0;
  for (let i = 0; i < targetIdx && i < waypoints.length - 1; i++) {
    dist += haversineMeters(
      waypoints[i].lat,
      waypoints[i].lng,
      waypoints[i + 1].lat,
      waypoints[i + 1].lng
    );
  }
  return dist;
}

interface InternalSignalRuntime {
  cycleTick: number; // 0..35 sec fixed cycle
  manualOverrideUntilMs: number | null;
  manualOverrideAxis: DirectionAxis | null;
  priorityBeforeState: Record<string, SignalAspectState>; // runId -> signal state before preemption
  runEnteredEpochMs: Record<string, number>; // runId -> arrival timestamp
  runQueuedDelaySec: Record<string, number>; // runId -> accumulated red-light wait
}

interface PersistedDatabase {
  vehicles: Vehicle[];
  users: UserAccount[];
  completedRuns: EmergencyRun[];
  passageLogs: IntersectionPassageLog[];
  commandLogs: SignalCommandLog[];
}

const INITIAL_USERS: UserAccount[] = [
  {
    id: 'USR-DRV-01',
    name: 'Rajesh Sharma',
    role: 'DRIVER',
    organization: 'CATS Delhi Ambulance Service',
    badgeCode: 'CATS-409',
  },
  {
    id: 'USR-DRV-02',
    name: 'Vikram Singh',
    role: 'DRIVER',
    organization: 'Delhi Fire Service (DFS)',
    badgeCode: 'DFS-118',
  },
  {
    id: 'USR-OPR-01',
    name: 'Ananya Verma',
    role: 'OPERATOR',
    organization: 'Integrated Traffic Control Room (ITCR)',
    badgeCode: 'ITCR-OP-14',
  },
  {
    id: 'USR-ADM-01',
    name: 'Dr. Arvind Mehta',
    role: 'ADMIN',
    organization: 'Transport & Emergency Accountability Cell',
    badgeCode: 'GNCTD-ADM-02',
  },
];

const INITIAL_VEHICLES: Vehicle[] = [
  {
    id: 'AMB-DL-023',
    type: 'AMBULANCE',
    agencyName: 'AIIMS Trauma & CATS',
    registrationNumber: 'DL-01-AM-4023',
    baseStation: 'AIIMS Trauma Centre',
    callsign: 'Medic Alpha 23',
  },
  {
    id: 'AMB-DL-108',
    type: 'AMBULANCE',
    agencyName: 'Safdarjung Critical Care ALS',
    registrationNumber: 'DL-02-AM-9108',
    baseStation: 'Safdarjung Emergency',
    callsign: 'ALS Rapid 108',
  },
  {
    id: 'FIRE-DL-004',
    type: 'FIRE',
    agencyName: 'Delhi Fire Service - Central',
    registrationNumber: 'DL-01-FD-0804',
    baseStation: 'Connaught Place Fire HQ',
    callsign: 'Tender Bravo 04',
  },
  {
    id: 'FIRE-DL-019',
    type: 'FIRE',
    agencyName: 'Delhi Fire Service - South',
    registrationNumber: 'DL-03-FD-2219',
    baseStation: 'Nehru Place Station',
    callsign: 'Hazmat Unit 19',
  },
];

function createDefaultIntersections(): Intersection[] {
  return [
    {
      id: 'I1',
      name: 'AIIMS Ring Road Junction',
      zone: 'South Zone',
      departmentOwner: 'PWD Signal Division (South)',
      locationLat: 28.5672,
      locationLng: 77.21,
      controllerId: 'ARD-UNO-01',
      hardwareProtocol: 'SERIAL_USB',
      controlMode: 'AUTO',
      operationalStatus: 'NORMAL',
      signals: { NS: 'GREEN', EW: 'RED' },
      phaseRemainingSec: 12,
      activePriorityRunId: null,
      activePriorityDirection: null,
      nextArrivalEtaSec: null,
      nextArrivalVehicleId: null,
      baselineAvgDelaySec: 44,
    },
    {
      id: 'I2',
      name: 'South Extension Part-I Crossing',
      zone: 'South Zone',
      departmentOwner: 'Delhi Traffic Police (South)',
      locationLat: 28.5689,
      locationLng: 77.2225,
      controllerId: 'ARD-UNO-02',
      hardwareProtocol: 'SERIAL_USB',
      controlMode: 'AUTO',
      operationalStatus: 'NORMAL',
      signals: { NS: 'RED', EW: 'GREEN' },
      phaseRemainingSec: 9,
      activePriorityRunId: null,
      activePriorityDirection: null,
      nextArrivalEtaSec: null,
      nextArrivalVehicleId: null,
      baselineAvgDelaySec: 38,
    },
    {
      id: 'I3',
      name: 'Moolchand Underpass Signal',
      zone: 'South-East Zone',
      departmentOwner: 'PWD Signal Division (South)',
      locationLat: 28.5646,
      locationLng: 77.2345,
      controllerId: 'ARD-UNO-03',
      hardwareProtocol: 'SERIAL_USB',
      controlMode: 'AUTO',
      operationalStatus: 'NORMAL',
      signals: { NS: 'GREEN', EW: 'RED' },
      phaseRemainingSec: 6,
      activePriorityRunId: null,
      activePriorityDirection: null,
      nextArrivalEtaSec: null,
      nextArrivalVehicleId: null,
      baselineAvgDelaySec: 49,
    },
    {
      id: 'I4',
      name: 'Lodhi Road - Safdarjung Crossing',
      zone: 'New Delhi Municipal Zone',
      departmentOwner: 'NDMC Traffic Engineering',
      locationLat: 28.588,
      locationLng: 77.2135,
      controllerId: 'ARD-UNO-04',
      hardwareProtocol: 'SERIAL_USB',
      controlMode: 'AUTO',
      operationalStatus: 'NORMAL',
      signals: { NS: 'RED', EW: 'GREEN' },
      phaseRemainingSec: 11,
      activePriorityRunId: null,
      activePriorityDirection: null,
      nextArrivalEtaSec: null,
      nextArrivalVehicleId: null,
      baselineAvgDelaySec: 31,
    },
    {
      id: 'I5',
      name: 'India Gate C-Hexagon - Janpath',
      zone: 'New Delhi Municipal Zone',
      departmentOwner: 'NDMC Traffic Engineering',
      locationLat: 28.6129,
      locationLng: 77.2245,
      controllerId: 'ESP32-WIFI-05',
      hardwareProtocol: 'ESP32_WIFI',
      controlMode: 'AUTO',
      operationalStatus: 'NORMAL',
      signals: { NS: 'GREEN', EW: 'RED' },
      phaseRemainingSec: 14,
      activePriorityRunId: null,
      activePriorityDirection: null,
      nextArrivalEtaSec: null,
      nextArrivalVehicleId: null,
      baselineAvgDelaySec: 35,
    },
    {
      id: 'I6',
      name: 'ITO Vikas Marg Main Junction',
      zone: 'Central Zone',
      departmentOwner: 'Delhi Traffic Police (Central)',
      locationLat: 28.6285,
      locationLng: 77.2412,
      controllerId: 'ESP32-WIFI-06',
      hardwareProtocol: 'ESP32_WIFI',
      controlMode: 'AUTO',
      operationalStatus: 'NORMAL',
      signals: { NS: 'RED', EW: 'GREEN' },
      phaseRemainingSec: 8,
      activePriorityRunId: null,
      activePriorityDirection: null,
      nextArrivalEtaSec: null,
      nextArrivalVehicleId: null,
      baselineAvgDelaySec: 54,
    },
  ];
}

const CORRIDOR_PRESETS: CorridorPreset[] = [
  {
    id: 'COR-TRAUMA-EW',
    name: 'Lajpat Nagar to AIIMS Trauma Corridor',
    recommendedType: 'AMBULANCE',
    originName: 'Lajpat Nagar Ring Road Pickup',
    destinationName: 'AIIMS Trauma Centre Gate 1',
    originLat: 28.5635,
    originLng: 77.2435,
    destinationLat: 28.5668,
    destinationLng: 77.2065,
    distanceKm: 3.7,
    waypoints: [
      { lat: 28.5635, lng: 77.2435, label: 'Lajpat Nagar Pickup' },
      { lat: 28.5646, lng: 77.2345, label: 'Moolchand Signal', intersectionId: 'I3', approachDirection: 'EW' },
      { lat: 28.5689, lng: 77.2225, label: 'South Ex Crossing', intersectionId: 'I2', approachDirection: 'EW' },
      { lat: 28.5672, lng: 77.21, label: 'AIIMS Junction', intersectionId: 'I1', approachDirection: 'EW' },
      { lat: 28.5668, lng: 77.2065, label: 'AIIMS Trauma Bay' },
    ],
    alternateSummary: 'Divert via Lodhi Road Flyover (I4) avoiding South Ex arterial congestion',
    alternateWaypoints: [
      { lat: 28.5635, lng: 77.2435, label: 'Lajpat Nagar Pickup' },
      { lat: 28.5646, lng: 77.2345, label: 'Moolchand Signal', intersectionId: 'I3', approachDirection: 'NS' },
      { lat: 28.588, lng: 77.2135, label: 'Lodhi Road Crossing', intersectionId: 'I4', approachDirection: 'EW' },
      { lat: 28.5672, lng: 77.21, label: 'AIIMS Junction', intersectionId: 'I1', approachDirection: 'NS' },
      { lat: 28.5668, lng: 77.2065, label: 'AIIMS Trauma Bay' },
    ],
  },
  {
    id: 'COR-CARDIAC-NS',
    name: 'ITO Central to AIIMS Cardiac Express',
    recommendedType: 'AMBULANCE',
    originName: 'ITO Vikas Marg Clinic',
    destinationName: 'AIIMS Cardiothoracic Centre',
    originLat: 28.632,
    originLng: 77.2438,
    destinationLat: 28.5655,
    destinationLng: 77.209,
    distanceKm: 8.2,
    waypoints: [
      { lat: 28.632, lng: 77.2438, label: 'ITO Origin' },
      { lat: 28.6285, lng: 77.2412, label: 'ITO Main Junction', intersectionId: 'I6', approachDirection: 'NS' },
      { lat: 28.6129, lng: 77.2245, label: 'India Gate C-Hexagon', intersectionId: 'I5', approachDirection: 'NS' },
      { lat: 28.588, lng: 77.2135, label: 'Lodhi Road Crossing', intersectionId: 'I4', approachDirection: 'NS' },
      { lat: 28.5672, lng: 77.21, label: 'AIIMS Junction', intersectionId: 'I1', approachDirection: 'NS' },
      { lat: 28.5655, lng: 77.209, label: 'AIIMS Cardiac Gate' },
    ],
    alternateSummary: 'Bypass Lodhi Road via South Extension arterial link (I2)',
    alternateWaypoints: [
      { lat: 28.632, lng: 77.2438, label: 'ITO Origin' },
      { lat: 28.6285, lng: 77.2412, label: 'ITO Main Junction', intersectionId: 'I6', approachDirection: 'NS' },
      { lat: 28.6129, lng: 77.2245, label: 'India Gate C-Hexagon', intersectionId: 'I5', approachDirection: 'NS' },
      { lat: 28.5689, lng: 77.2225, label: 'South Ex Crossing', intersectionId: 'I2', approachDirection: 'NS' },
      { lat: 28.5672, lng: 77.21, label: 'AIIMS Junction', intersectionId: 'I1', approachDirection: 'EW' },
      { lat: 28.5655, lng: 77.209, label: 'AIIMS Cardiac Gate' },
    ],
  },
  {
    id: 'COR-FIRE-CENTRAL',
    name: 'Connaught Place / Janpath to ITO Commercial Fire',
    recommendedType: 'FIRE',
    originName: 'Safdarjung / Lodhi Fire Post',
    destinationName: 'ITO Multi-Storey Complex',
    originLat: 28.582,
    originLng: 77.211,
    destinationLat: 28.631,
    destinationLng: 77.243,
    distanceKm: 6.4,
    waypoints: [
      { lat: 28.582, lng: 77.211, label: 'Safdarjung Fire Post' },
      { lat: 28.588, lng: 77.2135, label: 'Lodhi Road Crossing', intersectionId: 'I4', approachDirection: 'NS' },
      { lat: 28.6129, lng: 77.2245, label: 'India Gate C-Hexagon', intersectionId: 'I5', approachDirection: 'NS' },
      { lat: 28.6285, lng: 77.2412, label: 'ITO Main Junction', intersectionId: 'I6', approachDirection: 'EW' },
      { lat: 28.631, lng: 77.243, label: 'ITO Incident Zone' },
    ],
    alternateSummary: 'Heavy Tender Wide-Turn Route via Moolchand Underpass (I3)',
    alternateWaypoints: [
      { lat: 28.582, lng: 77.211, label: 'Safdarjung Fire Post' },
      { lat: 28.5646, lng: 77.2345, label: 'Moolchand Signal', intersectionId: 'I3', approachDirection: 'NS' },
      { lat: 28.6129, lng: 77.2245, label: 'India Gate C-Hexagon', intersectionId: 'I5', approachDirection: 'NS' },
      { lat: 28.6285, lng: 77.2412, label: 'ITO Main Junction', intersectionId: 'I6', approachDirection: 'NS' },
      { lat: 28.631, lng: 77.243, label: 'ITO Incident Zone' },
    ],
  },
  {
    id: 'COR-FIRE-SOUTH',
    name: 'Nehru Place Hazmat to South Extension Market',
    recommendedType: 'FIRE',
    originName: 'Nehru Place Outer Ring Station',
    destinationName: 'South Ex Market Block II',
    originLat: 28.556,
    originLng: 77.246,
    destinationLat: 28.5695,
    destinationLng: 77.218,
    distanceKm: 3.4,
    waypoints: [
      { lat: 28.556, lng: 77.246, label: 'Nehru Place Fire Station' },
      { lat: 28.5646, lng: 77.2345, label: 'Moolchand Signal', intersectionId: 'I3', approachDirection: 'EW' },
      { lat: 28.5689, lng: 77.2225, label: 'South Ex Crossing', intersectionId: 'I2', approachDirection: 'EW' },
      { lat: 28.5695, lng: 77.218, label: 'South Ex Incident Site' },
    ],
    alternateSummary: 'Reroute via AIIMS Ring Road approach (I1) due to narrow market lane blockage',
    alternateWaypoints: [
      { lat: 28.556, lng: 77.246, label: 'Nehru Place Fire Station' },
      { lat: 28.5646, lng: 77.2345, label: 'Moolchand Signal', intersectionId: 'I3', approachDirection: 'EW' },
      { lat: 28.5672, lng: 77.21, label: 'AIIMS Junction', intersectionId: 'I1', approachDirection: 'EW' },
      { lat: 28.5689, lng: 77.2225, label: 'South Ex Crossing', intersectionId: 'I2', approachDirection: 'EW' },
      { lat: 28.5695, lng: 77.218, label: 'South Ex Incident Site' },
    ],
  },
];

function generateSeedHistory(): {
  completedRuns: EmergencyRun[];
  passageLogs: IntersectionPassageLog[];
  commandLogs: SignalCommandLog[];
} {
  const now = Date.now();
  const hour = 3600 * 1000;

  const seedSpecs = [
    {
      runId: 'RUN-2401',
      vehicle: INITIAL_VEHICLES[0],
      corridor: CORRIDOR_PRESETS[0],
      hoursAgo: 6.5,
      durationMin: 5.4,
      note: 'Priority 1 polytrauma transfer to AIIMS',
      delays: { I3: 4, I2: 2, I1: 3 } as Record<string, number>,
      prioritized: { I3: true, I2: true, I1: true } as Record<string, boolean>,
    },
    {
      runId: 'RUN-2402',
      vehicle: INITIAL_VEHICLES[2],
      corridor: CORRIDOR_PRESETS[2],
      hoursAgo: 5.1,
      durationMin: 8.2,
      note: 'Electrical substation smoke alarm at ITO',
      delays: { I4: 3, I5: 5, I6: 14 } as Record<string, number>,
      prioritized: { I4: true, I5: true, I6: true } as Record<string, boolean>,
    },
    {
      runId: 'RUN-2403',
      vehicle: INITIAL_VEHICLES[1],
      corridor: CORRIDOR_PRESETS[1],
      hoursAgo: 3.4,
      durationMin: 10.6,
      note: 'Acute STEMI cardiac transfer during evening peak',
      delays: { I6: 18, I5: 4, I4: 2, I1: 5 } as Record<string, number>,
      prioritized: { I6: false, I5: true, I4: true, I1: true } as Record<string, boolean>,
    },
    {
      runId: 'RUN-2404',
      vehicle: INITIAL_VEHICLES[3],
      corridor: CORRIDOR_PRESETS[3],
      hoursAgo: 1.8,
      durationMin: 4.9,
      note: 'Commercial kitchen fire suppression dispatch',
      delays: { I3: 9, I2: 3 } as Record<string, number>,
      prioritized: { I3: true, I2: true } as Record<string, boolean>,
    },
  ];

  const defaultInts = createDefaultIntersections();
  const intMap = new Map(defaultInts.map((i) => [i.id, i]));

  const completedRuns: EmergencyRun[] = [];
  const passageLogs: IntersectionPassageLog[] = [];
  const commandLogs: SignalCommandLog[] = [];

  for (const spec of seedSpecs) {
    const startMs = Math.round(now - spec.hoursAgo * hour);
    const endMs = Math.round(startMs + spec.durationMin * 60 * 1000);
    let totalDelay = 0;
    let baselineTotal = 0;
    let totalSaved = 0;
    let prioritizedCount = 0;
    let worstId: string | null = null;
    let worstVal = -1;

    const progressList: IntersectionRunProgress[] = [];
    const intWaypoints = spec.corridor.waypoints.filter((w) => w.intersectionId);

    intWaypoints.forEach((wp, idx) => {
      const iid = wp.intersectionId!;
      const intersection = intMap.get(iid)!;
      const delay = spec.delays[iid] ?? 4;
      const granted = spec.prioritized[iid] ?? true;
      const baseline = intersection.baselineAvgDelaySec;
      const saved = Math.max(0, baseline - delay);
      const axis = wp.approachDirection ?? 'NS';

      totalDelay += delay;
      baselineTotal += baseline;
      totalSaved += saved;
      if (granted) prioritizedCount += 1;
      if (delay > worstVal) {
        worstVal = delay;
        worstId = iid;
      }

      const legMs = Math.round(((idx + 1) / (intWaypoints.length + 1)) * (endMs - startMs));
      const plannedMs = startMs + legMs;
      const arrivedMs = plannedMs + delay * 1000;
      const exitedMs = arrivedMs + 9000;

      progressList.push({
        intersectionId: iid,
        intersectionName: intersection.name,
        approachDirection: axis,
        distanceRemainingM: 0,
        etaSec: null,
        plannedArrivalEpochMs: plannedMs,
        status: 'PASSED',
        delaySec: delay,
        secondsSaved: saved,
      });

      const beforeState: SignalAspectState =
        axis === 'NS' ? { NS: 'RED', EW: 'GREEN' } : { NS: 'GREEN', EW: 'RED' };
      const afterState: SignalAspectState = granted
        ? axis === 'NS'
          ? { NS: 'GREEN', EW: 'RED' }
          : { NS: 'RED', EW: 'GREEN' }
        : beforeState;

      passageLogs.push({
        id: `LOG-${spec.runId}-${iid}`,
        runId: spec.runId,
        vehicleId: spec.vehicle.id,
        vehicleType: spec.vehicle.type,
        agencyName: spec.vehicle.agencyName,
        intersectionId: iid,
        intersectionName: intersection.name,
        departmentOwner: intersection.departmentOwner,
        zone: intersection.zone,
        approachDirection: axis,
        timeEtaPlanned: new Date(plannedMs).toISOString(),
        timeArrived: new Date(arrivedMs).toISOString(),
        timeExited: new Date(exitedMs).toISOString(),
        estimatedDelaySeconds: delay,
        baselineExpectedDelaySeconds: baseline,
        secondsSaved: saved,
        priorityGranted: granted,
        signalStateBefore: beforeState,
        signalStateAfter: afterState,
      });

      if (granted) {
        commandLogs.push({
          id: `CMD-${spec.runId}-${iid}-PRE`,
          intersectionId: iid,
          intersectionName: intersection.name,
          controllerId: intersection.controllerId,
          runId: spec.runId,
          timestamp: new Date(plannedMs - 32000).toISOString(),
          commandType: 'SET_PHASE_PRIORITY',
          serialFrame: `${iid}:PRIORITY:${axis}:20000\\n`,
          esp32JsonPayload: JSON.stringify({
            intersectionId: iid,
            state: axis === 'NS' ? { NS: 'green', EW: 'red' } : { NS: 'red', EW: 'green' },
            durationMs: 20000,
            runId: spec.runId,
          }),
          issuedBy: 'Green Corridor Engine',
          latencyMs: 118 + ((idx * 29) % 90),
        });
      }
    });

    completedRuns.push({
      id: spec.runId,
      vehicleId: spec.vehicle.id,
      vehicleType: spec.vehicle.type,
      agencyName: spec.vehicle.agencyName,
      callsign: spec.vehicle.callsign,
      corridorId: spec.corridor.id,
      originName: spec.corridor.originName,
      destinationName: spec.corridor.destinationName,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
      status: 'COMPLETED',
      currentLat: spec.corridor.destinationLat,
      currentLng: spec.corridor.destinationLng,
      currentSpeedKmh: 0,
      targetSpeedKmh: 54,
      autoDrive: true,
      rerouted: false,
      progressFraction: 1,
      waypoints: spec.corridor.waypoints,
      intersectionProgress: progressList,
      broadcastPacketsExpected: 64,
      broadcastPacketsReceived: 63,
      lastUpdateEpochMs: endMs,
      lastSyncLatencyMs: 124,
      totalDelaySec: totalDelay,
      baselineTotalDelaySec: baselineTotal,
      totalSecondsSaved: totalSaved,
      intersectionsPrioritized: prioritizedCount,
      worstIntersectionId: worstId,
      incidentNote: spec.note,
    });
  }

  return {
    completedRuns: completedRuns.reverse(),
    passageLogs: passageLogs.reverse(),
    commandLogs: commandLogs.reverse(),
  };
}

function loadDatabase(): PersistedDatabase {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw) as PersistedDatabase;
      if (Array.isArray(parsed.vehicles) && Array.isArray(parsed.passageLogs)) {
        return parsed;
      }
    } catch {
      // Fallback to seed below
    }
  }
  const seeded = generateSeedHistory();
  const initialDb: PersistedDatabase = {
    vehicles: [...INITIAL_VEHICLES],
    users: [...INITIAL_USERS],
    completedRuns: seeded.completedRuns,
    passageLogs: seeded.passageLogs,
    commandLogs: seeded.commandLogs,
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(initialDb, null, 2), 'utf8');
  return initialDb;
}

const dbState = loadDatabase();
const intersections: Intersection[] = createDefaultIntersections();
const activeRuns: EmergencyRun[] = [];
const runDistanceAlongMap = new Map<string, number>();

const signalRuntime = new Map<string, InternalSignalRuntime>();
intersections.forEach((int, idx) => {
  signalRuntime.set(int.id, {
    cycleTick: (idx * 9) % 36,
    manualOverrideUntilMs: null,
    manualOverrideAxis: null,
    priorityBeforeState: {},
    runEnteredEpochMs: {},
    runQueuedDelaySec: {},
  });
});

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(dbState, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to persist database:', err);
    }
  }, 400);
}

function appendCommandLog(entry: Omit<SignalCommandLog, 'id' | 'timestamp'>): SignalCommandLog {
  const record: SignalCommandLog = {
    ...entry,
    id: `CMD-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    timestamp: new Date().toISOString(),
  };
  dbState.commandLogs.unshift(record);
  if (dbState.commandLogs.length > 150) {
    dbState.commandLogs.length = 150;
  }
  schedulePersist();
  return record;
}

function computeFixedCycleAspect(cycleTick: number): {
  signals: SignalAspectState;
  remainingSec: number;
} {
  // 36-second standard cycle:
  // 0..13 (14s): NS GREEN, EW RED
  // 14..16 (3s): NS AMBER, EW RED
  // 17 (1s): ALL RED
  // 18..31 (14s): NS RED, EW GREEN
  // 32..34 (3s): NS RED, EW AMBER
  // 35 (1s): ALL RED
  const t = ((cycleTick % 36) + 36) % 36;
  if (t <= 13) return { signals: { NS: 'GREEN', EW: 'RED' }, remainingSec: 14 - t };
  if (t <= 16) return { signals: { NS: 'AMBER', EW: 'RED' }, remainingSec: 17 - t };
  if (t === 17) return { signals: { NS: 'RED', EW: 'RED' }, remainingSec: 1 };
  if (t <= 31) return { signals: { NS: 'RED', EW: 'GREEN' }, remainingSec: 32 - t };
  if (t <= 34) return { signals: { NS: 'RED', EW: 'AMBER' }, remainingSec: 35 - t };
  return { signals: { NS: 'RED', EW: 'RED' }, remainingSec: 1 };
}

function finalizeRun(run: EmergencyRun, finalStatus: 'COMPLETED' | 'CANCELLED') {
  run.status = finalStatus;
  run.endTime = new Date().toISOString();
  run.currentSpeedKmh = 0;
  if (finalStatus === 'COMPLETED' && run.waypoints.length > 0) {
    const dest = run.waypoints[run.waypoints.length - 1];
    run.currentLat = dest.lat;
    run.currentLng = dest.lng;
    run.progressFraction = 1;
  }

  // Release any priority held by this run
  for (const intersection of intersections) {
    if (intersection.activePriorityRunId === run.id) {
      intersection.activePriorityRunId = null;
      intersection.activePriorityDirection = null;
      if (intersection.operationalStatus !== 'OFFLINE' && intersection.controlMode === 'AUTO') {
        intersection.operationalStatus = 'NORMAL';
      }
      appendCommandLog({
        intersectionId: intersection.id,
        intersectionName: intersection.name,
        controllerId: intersection.controllerId,
        runId: run.id,
        commandType: 'RESET_TO_NORMAL',
        serialFrame: `${intersection.id}:NORMAL\\n`,
        esp32JsonPayload: JSON.stringify({
          intersectionId: intersection.id,
          mode: 'NORMAL_CYCLE',
          runId: run.id,
        }),
        issuedBy: 'Green Corridor Engine',
        latencyMs: 95,
      });
    }
  }

  const idx = activeRuns.findIndex((r) => r.id === run.id);
  if (idx !== -1) {
    activeRuns.splice(idx, 1);
  }
  runDistanceAlongMap.delete(run.id);

  dbState.completedRuns.unshift(run);
  if (dbState.completedRuns.length > 80) {
    dbState.completedRuns.length = 80;
  }
  schedulePersist();
}

function evaluateGreenCorridorAndSignals(nowMs: number, advanceAutoDriveSec: number) {
  // 1. Advance autoDrive active runs & evaluate intersection distances
  const upcomingDemandByIntersection = new Map<
    string,
    { run: EmergencyRun; etaSec: number; axis: DirectionAxis; distM: number }
  >();

  for (const run of [...activeRuns]) {
    const totalM = polylineTotalMeters(run.waypoints);
    let currentDistM = runDistanceAlongMap.get(run.id) ?? 0;

    if (advanceAutoDriveSec > 0 && run.autoDrive) {
      // Check if held at a red signal within 65m ahead
      let blockedByRed = false;
      for (const prog of run.intersectionProgress) {
        if (prog.status === 'PASSED') continue;
        const wpIdx = run.waypoints.findIndex((w) => w.intersectionId === prog.intersectionId);
        if (wpIdx !== -1) {
          const wpDistM = distanceFromStartToWaypointIndex(run.waypoints, wpIdx);
          const distAhead = wpDistM - currentDistM;
          if (distAhead >= -15 && distAhead <= 65) {
            const intersection = intersections.find((i) => i.id === prog.intersectionId);
            if (intersection) {
              const aspect = intersection.signals[prog.approachDirection];
              if (aspect !== 'GREEN' || intersection.operationalStatus === 'OFFLINE') {
                blockedByRed = true;
                const rt = signalRuntime.get(intersection.id);
                if (rt) {
                  rt.runQueuedDelaySec[run.id] = (rt.runQueuedDelaySec[run.id] ?? 0) + advanceAutoDriveSec;
                }
              }
            }
          }
        }
      }

      const effectiveSpeedKmh = blockedByRed ? 5 : run.targetSpeedKmh;
      run.currentSpeedKmh = effectiveSpeedKmh;
      const stepMeters = (effectiveSpeedKmh / 3.6) * advanceAutoDriveSec;
      currentDistM = Math.min(totalM, currentDistM + stepMeters);
      runDistanceAlongMap.set(run.id, currentDistM);

      const pos = interpolateAlongPolyline(run.waypoints, currentDistM);
      run.currentLat = pos.lat;
      run.currentLng = pos.lng;
      run.progressFraction = pos.fraction;
      run.broadcastPacketsExpected += 1;
      run.broadcastPacketsReceived += 1;
      run.lastUpdateEpochMs = nowMs;
      run.lastSyncLatencyMs = 88 + Math.floor(Math.random() * 55);
    }

    // Update each intersection along this run
    const calcSpeedMps = Math.max(6, (run.currentSpeedKmh || run.targetSpeedKmh) / 3.6);

    for (const prog of run.intersectionProgress) {
      if (prog.status === 'PASSED') continue;

      const wpIdx = run.waypoints.findIndex((w) => w.intersectionId === prog.intersectionId);
      const wpDistM =
        wpIdx !== -1
          ? distanceFromStartToWaypointIndex(run.waypoints, wpIdx)
          : haversineMeters(
              run.currentLat,
              run.currentLng,
              intersections.find((i) => i.id === prog.intersectionId)?.locationLat ?? run.currentLat,
              intersections.find((i) => i.id === prog.intersectionId)?.locationLng ?? run.currentLng
            ) + currentDistM;

      const remainingM = wpDistM - currentDistM;
      prog.distanceRemainingM = Math.max(0, Math.round(remainingM));

      const intersection = intersections.find((i) => i.id === prog.intersectionId);
      const rt = intersection ? signalRuntime.get(intersection.id) : undefined;

      // Mark arrival inside 95m geofence
      if (remainingM <= 95 && rt && !rt.runEnteredEpochMs[run.id]) {
        rt.runEnteredEpochMs[run.id] = nowMs;
        if (!rt.priorityBeforeState[run.id] && intersection) {
          rt.priorityBeforeState[run.id] = { ...intersection.signals };
        }
      }

      // Check if passed intersection (remainingM <= -12m or reached end of route)
      if (remainingM <= -12 || currentDistM >= totalM - 5) {
        prog.status = 'PASSED';
        prog.distanceRemainingM = 0;
        prog.etaSec = null;

        if (intersection && rt) {
          const arrivedMs = rt.runEnteredEpochMs[run.id] ?? nowMs - 4000;
          const queuedExtra = rt.runQueuedDelaySec[run.id] ?? 0;
          const rawDiffSec = Math.round((arrivedMs - prog.plannedArrivalEpochMs) / 1000);
          const granted =
            intersection.activePriorityRunId === run.id ||
            (intersection.controlMode === 'AUTO' && intersection.operationalStatus !== 'OFFLINE');
          const estimatedDelay = Math.max(
            granted ? 1 : 12,
            Math.max(0, rawDiffSec) + Math.round(queuedExtra) + (granted ? 2 : 14)
          );
          const baseline = intersection.baselineAvgDelaySec;
          const saved = Math.max(0, baseline - estimatedDelay);

          prog.delaySec = estimatedDelay;
          prog.secondsSaved = saved;

          run.totalDelaySec += estimatedDelay;
          run.baselineTotalDelaySec += baseline;
          run.totalSecondsSaved += saved;
          if (granted) {
            run.intersectionsPrioritized += 1;
          }

          // Recompute worst intersection on run
          let maxD = -1;
          for (const p of run.intersectionProgress) {
            if (p.delaySec !== null && p.delaySec > maxD) {
              maxD = p.delaySec;
              run.worstIntersectionId = p.intersectionId;
            }
          }

          const beforeState = rt.priorityBeforeState[run.id] ?? { NS: 'RED', EW: 'GREEN' };
          const afterState = { ...intersection.signals };

          const logEntry: IntersectionPassageLog = {
            id: `LOG-${run.id}-${intersection.id}-${Date.now().toString().slice(-4)}`,
            runId: run.id,
            vehicleId: run.vehicleId,
            vehicleType: run.vehicleType,
            agencyName: run.agencyName,
            intersectionId: intersection.id,
            intersectionName: intersection.name,
            departmentOwner: intersection.departmentOwner,
            zone: intersection.zone,
            approachDirection: prog.approachDirection,
            timeEtaPlanned: new Date(prog.plannedArrivalEpochMs).toISOString(),
            timeArrived: new Date(arrivedMs).toISOString(),
            timeExited: new Date(nowMs).toISOString(),
            estimatedDelaySeconds: estimatedDelay,
            baselineExpectedDelaySeconds: baseline,
            secondsSaved: saved,
            priorityGranted: granted,
            signalStateBefore: beforeState,
            signalStateAfter: afterState,
          };
          dbState.passageLogs.unshift(logEntry);
          schedulePersist();

          delete rt.runEnteredEpochMs[run.id];
          delete rt.priorityBeforeState[run.id];
          delete rt.runQueuedDelaySec[run.id];
        }
        continue;
      }

      const etaSec = Math.max(1, Math.round(remainingM / calcSpeedMps));
      prog.etaSec = etaSec;

      if (remainingM <= 85) {
        prog.status = 'CROSSING';
      } else if (etaSec <= 48 && intersection?.controlMode === 'AUTO' && intersection.operationalStatus !== 'OFFLINE') {
        prog.status = 'PRIORITY_SYNCED';
      } else {
        prog.status = 'UPCOMING';
      }

      // Register demand for this intersection (closest ETA wins if multiple emergency runs approach)
      if (intersection) {
        const existing = upcomingDemandByIntersection.get(intersection.id);
        if (!existing || etaSec < existing.etaSec) {
          upcomingDemandByIntersection.set(intersection.id, {
            run,
            etaSec,
            axis: prog.approachDirection,
            distM: remainingM,
          });
        }
      }
    }

    // Complete run if reached destination
    if (currentDistM >= totalM - 5 && totalM > 0) {
      finalizeRun(run, 'COMPLETED');
    }
  }

  // 2. Update every intersection state machine
  for (const intersection of intersections) {
    const rt = signalRuntime.get(intersection.id)!;
    if (advanceAutoDriveSec > 0) {
      rt.cycleTick = (rt.cycleTick + 1) % 36;
    }

    if (intersection.operationalStatus === 'OFFLINE') {
      intersection.signals = { NS: 'AMBER', EW: 'AMBER' };
      intersection.phaseRemainingSec = 0;
      intersection.activePriorityRunId = null;
      intersection.activePriorityDirection = null;
      const demand = upcomingDemandByIntersection.get(intersection.id);
      intersection.nextArrivalEtaSec = demand ? demand.etaSec : null;
      intersection.nextArrivalVehicleId = demand ? demand.run.vehicleId : null;
      continue;
    }

    // Check expiring manual override
    if (
      intersection.controlMode === 'MANUAL' &&
      rt.manualOverrideUntilMs !== null &&
      nowMs >= rt.manualOverrideUntilMs
    ) {
      intersection.controlMode = 'AUTO';
      rt.manualOverrideUntilMs = null;
      rt.manualOverrideAxis = null;
      appendCommandLog({
        intersectionId: intersection.id,
        intersectionName: intersection.name,
        controllerId: intersection.controllerId,
        runId: null,
        commandType: 'RESET_TO_NORMAL',
        serialFrame: `${intersection.id}:NORMAL\\n`,
        esp32JsonPayload: JSON.stringify({
          intersectionId: intersection.id,
          mode: 'NORMAL_CYCLE',
          reason: 'manual_timeout_expired',
        }),
        issuedBy: 'Safety Watchdog Timer',
        latencyMs: 64,
      });
    }

    const demand = upcomingDemandByIntersection.get(intersection.id);
    intersection.nextArrivalEtaSec = demand ? demand.etaSec : null;
    intersection.nextArrivalVehicleId = demand ? demand.run.vehicleId : null;

    if (intersection.controlMode === 'MANUAL' && rt.manualOverrideAxis) {
      intersection.operationalStatus = 'MANUAL_OVERRIDE';
      intersection.signals =
        rt.manualOverrideAxis === 'NS' ? { NS: 'GREEN', EW: 'RED' } : { NS: 'RED', EW: 'GREEN' };
      intersection.phaseRemainingSec = rt.manualOverrideUntilMs
        ? Math.max(1, Math.round((rt.manualOverrideUntilMs - nowMs) / 1000))
        : 15;
      intersection.activePriorityRunId = null;
      intersection.activePriorityDirection = null;
      continue;
    }

    // Auto mode: check if an emergency run is within Green Corridor preemption window (ETA <= 48s)
    if (demand && demand.etaSec <= 48) {
      const wasAlreadySyncedForSame =
        intersection.activePriorityRunId === demand.run.id &&
        intersection.activePriorityDirection === demand.axis &&
        intersection.operationalStatus === 'PRIORITY_ACTIVE';

      if (!rt.priorityBeforeState[demand.run.id]) {
        rt.priorityBeforeState[demand.run.id] = { ...intersection.signals };
      }

      intersection.operationalStatus = 'PRIORITY_ACTIVE';
      intersection.activePriorityRunId = demand.run.id;
      intersection.activePriorityDirection = demand.axis;
      intersection.signals =
        demand.axis === 'NS' ? { NS: 'GREEN', EW: 'RED' } : { NS: 'RED', EW: 'GREEN' };
      intersection.phaseRemainingSec = Math.max(8, demand.etaSec + 6);

      if (!wasAlreadySyncedForSame) {
        const holdMs = Math.max(12000, (demand.etaSec + 8) * 1000);
        appendCommandLog({
          intersectionId: intersection.id,
          intersectionName: intersection.name,
          controllerId: intersection.controllerId,
          runId: demand.run.id,
          commandType: 'SET_PHASE_PRIORITY',
          serialFrame: `${intersection.id}:PRIORITY:${demand.axis}:${holdMs}\\n`,
          esp32JsonPayload: JSON.stringify({
            intersectionId: intersection.id,
            state:
              demand.axis === 'NS' ? { NS: 'green', EW: 'red' } : { NS: 'red', EW: 'green' },
            durationMs: holdMs,
            runId: demand.run.id,
          }),
          issuedBy: 'Green Corridor Engine',
          latencyMs: 92 + Math.floor(Math.random() * 48),
        });
      }
    } else {
      // If previously holding priority, log safe fallback reset
      if (intersection.activePriorityRunId !== null) {
        const prevRunId = intersection.activePriorityRunId;
        intersection.activePriorityRunId = null;
        intersection.activePriorityDirection = null;
        appendCommandLog({
          intersectionId: intersection.id,
          intersectionName: intersection.name,
          controllerId: intersection.controllerId,
          runId: prevRunId,
          commandType: 'RESET_TO_NORMAL',
          serialFrame: `${intersection.id}:NORMAL\\n`,
          esp32JsonPayload: JSON.stringify({
            intersectionId: intersection.id,
            mode: 'NORMAL_CYCLE',
            runId: prevRunId,
          }),
          issuedBy: 'Green Corridor Engine',
          latencyMs: 84,
        });
      }

      intersection.operationalStatus = demand && demand.etaSec <= 90 ? 'APPROACHING' : 'NORMAL';
      const normal = computeFixedCycleAspect(rt.cycleTick);
      intersection.signals = normal.signals;
      intersection.phaseRemainingSec = normal.remainingSec;
    }
  }
}

function buildSnapshot(): SystemSnapshot {
  return {
    serverTime: new Date().toISOString(),
    intersections,
    vehicles: dbState.vehicles,
    users: dbState.users,
    corridors: CORRIDOR_PRESETS,
    activeRuns,
    completedRuns: dbState.completedRuns,
    passageLogs: dbState.passageLogs,
    commandLogs: dbState.commandLogs,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json());

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  function broadcastSnapshot(eventType: 'snapshot:init' | 'state:update' = 'state:update') {
    const payload = JSON.stringify({
      type: eventType,
      snapshot: buildSnapshot(),
    });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'snapshot:init',
        snapshot: buildSnapshot(),
      })
    );

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'ping:check') {
          ws.send(JSON.stringify({ type: 'pong:check', clientSentMs: msg.clientSentMs, serverMs: Date.now() }));
        }
      } catch {
        // Ignore malformed socket frames
      }
    });
  });

  // Authoritative 1-second Green Corridor & Signal Engine loop
  setInterval(() => {
    evaluateGreenCorridorAndSignals(Date.now(), 1);
    broadcastSnapshot('state:update');
  }, 1000);

  // --- REST API ---

  app.get('/api/snapshot', (_req, res) => {
    res.json(buildSnapshot());
  });

  // Create a new Emergency Run
  app.post('/api/runs', (req, res) => {
    const {
      vehicleId,
      corridorId,
      customOriginIntersectionId,
      customDestIntersectionId,
      targetSpeedKmh = 58,
      autoDrive = true,
      incidentNote = 'Emergency Priority Dispatch',
    } = req.body ?? {};

    const vehicle = dbState.vehicles.find((v) => v.id === vehicleId) ?? dbState.vehicles[0];

    // Prevent duplicate active run for the exact same vehicle
    const existingForVehicle = activeRuns.find((r) => r.vehicleId === vehicle.id);
    if (existingForVehicle) {
      res.status(409).json({
        error: `Vehicle ${vehicle.id} already has an active run (${existingForVehicle.id}). End it first or select another unit.`,
      });
      return;
    }

    let waypoints: RouteWaypoint[] = [];
    let originName = '';
    let destinationName = '';
    let selectedCorridorId = corridorId || 'CUSTOM';

    if (corridorId && corridorId !== 'CUSTOM') {
      const preset = CORRIDOR_PRESETS.find((c) => c.id === corridorId) ?? CORRIDOR_PRESETS[0];
      waypoints = preset.waypoints.map((w) => ({ ...w }));
      originName = preset.originName;
      destinationName = preset.destinationName;
      selectedCorridorId = preset.id;
    } else {
      const origInt =
        intersections.find((i) => i.id === customOriginIntersectionId) ?? intersections[2];
      const destInt =
        intersections.find((i) => i.id === customDestIntersectionId && i.id !== origInt.id) ??
        intersections[0];

      // Build intermediate path across city junctions sorted by projection along origin -> dest vector
      const vx = destInt.locationLng - origInt.locationLng;
      const vy = destInt.locationLat - origInt.locationLat;
      const vLenSq = vx * vx + vy * vy || 1;
      const primaryAxis: DirectionAxis = Math.abs(vy) >= Math.abs(vx) ? 'NS' : 'EW';

      const intermediates = intersections
        .filter((cand) => {
          if (cand.id === origInt.id || cand.id === destInt.id) return true;
          const wx = cand.locationLng - origInt.locationLng;
          const wy = cand.locationLat - origInt.locationLat;
          const t = (wx * vx + wy * vy) / vLenSq;
          if (t < 0.05 || t > 0.95) return false;
          const projLng = origInt.locationLng + t * vx;
          const projLat = origInt.locationLat + t * vy;
          const perpDistM = haversineMeters(cand.locationLat, cand.locationLng, projLat, projLng);
          return perpDistM <= 1850;
        })
        .sort((a, b) => {
          const dA = haversineMeters(origInt.locationLat, origInt.locationLng, a.locationLat, a.locationLng);
          const dB = haversineMeters(origInt.locationLat, origInt.locationLng, b.locationLat, b.locationLng);
          return dA - dB;
        });

      const startLeadLat = origInt.locationLat - vy * 0.08;
      const startLeadLng = origInt.locationLng - vx * 0.08;
      const endTailLat = destInt.locationLat + vy * 0.08;
      const endTailLng = destInt.locationLng + vx * 0.08;

      waypoints = [
        { lat: startLeadLat, lng: startLeadLng, label: `Dispatch near ${origInt.name}` },
        ...intermediates.map((node) => ({
          lat: node.locationLat,
          lng: node.locationLng,
          label: node.name,
          intersectionId: node.id,
          approachDirection: primaryAxis,
        })),
        { lat: endTailLat, lng: endTailLng, label: `Emergency Destination (${destInt.name})` },
      ];
      originName = `Sector Dispatch (${origInt.name})`;
      destinationName = `Destination (${destInt.name})`;
    }

    const nowMs = Date.now();
    const cleanSpeed = Math.min(95, Math.max(25, Number(targetSpeedKmh) || 58));
    const speedMps = cleanSpeed / 3.6;

    const intersectionProgress: IntersectionRunProgress[] = waypoints
      .map((wp, idx): IntersectionRunProgress | null => {
        if (!wp.intersectionId) return null;
        const distM = distanceFromStartToWaypointIndex(waypoints, idx);
        const plannedEtaSec = Math.max(2, Math.round(distM / speedMps));
        const intObj = intersections.find((i) => i.id === wp.intersectionId);
        return {
          intersectionId: wp.intersectionId,
          intersectionName: intObj?.name ?? wp.intersectionId,
          approachDirection: wp.approachDirection ?? 'NS',
          distanceRemainingM: Math.round(distM),
          etaSec: plannedEtaSec,
          plannedArrivalEpochMs: nowMs + plannedEtaSec * 1000,
          status: 'UPCOMING' as const,
          delaySec: null,
          secondsSaved: null,
        };
      })
      .filter((x): x is IntersectionRunProgress => x !== null);

    const runId = `RUN-${Math.floor(2500 + Math.random() * 7400)}`;
    const newRun: EmergencyRun = {
      id: runId,
      vehicleId: vehicle.id,
      vehicleType: vehicle.type,
      agencyName: vehicle.agencyName,
      callsign: vehicle.callsign,
      corridorId: selectedCorridorId,
      originName,
      destinationName,
      startTime: new Date(nowMs).toISOString(),
      endTime: null,
      status: 'ACTIVE',
      currentLat: waypoints[0].lat,
      currentLng: waypoints[0].lng,
      currentSpeedKmh: cleanSpeed,
      targetSpeedKmh: cleanSpeed,
      autoDrive: Boolean(autoDrive),
      rerouted: false,
      progressFraction: 0,
      waypoints,
      intersectionProgress,
      broadcastPacketsExpected: 1,
      broadcastPacketsReceived: 1,
      lastUpdateEpochMs: nowMs,
      lastSyncLatencyMs: 94,
      totalDelaySec: 0,
      baselineTotalDelaySec: 0,
      totalSecondsSaved: 0,
      intersectionsPrioritized: 0,
      worstIntersectionId: null,
      incidentNote: String(incidentNote).slice(0, 140),
    };

    activeRuns.unshift(newRun);
    runDistanceAlongMap.set(newRun.id, 0);

    evaluateGreenCorridorAndSignals(nowMs, 0);
    broadcastSnapshot('state:update');
    res.status(201).json(newRun);
  });

  // Live Driver GPS Location & Speed Broadcast
  app.post('/api/runs/:runId/location', (req, res) => {
    const receivedAtMs = Date.now();
    const { runId } = req.params;
    const run = activeRuns.find((r) => r.id === runId);
    if (!run) {
      res.status(404).json({ error: 'Active run not found' });
      return;
    }

    const { lat, lng, speedKmh, advanceMeters, autoDrive, clientTimestampMs } = req.body ?? {};
    const totalM = polylineTotalMeters(run.waypoints);
    let currentDistM = runDistanceAlongMap.get(run.id) ?? 0;

    if (typeof autoDrive === 'boolean') {
      run.autoDrive = autoDrive;
    }
    if (typeof speedKmh === 'number' && speedKmh >= 10 && speedKmh <= 110) {
      run.targetSpeedKmh = speedKmh;
      run.currentSpeedKmh = speedKmh;
    }

    if (typeof advanceMeters === 'number' && advanceMeters > 0) {
      currentDistM = Math.min(totalM, currentDistM + advanceMeters);
      runDistanceAlongMap.set(run.id, currentDistM);
      const pos = interpolateAlongPolyline(run.waypoints, currentDistM);
      run.currentLat = pos.lat;
      run.currentLng = pos.lng;
      run.progressFraction = pos.fraction;
    } else if (typeof lat === 'number' && typeof lng === 'number') {
      // Map-match or advance run along corridor from real GPS telemetry
      // If device GPS is outside New Delhi (>15km away), advance proportionally using GPS movement/ping
      const distFromRouteStart = haversineMeters(
        lat,
        lng,
        run.waypoints[0].lat,
        run.waypoints[0].lng
      );
      if (distFromRouteStart < 15000) {
        run.currentLat = lat;
        run.currentLng = lng;
      } else {
        // Project live GPS heartbeat onto active corridor progression
        currentDistM = Math.min(totalM, currentDistM + (run.targetSpeedKmh / 3.6) * 2.5);
        runDistanceAlongMap.set(run.id, currentDistM);
        const pos = interpolateAlongPolyline(run.waypoints, currentDistM);
        run.currentLat = pos.lat;
        run.currentLng = pos.lng;
        run.progressFraction = pos.fraction;
      }
    }

    run.broadcastPacketsExpected += 1;
    run.broadcastPacketsReceived += 1;
    run.lastUpdateEpochMs = receivedAtMs;
    const measuredLatency =
      typeof clientTimestampMs === 'number'
        ? Math.max(12, Math.min(950, receivedAtMs - clientTimestampMs))
        : 68;
    run.lastSyncLatencyMs = measuredLatency;

    evaluateGreenCorridorAndSignals(receivedAtMs, 0);
    broadcastSnapshot('state:update');
    res.json({ ok: true, latencyMs: measuredLatency, run });
  });

  // Dynamic Reroute Around Road Blockage (Fire Brigade / Ambulance on-the-fly route adjustment)
  app.post('/api/runs/:runId/reroute', (req, res) => {
    const { runId } = req.params;
    const run = activeRuns.find((r) => r.id === runId);
    if (!run) {
      res.status(404).json({ error: 'Active run not found' });
      return;
    }

    const preset = CORRIDOR_PRESETS.find((c) => c.id === run.corridorId);
    if (!preset || !preset.alternateWaypoints || run.rerouted) {
      res.status(400).json({ error: 'Alternate corridor already active or unavailable for this route' });
      return;
    }

    const nowMs = Date.now();
    const passedIds = new Set(
      run.intersectionProgress.filter((p) => p.status === 'PASSED').map((p) => p.intersectionId)
    );

    const remainingWaypoints: RouteWaypoint[] = [
      { lat: run.currentLat, lng: run.currentLng, label: 'Reroute Divergence Point' },
      ...preset.alternateWaypoints.slice(1).filter((w) => !w.intersectionId || !passedIds.has(w.intersectionId)),
    ];

    run.waypoints = remainingWaypoints;
    run.rerouted = true;
    runDistanceAlongMap.set(run.id, 0);

    const speedMps = Math.max(8, run.targetSpeedKmh / 3.6);
    const keptPassed = run.intersectionProgress.filter((p) => p.status === 'PASSED');
    const newUpcoming: IntersectionRunProgress[] = remainingWaypoints
      .map((wp, idx): IntersectionRunProgress | null => {
        if (!wp.intersectionId) return null;
        const distM = distanceFromStartToWaypointIndex(remainingWaypoints, idx);
        const etaSec = Math.max(3, Math.round(distM / speedMps));
        const intObj = intersections.find((i) => i.id === wp.intersectionId);
        return {
          intersectionId: wp.intersectionId,
          intersectionName: intObj?.name ?? wp.intersectionId,
          approachDirection: wp.approachDirection ?? 'NS',
          distanceRemainingM: Math.round(distM),
          etaSec,
          plannedArrivalEpochMs: nowMs + etaSec * 1000,
          status: 'UPCOMING' as const,
          delaySec: null,
          secondsSaved: null,
        };
      })
      .filter((x): x is IntersectionRunProgress => x !== null);

    run.intersectionProgress = [...keptPassed, ...newUpcoming];
    run.incidentNote = `${run.incidentNote} · Rerouted (${preset.alternateSummary ?? 'Alternate corridor'})`.slice(0, 160);

    evaluateGreenCorridorAndSignals(nowMs, 0);
    broadcastSnapshot('state:update');
    res.json(run);
  });

  // Prototype quick-step: Cross next approaching intersection immediately
  app.post('/api/runs/:runId/cross-next', (req, res) => {
    const { runId } = req.params;
    const run = activeRuns.find((r) => r.id === runId);
    if (!run) {
      res.status(404).json({ error: 'Active run not found' });
      return;
    }

    const nextProg = run.intersectionProgress.find((p) => p.status !== 'PASSED');
    if (!nextProg) {
      finalizeRun(run, 'COMPLETED');
      broadcastSnapshot('state:update');
      res.json(run);
      return;
    }

    const wpIdx = run.waypoints.findIndex((w) => w.intersectionId === nextProg.intersectionId);
    const totalM = polylineTotalMeters(run.waypoints);
    if (wpIdx !== -1) {
      const targetDistM = Math.min(totalM, distanceFromStartToWaypointIndex(run.waypoints, wpIdx) + 22);
      runDistanceAlongMap.set(run.id, targetDistM);
      const pos = interpolateAlongPolyline(run.waypoints, targetDistM);
      run.currentLat = pos.lat;
      run.currentLng = pos.lng;
      run.progressFraction = pos.fraction;
    }

    evaluateGreenCorridorAndSignals(Date.now(), 0);
    broadcastSnapshot('state:update');
    res.json(run);
  });

  // End or cancel an Emergency Run
  app.post('/api/runs/:runId/end', (req, res) => {
    const { runId } = req.params;
    const { status = 'COMPLETED' } = req.body ?? {};
    const run = activeRuns.find((r) => r.id === runId);
    if (!run) {
      res.status(404).json({ error: 'Active run not found' });
      return;
    }
    finalizeRun(run, status === 'CANCELLED' ? 'CANCELLED' : 'COMPLETED');
    evaluateGreenCorridorAndSignals(Date.now(), 0);
    broadcastSnapshot('state:update');
    res.json(run);
  });

  // Operator Manual Signal Override / Auto Toggle / Controller Fault Simulation
  app.post('/api/intersections/:id/control', (req, res) => {
    const { id } = req.params;
    const { action, durationSec = 15, operatorName = 'Control Room Operator' } = req.body ?? {};
    const intersection = intersections.find((i) => i.id === id);
    if (!intersection) {
      res.status(404).json({ error: 'Intersection not found' });
      return;
    }
    const rt = signalRuntime.get(intersection.id)!;
    const nowMs = Date.now();
    const holdMs = Math.min(60000, Math.max(5000, Number(durationSec) * 1000));

    if (action === 'FORCE_NS_GREEN' || action === 'FORCE_EW_GREEN') {
      const axis: DirectionAxis = action === 'FORCE_NS_GREEN' ? 'NS' : 'EW';
      intersection.operationalStatus = 'MANUAL_OVERRIDE';
      intersection.controlMode = 'MANUAL';
      rt.manualOverrideAxis = axis;
      rt.manualOverrideUntilMs = nowMs + holdMs;
      intersection.signals = axis === 'NS' ? { NS: 'GREEN', EW: 'RED' } : { NS: 'RED', EW: 'GREEN' };
      intersection.phaseRemainingSec = Math.round(holdMs / 1000);

      appendCommandLog({
        intersectionId: intersection.id,
        intersectionName: intersection.name,
        controllerId: intersection.controllerId,
        runId: intersection.activePriorityRunId,
        commandType: 'MANUAL_OVERRIDE',
        serialFrame: `${intersection.id}:OVERRIDE:${axis}:${holdMs}\\n`,
        esp32JsonPayload: JSON.stringify({
          intersectionId: intersection.id,
          state: axis === 'NS' ? { NS: 'green', EW: 'red' } : { NS: 'red', EW: 'green' },
          durationMs: holdMs,
          override: true,
        }),
        issuedBy: operatorName,
        latencyMs: 74,
      });
    } else if (action === 'SET_AUTO') {
      intersection.controlMode = 'AUTO';
      if (intersection.operationalStatus === 'OFFLINE') {
        intersection.operationalStatus = 'NORMAL';
      }
      rt.manualOverrideAxis = null;
      rt.manualOverrideUntilMs = null;

      appendCommandLog({
        intersectionId: intersection.id,
        intersectionName: intersection.name,
        controllerId: intersection.controllerId,
        runId: null,
        commandType: 'RESET_TO_NORMAL',
        serialFrame: `${intersection.id}:NORMAL\\n`,
        esp32JsonPayload: JSON.stringify({
          intersectionId: intersection.id,
          mode: 'AUTO_ADAPTIVE',
        }),
        issuedBy: operatorName,
        latencyMs: 69,
      });
    } else if (action === 'TOGGLE_OFFLINE') {
      const goingOffline = intersection.operationalStatus !== 'OFFLINE';
      intersection.operationalStatus = goingOffline ? 'OFFLINE' : 'NORMAL';
      if (!goingOffline) {
        intersection.controlMode = 'AUTO';
      }
      appendCommandLog({
        intersectionId: intersection.id,
        intersectionName: intersection.name,
        controllerId: intersection.controllerId,
        runId: null,
        commandType: 'FAULT_SIMULATION',
        serialFrame: goingOffline ? `${intersection.id}:FAULT_BLINK_AMBER\\n` : `${intersection.id}:NORMAL\\n`,
        esp32JsonPayload: JSON.stringify({
          intersectionId: intersection.id,
          status: goingOffline ? 'OFFLINE_BLINK' : 'ONLINE_RESTORED',
        }),
        issuedBy: operatorName,
        latencyMs: 112,
      });
    }

    evaluateGreenCorridorAndSignals(nowMs, 0);
    broadcastSnapshot('state:update');
    res.json(intersection);
  });

  // Register a new Emergency Vehicle
  app.post('/api/vehicles', (req, res) => {
    const { id, type, agencyName, registrationNumber, baseStation, callsign } = req.body ?? {};
    const cleanType: AgencyType = type === 'FIRE' ? 'FIRE' : 'AMBULANCE';
    const cleanId =
      String(id || `${cleanType === 'FIRE' ? 'FIRE' : 'AMB'}-DL-${Math.floor(200 + Math.random() * 799)}`)
        .trim()
        .toUpperCase();

    if (dbState.vehicles.some((v) => v.id === cleanId)) {
      res.status(409).json({ error: `Vehicle ID ${cleanId} is already registered.` });
      return;
    }

    const vehicle: Vehicle = {
      id: cleanId,
      type: cleanType,
      agencyName: String(agencyName || (cleanType === 'FIRE' ? 'Delhi Fire Service' : 'CATS Ambulance')).trim(),
      registrationNumber: String(registrationNumber || 'DL-01-EM-1001').trim().toUpperCase(),
      baseStation: String(baseStation || 'Central Dispatch').trim(),
      callsign: String(callsign || cleanId).trim(),
    };

    dbState.vehicles.push(vehicle);
    schedulePersist();
    broadcastSnapshot('state:update');
    res.status(201).json(vehicle);
  });

  // Dedicated Analytics endpoints (Section 6.6)
  app.get('/api/analytics/intersections', (_req, res) => {
    const summary = intersections.map((int) => {
      const logs = dbState.passageLogs.filter((l) => l.intersectionId === int.id);
      const count = logs.length;
      const avgDelay =
        count > 0
          ? Number((logs.reduce((s, l) => s + l.estimatedDelaySeconds, 0) / count).toFixed(1))
          : 0;
      const totalSaved = logs.reduce((s, l) => s + l.secondsSaved, 0);
      const priorityRate =
        count > 0
          ? Math.round((logs.filter((l) => l.priorityGranted).length / count) * 100)
          : 100;
      return {
        intersectionId: int.id,
        name: int.name,
        zone: int.zone,
        departmentOwner: int.departmentOwner,
        controllerId: int.controllerId,
        passagesLogged: count,
        avgEmergencyDelaySec: avgDelay,
        baselineAvgDelaySec: int.baselineAvgDelaySec,
        totalSecondsSaved: totalSaved,
        priorityGrantedPct: priorityRate,
      };
    });
    res.json(summary);
  });

  app.get('/api/analytics/runs', (_req, res) => {
    res.json(dbState.completedRuns);
  });

  // Vite middleware in development, static dist serving in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`RescueRoute Signal Sync server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
