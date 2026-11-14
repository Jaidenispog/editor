'use client';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import type { WebsiteEditDto } from './types';

/** Copy-paste steps for making a change by hand (generic; builder menu paths are not invented). Shown as plain text. */
export function InstructionsDialog({ edit, open, onClose }: { edit: WebsiteEditDto; open: boolean; onClose: () => void }) {
  const toast = useToast();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Steps to make this change"
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" className="min-h-11" onClick={onClose}>
            Close
          </Button>
          <Button
            className="min-h-11"
            onClick={() => {
              void navigator.clipboard?.writeText(edit.instructions.text).then(
                () => toast.success('Steps copied'),
                () => toast.error('Could not copy'),
              );
            }}
          >
            Copy
          </Button>
        </>
      }
    >
      <pre className="max-w-full overflow-x-auto rounded-md bg-charcoal-50 p-3 text-xs whitespace-pre-wrap text-charcoal-800 [overflow-wrap:anywhere]">
        {edit.instructions.text}
      </pre>
    </Dialog>
  );
}
