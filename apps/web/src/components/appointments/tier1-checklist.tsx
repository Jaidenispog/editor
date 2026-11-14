'use client';

import { Check, CircleHelp, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button, buttonClasses } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { SquareStatusDto } from '@/lib/shared/square-dto';
import { SelfTestDialog } from './self-test-dialog';

function Mark({ mark }: { mark: 'ok' | 'missing' | 'unknown' }) {
  if (mark === 'ok') return <Check className="size-4 shrink-0 text-emerald-600" aria-label="Done" />;
  if (mark === 'missing') return <X className="size-4 shrink-0 text-red-600" aria-label="Not yet" />;
  return <CircleHelp className="size-4 shrink-0 text-charcoal-400" aria-label="Not checked yet" />;
}

const NOTIFY_WORDS = { yes: 'Yes', no: 'No', unknown: 'Not sure' } as const;

/**
 * "Booking changes from Studio Assistant" in Settings → Integrations → Square (design §4.5): the checklist with a
 * plain explanation per line, "Give permission" for the two booking-change permissions, the owner-approved
 * self-test and its progress, the question about Square's client messages, and the switch (on only once lines 1–4
 * are ticked; shows "Paused: …" when Square refused). While booking changes are not available in this version, the
 * checklist is shown read-only and nothing here can make a change.
 */
export function Tier1Checklist({ status, onChanged, reload }: { status: SquareStatusDto; onChanged: (s: SquareStatusDto) => void; reload: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const t = status.tier1;
  const st = status.selfTest;
  const running = st.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => void reload(), 3000);
    return () => clearTimeout(timer);
  }, [running, status, reload]);

  const patch = async (key: string, body: Record<string, unknown>, url = '/api/integrations/square', done?: string) => {
    setBusy(key);
    try {
      onChanged(await apiRequest<SquareStatusDto>(url, { method: url.endsWith('/notification') ? 'POST' : 'PATCH', body }));
      if (done) toast.success(done);
    } catch (e) {
      toast.error('That did not work', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h4 className="font-semibold text-charcoal-900">Booking changes from Studio Assistant</h4>
      <p className="mt-1 text-xs text-charcoal-500">{t.summary}</p>
      <ul className="mt-2 space-y-2">
        {t.lines.map((l) => (
          <li key={l.key} className="flex gap-2">
            <Mark mark={l.mark} />
            <span>
              <span className="font-medium text-charcoal-900">{l.label}.</span> {l.explanation}
            </span>
          </li>
        ))}
      </ul>

      {t.available && status.canManage ? (
        <div className="mt-3 space-y-3">
          {t.canGivePermission ? (
            <div className="flex flex-wrap items-center gap-3">
              <a href="/api/integrations/square/connect?access=write" className={buttonClasses('secondary', 'md', 'min-h-11')}>
                Give permission
              </a>
              <span className="text-xs text-charcoal-500">Square asks you to approve “change bookings” for Studio Assistant.</span>
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" className="min-h-11" disabled={!st.canRun} onClick={() => setTestOpen(true)}>
                Run self-test
              </Button>
              {st.status !== 'none' && st.current ? <StatusPill status={st.status === 'passed' ? 'ok' : st.status === 'failed' ? 'failed' : 'processing'} label={st.status === 'passed' ? 'Self-test passed' : st.status === 'failed' ? 'Self-test failed' : 'Self-test running'} /> : null}
              {st.atLabel && st.status !== 'running' ? <span className="text-xs text-charcoal-500">{st.atLabel}</span> : null}
            </div>
            {!st.canRun && st.runReason && !running ? <p className="text-xs text-charcoal-500">{st.runReason}</p> : null}
            {st.steps.length && (running || st.status === 'failed') ? (
              <ol className="space-y-1 text-xs" aria-live="polite">
                {st.steps.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2">
                    <StatusPill status={s.pill} label={s.statusLabel} />
                    <span>{s.kind === 'create' ? 'Booking' : s.kind === 'reschedule' ? 'Moving' : 'Cancelling'}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {st.failure ? <Alert tone="warning">{st.failure}</Alert> : null}
            {st.askNotification ? (
              <div className="rounded-[var(--radius-control)] bg-charcoal-50 p-3">
                <p>Did the client receive a confirmation from Square for the test booking?</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(['yes', 'no', 'unknown'] as const).map((a) => (
                    <Button key={a} size="sm" variant="secondary" className="min-h-11 sm:min-h-8" loading={busy === `notify-${a}`} onClick={() => void patch(`notify-${a}`, { answer: a }, '/api/integrations/square/self-test/notification', 'Thanks, noted')}>
                      {NOTIFY_WORDS[a]}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <Switch
            checked={t.switchOn}
            disabled={busy === 'switch' || (!t.switchOn && !t.canEnable)}
            onChange={(on) => void patch('switch', { writesEnabled: on }, '/api/integrations/square', on ? 'Booking changes switched on' : 'Booking changes switched off')}
            label="Allow booking changes from Studio Assistant"
            description={t.switchOn ? (t.ready ? 'On. Every change is checked with Square just before it is sent.' : t.summary) : (t.enableReason ?? 'Off.')}
          />
        </div>
      ) : null}
      <p className="mt-2 text-xs text-charcoal-500">Always in Square: marking no-shows, deposits, accepting or declining requests, and booking services with a no-show fee.</p>
      {t.available && status.canManage ? (
        <SelfTestDialog
          open={testOpen}
          status={status}
          onClose={() => setTestOpen(false)}
          onStarted={() => {
            toast.success('Self-test started');
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}
