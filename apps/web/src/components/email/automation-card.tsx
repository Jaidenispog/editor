'use client';

import { useState } from 'react';
import { formatDateTime } from '@studio/core';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { apiRequest } from '@/lib/client/api-client';
import type { AutomationDto, EmailTemplateDto } from './types';

/**
 * One automation (design §4.3): off by default; "Ask me to approve each one" by default; template, delay and daily
 * limit. Switching to automatic sending needs a confirmation. Turning it on only covers appointments completed after
 * that moment.
 */
export function AutomationCard({
  name,
  title,
  description,
  rule,
  initial,
  templates,
  blockedReason,
}: {
  name: 'follow_up' | 'review_request';
  title: string;
  description: string;
  rule: string;
  initial: AutomationDto;
  templates: EmailTemplateDto[];
  blockedReason: string | null;
}) {
  const toast = useToast();
  const [a, setA] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);
  const usable = templates.filter((t) => t.enabled && (name === 'review_request' ? t.messageClass === 'review_request' : t.messageClass !== 'review_request'));
  const save = async (next: AutomationDto) => {
    if (next.mode === 'send_automatically' && saved.mode !== 'send_automatically' && !window.confirm("Emails will go out without you looking at each one. You can switch this off any time.")) return;
    setBusy(true);
    try {
      const r = await apiRequest<{ automation: AutomationDto }>(`/api/email/automations/${name}`, { method: 'PUT', body: { enabled: next.enabled, mode: next.mode, templateId: next.templateId, delayHours: next.delayHours, dailyCap: next.dailyCap } });
      setA(r.automation);
      setSaved(r.automation);
      toast.success(r.automation.enabled ? 'Automation saved' : 'Automation is off');
    } catch (e) {
      toast.error('Not saved', (e as Error).message);
      setA(saved);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody className="space-y-4">
        <p className="text-sm text-charcoal-700">{rule}</p>
        {blockedReason ? <Alert tone="warning">{blockedReason}</Alert> : null}
        <Switch
          checked={a.enabled}
          disabled={busy || (Boolean(blockedReason) && !a.enabled)}
          label={a.enabled ? 'On' : 'Off'}
          description={a.enabled && a.enabledAt ? `Only appointments completed after ${formatDateTime(a.enabledAt)} are considered.` : 'When on, only appointments completed after this moment are considered.'}
          onChange={(v) => void save({ ...a, enabled: v })}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Mode"
            value={a.mode}
            options={[
              { value: 'approve_each', label: 'Ask me to approve each one' },
              { value: 'send_automatically', label: 'Send automatically' },
            ]}
            onChange={(e) => setA({ ...a, mode: e.target.value as AutomationDto['mode'] })}
          />
          <Select label="Template" value={a.templateId ?? ''} options={[{ value: '', label: 'Built-in template' }, ...usable.map((t) => ({ value: t.id, label: t.name }))]} onChange={(e) => setA({ ...a, templateId: e.target.value || null })} />
          <Input label="Hours after the appointment" type="number" min={1} max={72} value={a.delayHours} onChange={(e) => setA({ ...a, delayHours: Math.max(1, Math.min(72, Number(e.target.value) || 1)) })} />
          <Input label="Daily limit" type="number" min={1} max={100} value={a.dailyCap} onChange={(e) => setA({ ...a, dailyCap: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
        </div>
        <Button className="min-h-11" variant="secondary" loading={busy} disabled={JSON.stringify(a) === JSON.stringify(saved)} onClick={() => void save(a)}>
          Save
        </Button>
      </CardBody>
    </Card>
  );
}
