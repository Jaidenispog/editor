/** Central place for storage key layout so the web app and worker never disagree. */
export const storageKeys = {
  assetOriginal: (projectId: string, assetId: string, ext: string) => `projects/${projectId}/assets/${assetId}/original.${ext}`,
  assetProxy: (projectId: string, assetId: string) => `projects/${projectId}/assets/${assetId}/proxy.mp4`,
  assetThumbnail: (projectId: string, assetId: string) => `projects/${projectId}/assets/${assetId}/thumb.jpg`,
  assetFrame: (projectId: string, assetId: string, timeMs: number) => `projects/${projectId}/assets/${assetId}/frames/${timeMs.toString().padStart(8, '0')}.jpg`,
  assetPrefix: (projectId: string, assetId: string) => `projects/${projectId}/assets/${assetId}`,
  editPreview: (projectId: string, editId: string, versionNo: number) => `projects/${projectId}/edits/${editId}/v${versionNo}/preview.mp4`,
  editExport: (projectId: string, editId: string, versionNo: number) => `projects/${projectId}/edits/${editId}/v${versionNo}/export.mp4`,
  editPrefix: (projectId: string, editId: string) => `projects/${projectId}/edits/${editId}`,
  projectPrefix: (projectId: string) => `projects/${projectId}`,
  musicOriginal: (trackId: string, ext: string) => `music/${trackId}/original.${ext}`,
  musicPrefix: (trackId: string) => `music/${trackId}`,
  brandLogo: (ext: string) => `brand/logo.${ext}`,
  publishCover: (postId: string) => `publishing/${postId}/cover.jpg`,
};

export function extensionForMime(mime: string, filename: string): string {
  const fromName = filename.toLowerCase().split('.').pop() ?? '';
  if (/^[a-z0-9]{1,5}$/.test(fromName) && fromName !== filename.toLowerCase()) return fromName;
  switch (mime) {
    case 'video/quicktime':
      return 'mov';
    case 'video/mp4':
      return 'mp4';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    default:
      return 'bin';
  }
}
