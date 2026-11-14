'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, type ButtonVariant } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { apiRequest, fieldErrors } from '@/lib/client/api-client';

/** "New project" button + dialog. Creates the project (POST /api/projects) and opens it in the Video Studio. */
export function NewProjectButton({ variant = 'primary', label = 'New project' }: { variant?: ButtonVariant; label?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [clientName, setClientName] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const reset = () => {
    setTitle('');
    setClientName('');
    setNotes('');
    setErrors({});
    setFormError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const res = await apiRequest<{ project: { id: string } }>('/api/projects', { method: 'POST', body: { title, clientName, notes } });
      toast.success('Project created');
      setOpen(false);
      reset();
      router.push(`/studio/${res.project.id}`);
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      if (Object.keys(fe).length === 0) setFormError(err instanceof Error ? err.message : 'The project could not be created.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden="true" />
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New project"
        description="A project holds the clips from one haircut and the edits made from them."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" form="new-project-form" loading={saving}>
              Create project
            </Button>
          </>
        }
      >
        <form id="new-project-form" onSubmit={submit} className="space-y-4" noValidate>
          <Input label="Project name" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Skin fade with textured top" required maxLength={120} autoFocus error={errors['title'] ?? null} />
          <Input label="Client name (optional)" value={clientName} onChange={(e) => setClientName(e.target.value)} maxLength={120} hint="Only shown inside the app." error={errors['clientName'] ?? null} />
          <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={2000} hint="Anything the edits should keep in mind, such as the style of the cut." error={errors['notes'] ?? null} />
          {formError ? (
            <p role="alert" className="text-sm text-red-600">
              {formError}
            </p>
          ) : null}
        </form>
      </Dialog>
    </>
  );
}
