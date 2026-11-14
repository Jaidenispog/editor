import type {
  ManualStep,
  MediaVariant,
  PlatformEligibility,
  PostMode,
  PostStatus,
  PublishMethod,
  TargetAction,
  TargetPlatform,
  TargetStatus,
} from '@studio/core';

/** Browser-facing shapes of the publishing module (no secrets, no storage keys; links expire). */

/** One way to deliver a video to a platform, as the composer offers it. */
export interface MethodOption {
  method: PublishMethod;
  delivery?: 'publish' | 'draft';
  available: boolean;
  /** Why it is greyed out. */
  reason?: string;
  /** The first live post for this method (the owner confirms they can see it afterwards). */
  isVerification: boolean;
  accountId?: string;
  /** "@studio" or a plain description when no handle is saved. */
  handle: string;
}

/** A version as the composer sees it. */
export interface EligibilityItemDto {
  versionId: string;
  projectId: string;
  projectTitle: string;
  styleName: string;
  versionNo: number;
  previewUrl: string | null;
  durationSec: number;
  exportStatus: string;
  noMusicExportStatus: string;
  defaultCoverTimeSec: number;
  /** The locked credit line appended to every caption (CC BY), or null. */
  captionSuffix: string | null;
  hasMusic: boolean;
  eligibility: PlatformEligibility[];
  notes: string[];
  methods: Record<TargetPlatform, MethodOption[]>;
  priorTargets: Array<{ platform: TargetPlatform; status: TargetStatus; publishedAt: string | null }>;
}

/** Result of GET /api/publishing/eligibility. */
export interface EligibilityDto {
  items: EligibilityItemDto[];
  quota: { instagram?: { usage: number; total: number | null; checkedAt: string | null } };
  captionFooter: string;
  /** Whether the signed-in user may approve (the owner). */
  canApprove: boolean;
}

/** One destination of a post. */
export interface TargetDto {
  id: string;
  platform: TargetPlatform;
  method: PublishMethod;
  delivery: 'publish' | 'draft';
  handle: string;
  variant: MediaVariant;
  status: TargetStatus;
  manualStep: ManualStep | null;
  statusMessage: string;
  publishedUrl: string | null;
  publishedAt: string | null;
  confirmedByName: string | null;
  attempts: number;
  isVerification: boolean;
  accountId: string | null;
  /** The verification post is published and waits for the owner's "Can you see it?" answer. */
  awaitingVerificationAnswer: boolean;
  actions: TargetAction[];
}

/** One post (one video, one compose action). */
export interface PublishPostDto {
  id: string;
  versionId: string;
  projectId: string | null;
  projectTitle: string;
  styleName: string;
  versionNo: number | null;
  previewThumbUrl: string | null;
  caption: string;
  coverUrl: string | null;
  coverTimeSec: number | null;
  mode: PostMode;
  scheduledFor: string | null;
  scheduledForLabel: string | null;
  status: PostStatus;
  statusMessage: string;
  approvedAt: string | null;
  createdAt: string;
  targets: TargetDto[];
}

/** GET /api/publish-posts. */
export interface PublishPostListDto {
  posts: PublishPostDto[];
  nextCursor: string | null;
}

/** GET /api/publish-targets/[id]/media. */
export interface TargetMediaDto {
  videoUrl: string;
  videoFilename: string;
  byteSize: number | null;
  coverUrl: string | null;
  caption: string;
  label: string | null;
}

/** One discovered Instagram account in Settings. */
export interface SocialAccountDto {
  id: string;
  platform: TargetPlatform;
  username: string;
  status: string;
  verified: boolean;
  verifiedAt: string | null;
  directPublishEnabled: boolean;
  quotaUsage: number | null;
  quotaTotal: number | null;
  quotaCheckedAt: string | null;
  lastError: string | null;
}

/** GET /api/publishing/connections: the publishing connections for Settings and the Publishing page. */
export interface PublishingConnectionsDto {
  canManage: boolean;
  instagram: {
    /** Server settings present (META_APP_ID, META_APP_SECRET, META_LOGIN_CONFIG_ID). */
    configured: boolean;
    missingEnv: string[];
    connectionStatus: 'none' | 'connected' | 'needs_reauth' | 'error' | 'disconnected' | 'not_configured';
    lastError: string | null;
    lastCheckedAt: string | null;
    /** Null = the token does not expire; undefined = not checked yet. */
    tokenExpiresAt: string | null | undefined;
    tokenExpiringSoon: boolean;
    graphVersion: string;
    discoveryEmpty: boolean;
    accounts: SocialAccountDto[];
  };
  handles: { instagram: string; tiktok: string };
  captionFooter: string;
}

/** Small per-platform badges for Studio and Library cards. */
export interface PublishBadgeDto {
  versionId: string;
  platform: TargetPlatform;
  status: TargetStatus;
  label: string;
}

/** A version the composer's picker can add (nothing is preselected). */
export interface CandidateVersionDto {
  versionId: string;
  projectTitle: string;
  styleName: string;
  versionNo: number;
  durationSec: number | null;
  updatedAt: string;
}
