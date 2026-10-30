import { useState } from 'react';
import { Check, Plus, ShieldCheck, Truck, UserCheck } from 'lucide-react';
import type { AgencyType, SystemSnapshot, UserAccount } from '../types';
import type { RegisterVehiclePayload } from '../hooks/useRescueRouteSync';

interface FleetAndRolesViewProps {
  snapshot: SystemSnapshot;
  currentUser: UserAccount;
  onSelectUser: (user: UserAccount) => void;
  onRegisterVehicle: (payload: RegisterVehiclePayload) => Promise<void>;
}

export function FleetAndRolesView({
  snapshot,
  currentUser,
  onSelectUser,
  onRegisterVehicle,
}: FleetAndRolesViewProps) {
  const [vehType, setVehType] = useState<AgencyType>('AMBULANCE');
  const [vehId, setVehId] = useState<string>('AMB-DL-305');
  const [agencyName, setAgencyName] = useState<string>('AIIMS Trauma Response');
  const [regNumber, setRegNumber] = useState<string>('DL-01-AM-7305');
  const [baseStation, setBaseStation] = useState<string>('AIIMS Gate 2');
  const [callsign, setCallsign] = useState<string>('Medic Delta 305');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  async function handleCreateVehicle(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFeedback(null);
    try {
      await onRegisterVehicle({
        id: vehId,
        type: vehType,
        agencyName,
        registrationNumber: regNumber,
        baseStation,
        callsign,
      });
      setFeedback({ kind: 'ok', msg: `Registered ${vehId} into active emergency fleet.` });
      const nextNum = Math.floor(310 + Math.random() * 580);
      setVehId(`${vehType === 'FIRE' ? 'FIRE' : 'AMB'}-DL-${nextNum}`);
      setRegNumber(`DL-02-${vehType === 'FIRE' ? 'FD' : 'AM'}-${nextNum}`);
      setCallsign(`${vehType === 'FIRE' ? 'Tender' : 'Medic'} Unit ${nextNum}`);
    } catch (err) {
      setFeedback({
        kind: 'err',
        msg: err instanceof Error ? err.message : 'Unable to register vehicle',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left 5 Columns: Role & Session Switcher */}
      <div className="lg:col-span-5 space-y-6">
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="text-base font-semibold text-slate-900">
              Operator, Driver &amp; Admin Role Profiles
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Switch authenticated session role to test Driver dispatch, Control Room overrides, and
              Municipal governance workflows
            </p>
          </div>

          <div className="divide-y divide-slate-100">
            {snapshot.users.map((u) => {
              const isCurrent = u.id === currentUser.id;
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => onSelectUser(u)}
                  className={`w-full text-left p-4 flex items-center justify-between gap-3 transition-colors ${
                    isCurrent ? 'bg-slate-50' : 'hover:bg-slate-50/60'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-mono text-slate-500">
                      <span className="font-semibold text-slate-900">{u.role}</span>
                      <span aria-hidden="true">·</span>
                      <span>{u.badgeCode}</span>
                    </div>
                    <div className="text-sm font-semibold text-slate-900 mt-0.5">{u.name}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{u.organization}</div>
                  </div>

                  <div className="shrink-0">
                    {isCurrent ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700">
                        <UserCheck className="w-4 h-4" />
                        Active
                      </span>
                    ) : (
                      <span className="text-xs font-medium text-slate-600 underline">Switch</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Register New Vehicle Form */}
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Register Emergency Vehicle Unit
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Onboard a new Ambulance or Fire Brigade transponder ID for Green Corridor priority
          </p>

          {feedback && (
            <div
              className={`mt-3 p-3 rounded-lg text-xs flex items-center gap-2 ${
                feedback.kind === 'ok'
                  ? 'bg-emerald-50 text-emerald-900 border border-emerald-200'
                  : 'bg-red-50 text-red-900 border border-red-200'
              }`}
            >
              {feedback.kind === 'ok' && <Check className="w-3.5 h-3.5 shrink-0" />}
              <span>{feedback.msg}</span>
            </div>
          )}

          <form onSubmit={handleCreateVehicle} className="mt-4 space-y-3.5">
            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setVehType('AMBULANCE');
                  setVehId('AMB-DL-305');
                  setAgencyName('AIIMS Trauma Response');
                }}
                className={`py-2 px-3 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  vehType === 'AMBULANCE'
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-300'
                }`}
              >
                Ambulance
              </button>
              <button
                type="button"
                onClick={() => {
                  setVehType('FIRE');
                  setVehId('FIRE-DL-212');
                  setAgencyName('Delhi Fire Service');
                }}
                className={`py-2 px-3 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  vehType === 'FIRE'
                    ? 'bg-red-600 text-white border-red-600'
                    : 'bg-white text-slate-700 border-slate-300'
                }`}
              >
                Fire Brigade
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Vehicle Transponder ID
                </label>
                <input
                  type="text"
                  required
                  value={vehId}
                  onChange={(e) => setVehId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Registration Plate
                </label>
                <input
                  type="text"
                  required
                  value={regNumber}
                  onChange={(e) => setRegNumber(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 font-mono text-xs text-slate-900"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Operating Agency
              </label>
              <input
                type="text"
                required
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Base Station
                </label>
                <input
                  type="text"
                  required
                  value={baseStation}
                  onChange={(e) => setBaseStation(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Radio Callsign
                </label>
                <input
                  type="text"
                  required
                  value={callsign}
                  onChange={(e) => setCallsign(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 px-4 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Vehicle to Authorized Registry</span>
            </button>
          </form>
        </div>
      </div>

      {/* Right 7 Columns: Registered Emergency Fleet Directory */}
      <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Authorized Priority Fleet Registry ({snapshot.vehicles.length} Units)
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Only cryptographically registered Ambulance and Fire transponders can request Green
              Corridor signal preemption
            </p>
          </div>
          <ShieldCheck className="w-5 h-5 text-slate-400 shrink-0" />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 bg-slate-50/70">
                <th className="py-2.5 px-4">Unit ID</th>
                <th className="py-2.5 px-4">Service Type</th>
                <th className="py-2.5 px-4">Agency &amp; Base</th>
                <th className="py-2.5 px-4">Plate Number</th>
                <th className="py-2.5 px-4 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {snapshot.vehicles.map((v) => {
                const active = snapshot.activeRuns.find((r) => r.vehicleId === v.id);
                return (
                  <tr key={v.id} className="hover:bg-slate-50/70">
                    <td className="py-3 px-4 font-mono font-semibold text-slate-900">
                      <div>{v.id}</div>
                      <div className="text-[11px] font-normal text-slate-500">{v.callsign}</div>
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-800">
                      <span className="inline-flex items-center gap-1.5">
                        <Truck className="w-3.5 h-3.5 text-slate-400" />
                        {v.type === 'FIRE' ? 'Fire Brigade' : 'Ambulance'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="text-slate-900 font-medium">{v.agencyName}</div>
                      <div className="text-[11px] text-slate-500">{v.baseStation}</div>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-600">{v.registrationNumber}</td>
                    <td className="py-3 px-4 text-right font-mono">
                      {active ? (
                        <span className="text-emerald-700 font-semibold">
                          On Run ({active.id})
                        </span>
                      ) : (
                        <span className="text-slate-500">Standby</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
