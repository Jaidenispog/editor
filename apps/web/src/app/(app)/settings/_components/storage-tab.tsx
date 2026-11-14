import { HardDrive } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { formatBytes } from '@/lib/format';
import type { StorageUsage } from '@/lib/storage-usage';

/** Storage facts passed from the server page. */
export interface StorageInfo {
  driver: 'local' | 's3';
  usage: StorageUsage;
  linkTtlMinutes: number;
  maxUploadBytes: number;
}

/** Storage & data: where files live, how much space projects use and how temporary files are cleaned up. */
export function StorageTab({ storage }: { storage: StorageInfo }) {
  const { usage } = storage;
  const stats = [
    { label: 'Original clips', value: usage.originalsBytes },
    { label: 'Full-quality exports', value: usage.exportsBytes },
    { label: 'Music', value: usage.musicBytes },
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader title="Space used" description="From the sizes recorded for each file. Previews, thumbnails and proxies add roughly 10–20% on top." />
        <CardBody>
          <p className="text-3xl font-semibold tabular-nums">{formatBytes(usage.totalBytes)}</p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            {stats.map((s) => (
              <div key={s.label} className="rounded-lg bg-charcoal-50 px-4 py-3">
                <dt className="text-xs text-charcoal-500">{s.label}</dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums">{formatBytes(s.value)}</dd>
              </div>
            ))}
          </dl>
          {usage.projects.length ? (
            <div className="-mx-5 mt-6 overflow-x-auto sm:-mx-6">
              <table className="w-full min-w-[480px] text-left text-sm">
                <caption className="sr-only">Space used by each project</caption>
                <thead className="border-b border-charcoal-100 text-xs font-medium text-charcoal-500">
                  <tr>
                    <th scope="col" className="px-5 py-2 sm:px-6">Project</th>
                    <th scope="col" className="px-3 py-2 text-right">Clips</th>
                    <th scope="col" className="px-3 py-2 text-right">Originals</th>
                    <th scope="col" className="px-5 py-2 text-right sm:px-6">Exports</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-charcoal-100">
                  {usage.projects.map((p) => (
                    <tr key={p.id}>
                      <td className="max-w-xs truncate px-5 py-2.5 sm:px-6">{p.title}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{p.clipCount}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatBytes(p.originalsBytes)}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums sm:px-6">{formatBytes(p.exportsBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-6 text-sm text-charcoal-500">No projects yet.</p>
          )}
        </CardBody>
      </Card>
      <div className="space-y-6">
        <Card>
          <CardHeader title="Where files are kept" />
          <CardBody className="space-y-3 text-sm text-charcoal-700">
            <p className="flex items-center gap-2 font-medium text-charcoal-900">
              <HardDrive className="size-4 text-charcoal-500" aria-hidden="true" />
              {storage.driver === 's3' ? 'Private cloud bucket (S3-compatible)' : 'This server’s disk'}
            </p>
            <p>Files are private. Browsers only get links that expire after {storage.linkTtlMinutes} minutes.</p>
            <p>Largest single upload: {formatBytes(storage.maxUploadBytes)}.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Temporary files" />
          <CardBody className="space-y-3 text-sm text-charcoal-700">
            <p>While analysing and rendering, the worker writes working files to its own temporary folder. Each job removes its files when it finishes, even if it fails.</p>
            <p>Anything left behind by an interrupted job is deleted automatically by an hourly clean-up once it is more than a day old, so you never need to delete temporary files by hand.</p>
            <p>Deleting a project removes its clips, previews and exports permanently.</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
