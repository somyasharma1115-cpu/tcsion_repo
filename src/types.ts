export type UserRole = 'DRIVER' | 'OPERATOR' | 'ADMIN';

export type AgencyType = 'AMBULANCE' | 'FIRE';

export type LightColor = 'RED' | 'AMBER' | 'GREEN';

export type DirectionAxis = 'NS' | 'EW';

export type IntersectionControlMode = 'AUTO' | 'MANUAL';

export type IntersectionOperationalStatus = 'PRIORITY_ACTIVE' | 'APPROACHING' | 'NORMAL' | 'MANUAL_OVERRIDE' | 'OFFLINE';

export interface UserAccount {
  id: string;
  name: string;
  role: UserRole;
  organization: string;
  badgeCode: string;
}

export interface Vehicle {
  id: string;
  type: AgencyType;
  agencyName: string;
  registrationNumber: string;
  baseStation: string;
  callsign: string;
}

export interface SignalAspectState {
  NS: LightColor;
  EW: LightColor;
}

export interface Intersection {
  id: string;
  name: string;
  zone: string;
  departmentOwner: string;
  locationLat: number;
  locationLng: number;
  controllerId: string;
  hardwareProtocol: 'SERIAL_USB' | 'ESP32_WIFI';
  controlMode: IntersectionControlMode;
  operationalStatus: IntersectionOperationalStatus;
  signals: SignalAspectState;
  phaseRemainingSec: number;
  activePriorityRunId: string | null;
  activePriorityDirection: DirectionAxis | null;
  nextArrivalEtaSec: number | null;
  nextArrivalVehicleId: string | null;
  baselineAvgDelaySec: number;
}

export interface RouteWaypoint {
  lat: number;
  lng: number;
  label?: string;
  intersectionId?: string;
  approachDirection?: DirectionAxis;
}

export interface CorridorPreset {
  id: string;
  name: string;
  recommendedType: AgencyType;
  originName: string;
  destinationName: string;
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  waypoints: RouteWaypoint[];
  alternateWaypoints?: RouteWaypoint[];
  alternateSummary?: string;
  distanceKm: number;
}

export interface IntersectionRunProgress {
  intersectionId: string;
  intersectionName: string;
  approachDirection: DirectionAxis;
  distanceRemainingM: number;
  etaSec: number | null;
  plannedArrivalEpochMs: number;
  status: 'UPCOMING' | 'PRIORITY_SYNCED' | 'CROSSING' | 'PASSED';
  delaySec: number | null;
  secondsSaved: number | null;
}

export interface EmergencyRun {
  id: string;
  vehicleId: string;
  vehicleType: AgencyType;
  agencyName: string;
  callsign: string;
  corridorId: string;
  originName: string;
  destinationName: string;
  startTime: string;
  endTime: string | null;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  currentLat: number;
  currentLng: number;
  currentSpeedKmh: number;
  targetSpeedKmh: number;
  autoDrive: boolean;
  rerouted: boolean;
  progressFraction: number;
  waypoints: RouteWaypoint[];
  intersectionProgress: IntersectionRunProgress[];
  broadcastPacketsExpected: number;
  broadcastPacketsReceived: number;
  lastUpdateEpochMs: number;
  lastSyncLatencyMs: number;
  totalDelaySec: number;
  baselineTotalDelaySec: number;
  totalSecondsSaved: number;
  intersectionsPrioritized: number;
  worstIntersectionId: string | null;
  incidentNote: string;
}

export interface IntersectionPassageLog {
  id: string;
  runId: string;
  vehicleId: string;
  vehicleType: AgencyType;
  agencyName: string;
  intersectionId: string;
  intersectionName: string;
  departmentOwner: string;
  zone: string;
  approachDirection: DirectionAxis;
  timeEtaPlanned: string;
  timeArrived: string;
  timeExited: string;
  estimatedDelaySeconds: number;
  baselineExpectedDelaySeconds: number;
  secondsSaved: number;
  priorityGranted: boolean;
  signalStateBefore: SignalAspectState;
  signalStateAfter: SignalAspectState;
}

export interface SignalCommandLog {
  id: string;
  intersectionId: string;
  intersectionName: string;
  controllerId: string;
  runId: string | null;
  timestamp: string;
  commandType: 'SET_PHASE_PRIORITY' | 'MANUAL_OVERRIDE' | 'RESET_TO_NORMAL' | 'FAULT_SIMULATION';
  serialFrame: string;
  esp32JsonPayload: string;
  issuedBy: string;
  latencyMs: number;
}

export interface SystemSnapshot {
  serverTime: string;
  intersections: Intersection[];
  vehicles: Vehicle[];
  users: UserAccount[];
  corridors: CorridorPreset[];
  activeRuns: EmergencyRun[];
  completedRuns: EmergencyRun[];
  passageLogs: IntersectionPassageLog[];
  commandLogs: SignalCommandLog[];
}
