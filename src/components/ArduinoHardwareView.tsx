import { useState } from 'react';
import { Check, Copy, Cpu, Download, RotateCcw, Send, Terminal } from 'lucide-react';
import type { Intersection, LightColor, SystemSnapshot } from '../types';

interface ArduinoHardwareViewProps {
  snapshot: SystemSnapshot;
  operatorName: string;
  onControlIntersection: (
    intersectionId: string,
    action: 'FORCE_NS_GREEN' | 'FORCE_EW_GREEN' | 'SET_AUTO' | 'TOGGLE_OFFLINE',
    durationSec?: number,
    operatorName?: string
  ) => Promise<void>;
}

const ARDUINO_SKETCH_SOURCE = `/*
 * RescueRoute Signal Sync — 4-Intersection Arduino Uno / ESP32 Firmware
 * Serial Protocol (115200 baud):
 *   "I1:PRIORITY:NS:15000\\n" -> Set Intersection I1 North-South GREEN, East-West RED for 15000ms
 *   "I1:PRIORITY:EW:15000\\n" -> Set Intersection I1 East-West GREEN, North-South RED for 15000ms
 *   "I1:NORMAL\\n"            -> Restore Intersection I1 to standard fixed-time cycle
 */

struct SignalNode {
  const char* id;
  int nsRedPin;
  int nsGreenPin;
  int ewRedPin;
  int ewGreenPin;
  bool priorityMode;
  bool priorityNS;
  unsigned long priorityExpiryMs;
};

SignalNode nodes[3] = {
  { "I1", 2, 3, 4, 5, false, true, 0 },
  { "I2", 6, 7, 8, 9, false, true, 0 },
  { "I3", 10, 11, 12, 13, false, true, 0 }
};

unsigned long cycleStartMs = 0;
const unsigned long NORMAL_PHASE_MS = 10000;
const unsigned long ALL_RED_CLEAR_MS = 2000;

void applyLeds(const SignalNode& n, bool nsGreen, bool ewGreen) {
  digitalWrite(n.nsGreenPin, nsGreen ? HIGH : LOW);
  digitalWrite(n.nsRedPin,   nsGreen ? LOW  : HIGH);
  digitalWrite(n.ewGreenPin, ewGreen ? HIGH : LOW);
  digitalWrite(n.ewRedPin,   ewGreen ? LOW  : HIGH);
}

void parseCommand(String line) {
  line.trim();
  if (line.length() == 0) return;

  int p1 = line.indexOf(':');
  if (p1 < 0) return;
  String nodeId = line.substring(0, p1);
  String rest = line.substring(p1 + 1);

  for (int i = 0; i < 3; i++) {
    if (nodeId.equalsIgnoreCase(nodes[i].id)) {
      if (rest.startsWith("NORMAL")) {
        nodes[i].priorityMode = false;
        Serial.println("ACK:" + nodeId + ":NORMAL");
      } else if (rest.startsWith("PRIORITY:") || rest.startsWith("OVERRIDE:")) {
        int p2 = rest.indexOf(':');
        int p3 = rest.indexOf(':', p2 + 1);
        String axis = rest.substring(p2 + 1, p3);
        long holdMs = rest.substring(p3 + 1).toInt();
        if (holdMs <= 0) holdMs = 12000;

        nodes[i].priorityMode = true;
        nodes[i].priorityNS = axis.equalsIgnoreCase("NS");
        nodes[i].priorityExpiryMs = millis() + (unsigned long)holdMs;
        Serial.println("ACK:" + nodeId + ":PRIORITY:" + axis);
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 3; i++) {
    pinMode(nodes[i].nsRedPin, OUTPUT);
    pinMode(nodes[i].nsGreenPin, OUTPUT);
    pinMode(nodes[i].ewRedPin, OUTPUT);
    pinMode(nodes[i].ewGreenPin, OUTPUT);
  }
  cycleStartMs = millis();
  Serial.println("RESCUEROUTE_CONTROLLER_READY");
}

void loop() {
  while (Serial.available() > 0) {
    String incoming = Serial.readStringUntil('\\n');
    parseCommand(incoming);
  }

  unsigned long now = millis();
  unsigned long cyclePos = (now - cycleStartMs) % (2 * (NORMAL_PHASE_MS + ALL_RED_CLEAR_MS));

  for (int i = 0; i < 3; i++) {
    if (nodes[i].priorityMode && now >= nodes[i].priorityExpiryMs) {
      nodes[i].priorityMode = false; // Safety fallback watchdog
    }

    if (nodes[i].priorityMode) {
      applyLeds(nodes[i], nodes[i].priorityNS, !nodes[i].priorityNS);
    } else {
      bool nsGreen = (cyclePos < NORMAL_PHASE_MS);
      bool ewGreen = (cyclePos >= NORMAL_PHASE_MS + ALL_RED_CLEAR_MS) &&
                     (cyclePos < 2 * NORMAL_PHASE_MS + ALL_RED_CLEAR_MS);
      applyLeds(nodes[i], nsGreen, ewGreen);
    }
  }
  delay(25);
}
`;

function ledGlowClass(color: LightColor, active: boolean) {
  if (!active) return 'bg-slate-800 border-slate-700 opacity-40';
  if (color === 'GREEN') {
    return 'bg-emerald-400 border-emerald-300 shadow-[0_0_12px_rgba(52,211,153,0.85)]';
  }
  if (color === 'AMBER') {
    return 'bg-amber-400 border-amber-300 shadow-[0_0_12px_rgba(251,191,36,0.85)]';
  }
  return 'bg-red-500 border-red-400 shadow-[0_0_12px_rgba(239,68,68,0.85)]';
}

function pinMapLabel(int: Intersection): string {
  const map: Record<string, string> = {
    I1: 'USB /dev/ttyACM0 · Pins D2–D5',
    I2: 'USB /dev/ttyACM0 · Pins D6–D9',
    I3: 'USB /dev/ttyACM0 · Pins D10–D13',
    I4: 'USB /dev/ttyACM1 · Pins D2–D5',
    I5: 'WiFi HTTP POST · GPIO 16–19',
    I6: 'WiFi HTTP POST · GPIO 21–25',
  };
  return map[int.id] ?? 'Serial GPIO Bus';
}

export function ArduinoHardwareView({
  snapshot,
  operatorName,
  onControlIntersection,
}: ArduinoHardwareViewProps) {
  const [activeTab, setActiveTab] = useState<'BENCH' | 'FIRMWARE'>('BENCH');
  const [protocolView, setProtocolView] = useState<'SERIAL' | 'ESP32_JSON'>('SERIAL');
  const [serialInput, setSerialInput] = useState<string>('I1:PRIORITY:NS:15000');
  const [serialStatus, setSerialStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);

  async function handleSendManualSerial(e: React.FormEvent) {
    e.preventDefault();
    const cleaned = serialInput.trim().toUpperCase();
    // Parse format: I1:PRIORITY:NS:15000 or I1:NORMAL
    const parts = cleaned.split(':');
    const nodeId = parts[0];
    const targetInt = snapshot.intersections.find((i) => i.id === nodeId);

    if (!targetInt) {
      setSerialStatus(`Unknown intersection ID "${nodeId}". Valid IDs: I1..I6.`);
      return;
    }

    try {
      if (parts[1] === 'NORMAL' || parts[1] === 'RESET') {
        await onControlIntersection(nodeId, 'SET_AUTO', 15, `${operatorName} (Serial Bench)`);
        setSerialStatus(`ACK:${nodeId}:NORMAL — Restored adaptive cycle.`);
      } else if (parts[1] === 'PRIORITY' || parts[1] === 'OVERRIDE') {
        const axis = parts[2] === 'EW' ? 'FORCE_EW_GREEN' : 'FORCE_NS_GREEN';
        const durationSec = parts[3] ? Math.round(Number(parts[3]) / 1000) : 15;
        await onControlIntersection(
          nodeId,
          axis,
          Math.max(5, Math.min(60, durationSec || 15)),
          `${operatorName} (Serial Bench)`
        );
        setSerialStatus(`ACK:${nodeId}:PRIORITY:${parts[2] || 'NS'} — LEDs latched.`);
      } else {
        setSerialStatus('Syntax: I1:PRIORITY:NS:15000 or I1:NORMAL');
      }
    } catch (err) {
      setSerialStatus(err instanceof Error ? err.message : 'Serial dispatch error');
    }
  }

  function handleCopySketch() {
    navigator.clipboard.writeText(ARDUINO_SKETCH_SOURCE);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownloadSketch() {
    const blob = new Blob([ARDUINO_SKETCH_SOURCE], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rescueroute_signal_controller.ino';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* Mode Sub-Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl px-5 py-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Arduino Uno &amp; ESP32 Traffic Signal Hardware Simulator
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Live physical LED intersection rig synchronized in real time with the Green Corridor
            Engine via serial/WiFi adapter frames
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            type="button"
            onClick={() => setActiveTab('BENCH')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
              activeTab === 'BENCH'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>Live LED Intersection Rig</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('FIRMWARE')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 ${
              activeTab === 'FIRMWARE'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Arduino Sketch (.ino)</span>
          </button>
        </div>
      </div>

      {activeTab === 'BENCH' ? (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Left 8 Columns: Physical Dark-Bezel PCB / LED Intersection Boards */}
          <div className="xl:col-span-8 grid grid-cols-1 md:grid-cols-2 gap-5">
            {snapshot.intersections.map((int) => {
              const isPriority = int.operationalStatus === 'PRIORITY_ACTIVE';
              const isOffline = int.operationalStatus === 'OFFLINE';

              return (
                <div
                  key={int.id}
                  className="bg-slate-900 text-slate-100 border border-slate-800 rounded-xl p-5 flex flex-col justify-between"
                >
                  {/* Instrument Bezel Top Row */}
                  <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-800">
                    <div className="min-w-0">
                      <div className="text-[11px] font-mono text-slate-400">
                        {int.id} · {int.controllerId}
                      </div>
                      <h3 className="text-sm font-semibold text-white truncate mt-0.5">
                        {int.name}
                      </h3>
                      <div className="text-[11px] font-mono text-slate-400 mt-0.5">
                        {pinMapLabel(int)}
                      </div>
                    </div>

                    {/* Digital Countdown Readout */}
                    <div className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-right shrink-0">
                      <div className="text-[9px] font-mono text-slate-400">TIMER</div>
                      <div
                        className={`text-base font-mono font-bold tabular-nums ${
                          isOffline
                            ? 'text-amber-400'
                            : isPriority
                            ? 'text-emerald-400'
                            : 'text-slate-100'
                        }`}
                      >
                        {isOffline ? 'ERR' : `${String(int.phaseRemainingSec).padStart(2, '0')}s`}
                      </div>
                    </div>
                  </div>

                  {/* 4-Way Physical Road & LED Signal Visualization */}
                  <div className="my-4 relative h-44 bg-slate-950 border border-slate-800 rounded-lg overflow-hidden flex items-center justify-center">
                    {/* Vertical NS Road */}
                    <div className="absolute inset-y-0 w-16 bg-slate-900 border-x border-slate-800 flex flex-col items-center justify-between py-2">
                      <span className="text-[9px] font-mono text-slate-500">N</span>
                      <div className="h-full border-l border-dashed border-slate-700 my-1" />
                      <span className="text-[9px] font-mono text-slate-500">S</span>
                    </div>

                    {/* Horizontal EW Road */}
                    <div className="absolute inset-x-0 h-14 bg-slate-900 border-y border-slate-800 flex items-center justify-between px-3">
                      <span className="text-[9px] font-mono text-slate-500">W</span>
                      <div className="w-full border-t border-dashed border-slate-700 mx-2" />
                      <span className="text-[9px] font-mono text-slate-500">E</span>
                    </div>

                    {/* Center Junction Box */}
                    <div className="relative z-10 w-16 h-14 bg-slate-900 flex items-center justify-center border border-slate-800">
                      <span className="font-mono text-[10px] text-slate-400">
                        {isPriority
                          ? `${int.activePriorityDirection} PRI`
                          : int.controlMode === 'MANUAL'
                          ? 'MAN'
                          : 'AUTO'}
                      </span>
                    </div>

                    {/* North-South LED Housing (Top-Left Quadrant) */}
                    <div className="absolute top-2.5 left-3 z-20 bg-slate-900/95 border border-slate-700 rounded-md px-2 py-1.5 flex items-center gap-1.5">
                      <span className="font-mono text-[10px] text-slate-300 mr-0.5">NS</span>
                      <span
                        className={`w-3.5 h-3.5 rounded-full border ${ledGlowClass(
                          'RED',
                          int.signals.NS === 'RED'
                        )}`}
                      />
                      <span
                        className={`w-3.5 h-3.5 rounded-full border ${ledGlowClass(
                          'AMBER',
                          int.signals.NS === 'AMBER'
                        )}`}
                      />
                      <span
                        className={`w-3.5 h-3.5 rounded-full border ${ledGlowClass(
                          'GREEN',
                          int.signals.NS === 'GREEN'
                        )}`}
                      />
                    </div>

                    {/* East-West LED Housing (Bottom-Right Quadrant) */}
                    <div className="absolute bottom-2.5 right-3 z-20 bg-slate-900/95 border border-slate-700 rounded-md px-2 py-1.5 flex items-center gap-1.5">
                      <span className="font-mono text-[10px] text-slate-300 mr-0.5">EW</span>
                      <span
                        className={`w-3.5 h-3.5 rounded-full border ${ledGlowClass(
                          'RED',
                          int.signals.EW === 'RED'
                        )}`}
                      />
                      <span
                        className={`w-3.5 h-3.5 rounded-full border ${ledGlowClass(
                          'AMBER',
                          int.signals.EW === 'AMBER'
                        )}`}
                      />
                      <span
                        className={`w-3.5 h-3.5 rounded-full border ${ledGlowClass(
                          'GREEN',
                          int.signals.EW === 'GREEN'
                        )}`}
                      />
                    </div>

                    {/* Approaching Vehicle Indicator */}
                    {int.nextArrivalVehicleId && (
                      <div className="absolute bottom-2.5 left-3 z-20 font-mono text-[10px] text-emerald-400">
                        {int.nextArrivalVehicleId} ({int.nextArrivalEtaSec}s)
                      </div>
                    )}
                  </div>

                  {/* Hardware Push-Buttons */}
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          onControlIntersection(
                            int.id,
                            'FORCE_NS_GREEN',
                            15,
                            `${operatorName} (Hardware Rig)`
                          )
                        }
                        className="px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-[11px] font-mono text-slate-200 transition-colors whitespace-nowrap shrink-0"
                      >
                        NS Green
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onControlIntersection(
                            int.id,
                            'FORCE_EW_GREEN',
                            15,
                            `${operatorName} (Hardware Rig)`
                          )
                        }
                        className="px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-[11px] font-mono text-slate-200 transition-colors whitespace-nowrap shrink-0"
                      >
                        EW Green
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        onControlIntersection(
                          int.id,
                          'SET_AUTO',
                          15,
                          `${operatorName} (Hardware Rig)`
                        )
                      }
                      className="px-2.5 py-1.5 rounded border border-slate-700 hover:bg-slate-800 text-[11px] font-mono text-slate-300 flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Auto</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right 4 Columns: Serial UART / ESP32 WiFi Adapter Monitor & Injector */}
          <aside className="xl:col-span-4 space-y-5">
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Serial Command Bench Injector
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Send raw UART frames directly to the simulator adapter (115200 baud format)
                </p>
              </div>

              <form onSubmit={handleSendManualSerial} className="flex items-center gap-2">
                <input
                  type="text"
                  value={serialInput}
                  onChange={(e) => setSerialInput(e.target.value)}
                  placeholder="I1:PRIORITY:NS:15000"
                  className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
                <button
                  type="submit"
                  className="px-3.5 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>Transmit</span>
                </button>
              </form>

              <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono text-slate-500">
                <span>Presets:</span>
                <button
                  type="button"
                  onClick={() => setSerialInput('I1:PRIORITY:EW:15000')}
                  className="underline hover:text-slate-900"
                >
                  I1:PRIORITY:EW:15000
                </button>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => setSerialInput('I3:PRIORITY:NS:20000')}
                  className="underline hover:text-slate-900"
                >
                  I3:PRIORITY:NS:20000
                </button>
                <span>·</span>
                <button
                  type="button"
                  onClick={() => setSerialInput('I1:NORMAL')}
                  className="underline hover:text-slate-900"
                >
                  I1:NORMAL
                </button>
              </div>

              {serialStatus && (
                <div className="p-2.5 rounded-lg bg-slate-100 font-mono text-xs text-slate-800">
                  {serialStatus}
                </div>
              )}
            </div>

            {/* Live Adapter Log Feed */}
            <div className="bg-slate-950 text-slate-200 border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-2">
                <span className="text-xs font-mono font-semibold text-slate-200">
                  Simulator Adapter TX Stream
                </span>
                <div className="flex items-center gap-1 bg-slate-900 p-0.5 rounded-md">
                  <button
                    type="button"
                    onClick={() => setProtocolView('SERIAL')}
                    className={`px-2 py-1 text-[11px] font-mono rounded transition-colors whitespace-nowrap shrink-0 ${
                      protocolView === 'SERIAL'
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    UART Serial
                  </button>
                  <button
                    type="button"
                    onClick={() => setProtocolView('ESP32_JSON')}
                    className={`px-2 py-1 text-[11px] font-mono rounded transition-colors whitespace-nowrap shrink-0 ${
                      protocolView === 'ESP32_JSON'
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    ESP32 JSON
                  </button>
                </div>
              </div>

              <div className="p-4 space-y-2.5 max-h-[420px] overflow-y-auto font-mono text-xs">
                {snapshot.commandLogs.slice(0, 18).map((cmd) => (
                  <div key={cmd.id} className="pb-2.5 border-b border-slate-900 last:border-none">
                    <div className="flex items-center justify-between text-[10px] text-slate-400 tabular-nums">
                      <span>
                        [{new Date(cmd.timestamp).toLocaleTimeString()}] {cmd.controllerId}
                      </span>
                      <span>{cmd.latencyMs}ms</span>
                    </div>
                    <div className="mt-1 text-emerald-400 break-all">
                      {protocolView === 'SERIAL' ? cmd.serialFrame : cmd.esp32JsonPayload}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>
      ) : (
        /* ARDUINO UNO / ESP32 READY-TO-FLASH SKETCH VIEW */
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                rescueroute_signal_controller.ino
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Compatible with Arduino Uno R3 (USB Serial 115200 baud) and ESP32 DevKitC — includes
                hardware watchdog fallback to normal cycle
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopySketch}
                className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-800 hover:bg-slate-50 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Copied' : 'Copy Code'}</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadSketch}
                className="px-3.5 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download .ino</span>
              </button>
            </div>
          </div>

          <pre className="p-5 bg-slate-950 text-slate-100 font-mono text-xs leading-relaxed overflow-x-auto max-h-[560px]">
            <code>{ARDUINO_SKETCH_SOURCE}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
