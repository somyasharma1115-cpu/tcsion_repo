import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgencyType, EmergencyRun, SystemSnapshot } from '../types';

export interface StartRunPayload {
  vehicleId: string;
  corridorId: string;
  customOriginIntersectionId?: string;
  customDestIntersectionId?: string;
  targetSpeedKmh?: number;
  autoDrive?: boolean;
  incidentNote?: string;
}

export interface RegisterVehiclePayload {
  id: string;
  type: AgencyType;
  agencyName: string;
  registrationNumber: string;
  baseStation: string;
  callsign: string;
}

export function useRescueRouteSync() {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [wsRttMs, setWsRttMs] = useState<number>(42);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  const fetchSnapshotHttp = useCallback(async () => {
    try {
      const res = await fetch('/api/snapshot');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: SystemSnapshot = await res.json();
      setSnapshot(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load control room state');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let unmounted = false;
    fetchSnapshotHttp();

    function connectWs() {
      if (unmounted) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        if (unmounted) return;
        setConnected(true);
        setError(null);
        socket.send(JSON.stringify({ type: 'ping:check', clientSentMs: Date.now() }));
      };

      socket.onmessage = (event) => {
        if (unmounted) return;
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.type === 'snapshot:init' || parsed.type === 'state:update') {
            setSnapshot(parsed.snapshot);
            setLoading(false);
          } else if (parsed.type === 'pong:check' && typeof parsed.clientSentMs === 'number') {
            setWsRttMs(Math.max(8, Date.now() - parsed.clientSentMs));
          }
        } catch {
          // Ignore non-JSON frame
        }
      };

      socket.onclose = () => {
        if (unmounted) return;
        setConnected(false);
        reconnectTimerRef.current = window.setTimeout(connectWs, 2000);
      };

      socket.onerror = () => {
        socket.close();
      };
    }

    connectWs();

    const pingInterval = window.setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping:check', clientSentMs: Date.now() }));
      }
    }, 6000);

    return () => {
      unmounted = true;
      window.clearInterval(pingInterval);
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [fetchSnapshotHttp]);

  const startEmergencyRun = useCallback(async (payload: StartRunPayload): Promise<EmergencyRun> => {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not start emergency run');
    }
    return data as EmergencyRun;
  }, []);

  const broadcastLocation = useCallback(
    async (
      runId: string,
      payload: {
        lat?: number;
        lng?: number;
        speedKmh?: number;
        advanceMeters?: number;
        autoDrive?: boolean;
      }
    ) => {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, clientTimestampMs: Date.now() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Location broadcast failed');
      }
      return data;
    },
    []
  );

  const rerouteRun = useCallback(async (runId: string) => {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/reroute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Reroute unavailable');
    }
    return data as EmergencyRun;
  }, []);

  const crossNextIntersection = useCallback(async (runId: string) => {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/cross-next`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Could not advance junction');
    }
    return data as EmergencyRun;
  }, []);

  const endEmergencyRun = useCallback(
    async (runId: string, status: 'COMPLETED' | 'CANCELLED' = 'COMPLETED') => {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Could not end run');
      }
      return data as EmergencyRun;
    },
    []
  );

  const controlIntersection = useCallback(
    async (
      intersectionId: string,
      action: 'FORCE_NS_GREEN' | 'FORCE_EW_GREEN' | 'SET_AUTO' | 'TOGGLE_OFFLINE',
      durationSec = 15,
      operatorName = 'Control Room Operator'
    ) => {
      const res = await fetch(`/api/intersections/${encodeURIComponent(intersectionId)}/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, durationSec, operatorName }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Signal control command failed');
      }
      return data;
    },
    []
  );

  const registerVehicle = useCallback(async (payload: RegisterVehiclePayload) => {
    const res = await fetch('/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Vehicle registration failed');
    }
    return data;
  }, []);

  return {
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
  };
}
