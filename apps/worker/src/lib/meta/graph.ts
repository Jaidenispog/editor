import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { testOnlyBaseUrl, type Env } from '@studio/config';
import type { WorkerContext } from '../../context.js';
import { httpRequest, readJson } from '../http.js';

/**
 * Meta Graph API client for Instagram publishing (Unified Login, system-user token; memo §4). Only the calls the
 * publishing design lists are here. Every call sends `appsecret_proof` (standard Graph hardening; if Meta refuses it,
 * the read-only check reports that). Tokens never leave this module except in the request itself, and the HTTP
 * helper redacts `access_token`, `appsecret_proof` and `input_token` from logs. The hashtag watch (WP5) reuses this
 * client and {@link GraphApiError}.
 */

/** Default Graph host; a local fake server replaces it only when NODE_ENV=test. */
export const GRAPH_HOST = 'https://graph.facebook.com';
/** Resumable upload host (memo §4: binary upload, so no public video URL exists). */
export const RUPLOAD_HOST = 'https://rupload.facebook.com';
/** Uploads stream a whole export; they get a longer time limit than ordinary calls. */
export const UPLOAD_TIMEOUT_MS = 15 * 60_000;

/** An error answer from the Graph API, with Meta's own code, subcode and messages kept for the owner. */
export class GraphApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | null,
    readonly subcode: number | null,
    message: string,
    readonly userMessage: string | null,
  ) {
    super(message);
    this.name = 'GraphApiError';
  }
}

/** The settings the client needs (the app secret stays on the server). */
export type GraphEnv = Pick<Env, 'NODE_ENV' | 'META_APP_ID' | 'META_APP_SECRET' | 'META_GRAPH_VERSION' | 'META_GRAPH_BASE_URL' | 'META_RUPLOAD_BASE_URL'>;

/** `HMAC_SHA256(app_secret, access_token)` as hex. */
export function appSecretProof(appSecret: string, accessToken: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/** Status of an Instagram media container (memo §4: EXPIRED, ERROR, FINISHED, IN_PROGRESS or PUBLISHED). */
export interface ContainerStatus {
  statusCode: string;
  status: string;
}

/** `copyright_check_status` of an unpublished container. */
export interface CopyrightStatus {
  status: string;
  matchesFound: boolean | null;
}

/** `debug_token` facts used by the read-only check. */
export interface TokenFacts {
  isValid: boolean;
  type: string | null;
  scopes: string[];
  /** 0 or null = never expires. Unix seconds otherwise. */
  expiresAt: number | null;
  /** `granular_scopes[].target_ids` for `instagram_content_publish`. */
  contentPublishTargets: string[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

/** A client bound to one token, one run's AbortSignal and the configured Graph version. */
export class MetaGraphClient {
  private readonly graphBase: string;
  private readonly ruploadBase: string;
  readonly version: string;

  constructor(
    private readonly ctx: Pick<WorkerContext, 'fetch' | 'logger'>,
    private readonly env: GraphEnv,
    private readonly token: string,
    private readonly signal?: AbortSignal,
  ) {
    this.graphBase = testOnlyBaseUrl(env, env.META_GRAPH_BASE_URL) ?? GRAPH_HOST;
    this.ruploadBase = testOnlyBaseUrl(env, env.META_RUPLOAD_BASE_URL) ?? RUPLOAD_HOST;
    this.version = env.META_GRAPH_VERSION;
  }

  private proof(token: string): Record<string, string> {
    return this.env.META_APP_SECRET ? { appsecret_proof: appSecretProof(this.env.META_APP_SECRET, token) } : {};
  }

  private async handle(res: Response, label: string): Promise<Record<string, unknown>> {
    const body = (await readJson(res)) as Record<string, unknown> | null;
    if (res.ok && body && !body['error']) return body;
    const err = (body?.['error'] ?? {}) as Record<string, unknown>;
    const code = typeof err['code'] === 'number' ? err['code'] : null;
    const subcode = typeof err['error_subcode'] === 'number' ? err['error_subcode'] : null;
    const message = (str(err['message']) ?? `${label} answered with HTTP ${res.status}`).slice(0, 500);
    const userMessage = str(err['error_user_msg'])?.slice(0, 500) ?? null;
    throw new GraphApiError(res.status, code, subcode, message, userMessage);
  }

  private async get(path: string, params: Record<string, string>, label: string, token = this.token, withProof = true): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ ...params, access_token: token, ...(withProof ? this.proof(token) : {}) });
    const res = await httpRequest(this.ctx, `${this.graphBase}/${this.version}/${path}?${q.toString()}`, { method: 'GET' }, { label, signal: this.signal });
    return this.handle(res, label);
  }

  private async post(path: string, form: Record<string, string>, label: string): Promise<Record<string, unknown>> {
    const body = new URLSearchParams({ ...form, access_token: this.token, ...this.proof(this.token) });
    const res = await httpRequest(
      this.ctx,
      `${this.graphBase}/${this.version}/${path}`,
      { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      { label, signal: this.signal },
    );
    return this.handle(res, label);
  }

  /** Inspects the stored token with the app token (`APP_ID|APP_SECRET`). */
  async debugToken(): Promise<TokenFacts> {
    const appToken = `${this.env.META_APP_ID ?? ''}|${this.env.META_APP_SECRET ?? ''}`;
    const body = await this.get('debug_token', { input_token: this.token }, 'meta.debug_token', appToken, false);
    const data = (body['data'] ?? {}) as Record<string, unknown>;
    const scopes = Array.isArray(data['scopes']) ? data['scopes'].filter((s): s is string => typeof s === 'string') : [];
    const granular = Array.isArray(data['granular_scopes']) ? (data['granular_scopes'] as Array<Record<string, unknown>>) : [];
    const publish = granular.find((g) => g['scope'] === 'instagram_content_publish');
    const targets = Array.isArray(publish?.['target_ids']) ? (publish['target_ids'] as unknown[]).map(str).filter((s): s is string => Boolean(s)) : [];
    const expires = typeof data['expires_at'] === 'number' ? data['expires_at'] : null;
    return { isValid: data['is_valid'] === true, type: str(data['type']), scopes, expiresAt: expires, contentPublishTargets: targets };
  }

  /** `GET /me/assigned_instagram_accounts` (discovery step 1). */
  async assignedInstagramAccounts(): Promise<Array<{ id: string; username: string }>> {
    const body = await this.get('me/assigned_instagram_accounts', { fields: 'id,username' }, 'meta.assigned_accounts');
    const data = Array.isArray(body['data']) ? (body['data'] as Array<Record<string, unknown>>) : [];
    return data.map((d) => ({ id: str(d['id']) ?? '', username: str(d['username']) ?? '' })).filter((d) => d.id);
  }

  /** `GET /{id}?fields=id,username`. */
  async instagramUser(id: string): Promise<{ id: string; username: string }> {
    const body = await this.get(encodeURIComponent(id), { fields: 'id,username' }, 'meta.ig_user');
    return { id: str(body['id']) ?? id, username: str(body['username']) ?? '' };
  }

  /** `GET /{ig-id}/content_publishing_limit?fields=quota_usage,config`. */
  async publishingLimit(igId: string): Promise<{ usage: number; total: number | null }> {
    const body = await this.get(`${encodeURIComponent(igId)}/content_publishing_limit`, { fields: 'quota_usage,config' }, 'meta.publishing_limit');
    const row = (Array.isArray(body['data']) ? (body['data'][0] as Record<string, unknown> | undefined) : undefined) ?? body;
    const usage = typeof row['quota_usage'] === 'number' ? row['quota_usage'] : 0;
    const config = (row['config'] ?? {}) as Record<string, unknown>;
    return { usage, total: typeof config['quota_total'] === 'number' ? config['quota_total'] : null };
  }

  /** `POST /{ig-id}/media` with `media_type=REELS&upload_type=resumable` → the container id. */
  async createReelContainer(igId: string, input: { caption: string; thumbOffsetMs: number | null }): Promise<string> {
    const form: Record<string, string> = { media_type: 'REELS', upload_type: 'resumable', caption: input.caption };
    if (input.thumbOffsetMs !== null) form['thumb_offset'] = String(Math.max(0, Math.round(input.thumbOffsetMs)));
    const body = await this.post(`${encodeURIComponent(igId)}/media`, form, 'meta.create_container');
    const id = str(body['id']);
    if (!id) throw new GraphApiError(200, null, null, 'Instagram did not return a container id', null);
    return id;
  }

  /** Streams the file to `rupload.facebook.com/ig-api-upload/{v}/{container-id}` from offset 0. */
  async uploadResumable(containerId: string, file: Readable, byteSize: number): Promise<void> {
    const res = await httpRequest(
      this.ctx,
      `${this.ruploadBase}/ig-api-upload/${this.version}/${encodeURIComponent(containerId)}`,
      {
        method: 'POST',
        headers: { authorization: `OAuth ${this.token}`, offset: '0', file_size: String(byteSize), 'content-type': 'application/octet-stream' },
        body: Readable.toWeb(file) as ReadableStream<Uint8Array>,
        duplex: 'half',
      } as RequestInit,
      { label: 'meta.rupload', signal: this.signal, timeoutMs: UPLOAD_TIMEOUT_MS },
    );
    const body = await this.handle(res, 'meta.rupload');
    if (body['success'] === false) throw new GraphApiError(res.status, null, null, str(body['message']) ?? 'Instagram did not accept the upload', null);
  }

  /** `GET /{container-id}?fields=status_code,status`. */
  async containerStatus(containerId: string): Promise<ContainerStatus> {
    const body = await this.get(encodeURIComponent(containerId), { fields: 'status_code,status' }, 'meta.container_status');
    return { statusCode: str(body['status_code']) ?? 'UNKNOWN', status: str(body['status']) ?? '' };
  }

  /** `GET /{container-id}?fields=copyright_check_status`. */
  async copyrightStatus(containerId: string): Promise<CopyrightStatus> {
    const body = await this.get(encodeURIComponent(containerId), { fields: 'copyright_check_status' }, 'meta.copyright_status');
    const c = (body['copyright_check_status'] ?? {}) as Record<string, unknown>;
    return { status: str(c['status']) ?? 'unknown', matchesFound: typeof c['matches_found'] === 'boolean' ? c['matches_found'] : null };
  }

  /** `POST /{ig-id}/media_publish` with `creation_id` → the published media id. The one non-repeatable call. */
  async publishContainer(igId: string, containerId: string): Promise<string> {
    const body = await this.post(`${encodeURIComponent(igId)}/media_publish`, { creation_id: containerId }, 'meta.media_publish');
    const id = str(body['id']);
    if (!id) throw new GraphApiError(200, null, null, 'Instagram did not return the published media id', null);
    return id;
  }

  /** `GET /{media-id}?fields=permalink`. */
  async permalink(mediaId: string): Promise<string | null> {
    const body = await this.get(encodeURIComponent(mediaId), { fields: 'permalink' }, 'meta.permalink');
    return str(body['permalink']);
  }

  /** `GET /{ig-id}/media?fields=id,permalink,timestamp,caption&limit=5` (crash recovery only). */
  async recentMedia(igId: string): Promise<Array<{ id: string; permalink: string | null; timestamp: string | null; caption: string | null }>> {
    const body = await this.get(`${encodeURIComponent(igId)}/media`, { fields: 'id,permalink,timestamp,caption', limit: '5' }, 'meta.recent_media');
    const data = Array.isArray(body['data']) ? (body['data'] as Array<Record<string, unknown>>) : [];
    return data.map((d) => ({ id: str(d['id']) ?? '', permalink: str(d['permalink']), timestamp: str(d['timestamp']), caption: str(d['caption']) })).filter((d) => d.id);
  }
}
