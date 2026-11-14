'use client';

import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/field';
import { StatusPill } from '@/components/ui/status-pill';
import { useToast } from '@/components/ui/toast';
import { apiRequest, fieldErrors } from '@/lib/client/api-client';
import { projectStatusPill } from '@/lib/shared/project-status';
import type { StudioStatusDto } from '@/lib/shared/studio-dto';

/** Project title, client name and status, with "Edit details" and a permanent "Delete project". */
export function ProjectHeader({ project, onChanged }: { project: StudioStatusDto['project']; onChanged: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [clientName, setClientName] = useState(project.clientName);
  const [notes, setNotes] = useState(project.notes);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  const openEdit = () => {
    setTitle(project.title);
    setClientName(project.clientName);
    setNotes(project.notes);
    setErrors({});
    setEditOpen(true);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      await apiRequest(`/api/projects/${project.id}`, { method: 'PATCH', body: { title, clientName, notes } });
      toast.success('Project details saved');
      setEditOpen(false);
      onChanged();
      router.refresh();
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      if (Object.keys(fe).length === 0) toast.error('Could not save the details', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await apiRequest(`/api/projects/${project.id}`, { method: 'DELETE' });
      toast.success('Project deleted', 'Its clips and edits have been permanently removed.');
      router.push('/studio');
      router.refresh();
    } catch (err) {
      toast.error('Could not delete the project', err instanceof Error ? err.message : undefined);
      setDeleting(false);
    }
  };

  const confirmed = confirmText.trim().toLowerCase() === 'delete';
  const pill = projectStatusPill(project.status);

  return (
    <header className="mb-6">
      <Link href="/studio" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-charcoal-600 hover:text-charcoal-950">
        <ArrowLeft className="size-4" aria-hidden="true" /> All projects
      </Link>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-charcoal-500 uppercase">Video Studio</p>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-charcoal-950 sm:text-3xl">{project.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-charcoal-600">
            {project.clientName ? <span>Client: {project.clientName}</span> : null}
            <StatusPill status={pill.status} label={pill.label} />
          </div>
          {project.notes ? <p className="mt-2 max-w-2xl text-sm whitespace-pre-line text-charcoal-600">{project.notes}</p> : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" onClick={openEdit}>
            <Pencil className="size-4" aria-hidden="true" /> Edit details
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConfirmText('');
              setDeleteOpen(true);
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" /> Delete
          </Button>
        </div>
      </div>

      <Dialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit project details"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" form="edit-project-form" loading={saving}>
              Save
            </Button>
          </>
        }
      >
        <form id="edit-project-form" onSubmit={save} className="space-y-4" noValidate>
          <Input label="Project name" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} error={errors['title'] ?? null} />
          <Input label="Client name (optional)" value={clientName} onChange={(e) => setClientName(e.target.value)} maxLength={120} error={errors['clientName'] ?? null} />
          <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={2000} error={errors['notes'] ?? null} />
        </form>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete this project permanently?"
        description="Every clip, edit, preview and exported video in this project will be deleted from storage. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Keep project
            </Button>
            <Button variant="danger" onClick={remove} disabled={!confirmed} loading={deleting}>
              Delete permanently
            </Button>
          </>
        }
      >
        <Input label='Type "delete" to confirm' value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
      </Dialog>
    </header>
  );
}
