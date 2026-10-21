import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DESKTOP_CHANNELS = new Set([
  'ludoready:bootstrap', 'ludoready:runtime:refresh', 'ludoready:runtime:login', 'ludoready:runtime:logout',
  'ludoready:dialog:directory', 'ludoready:dialog:project-directory',
  'ludoready:project:create', 'ludoready:project:rename', 'ludoready:project:pin', 'ludoready:project:delete',
  'ludoready:project:run', 'ludoready:project:stop', 'ludoready:project:reveal', 'ludoready:project:assets:import',
  'ludoready:project:assets:import-paths', 'ludoready:project:asset-plan:retry', 'ludoready:project:inspect',
  'ludoready:project:experience:evaluate', 'ludoready:project:experience:cancel', 'ludoready:project:read',
  'ludoready:project:icon', 'ludoready:project:ludoready-pack:save', 'ludoready:project:ludoready-crew:save',
  'ludoready:settings:save', 'ludoready:environment:get', 'ludoready:environment:refresh',
  'ludoready:environment:godot:choose', 'ludoready:environment:godot:save', 'ludoready:extensions:get',
  'ludoready:media-provider:save', 'ludoready:media-provider:test', 'ludoready:skills:list',
  'ludoready:skills:set-enabled', 'ludoready:mcp:list', 'ludoready:mcp:save', 'ludoready:mcp:remove',
  'ludoready:prompts:list', 'ludoready:prompts:save', 'ludoready:prompts:reset', 'ludoready:approval:resolve',
]);
export const DESKTOP_EVENTS = new Set([
  'ludoready:event:agent', 'ludoready:event:project', 'ludoready:event:runtime', 'ludoready:event:approval',
  'ludoready:event:approval-closed', 'ludoready:event:assets', 'ludoready:event:asset-plans',
]);
export const OWNER_COOKIE = '__Host-ludoready-desktop';
export const MAX_RELAY_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export type RelayKind = 'rpc' | 'preview' | 'upload' | 'download';
export interface RelayRequest { id: string; kind: RelayKind; channel: string; args: unknown[] }
export interface RelayEvent { id: number; channel: string; payload: unknown }

export function secretEqual(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length < 32) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function signature(value: string, secret: string): string { return createHmac('sha256', secret).update(value).digest('base64url'); }
export function createOwnerSession(secret: string, now = Date.now()): string {
  const value = `${now + 24 * 60 * 60 * 1000}.${randomBytes(24).toString('base64url')}`;
  return `${value}.${signature(`owner:${value}`, secret)}`;
}
export function validOwnerSession(cookies: string | null, secret: string, now = Date.now()): boolean {
  const value = cookies?.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${OWNER_COOKIE}=`))?.slice(OWNER_COOKIE.length + 1);
  if (!value) return false;
  const pieces = value.split('.');
  if (pieces.length !== 3 || !/^\d{13}$/u.test(pieces[0]!) || !/^[A-Za-z0-9_-]{32}$/u.test(pieces[1]!) || !/^[A-Za-z0-9_-]{43}$/u.test(pieces[2]!)) return false;
  const expires = Number(pieces[0]);
  return expires > now && expires <= now + 24 * 60 * 60 * 1000 && secretEqual(pieces[2], signature(`owner:${pieces[0]}.${pieces[1]}`, secret));
}
export function previewCapability(projectId: string, secret: string): string { return signature(`preview:${projectId}`, secret); }
export function publicOriginProof(origin: string, secret: string): string { return signature(`origin:${origin}`, secret); }
export function safePreviewPath(value: string): string | null {
  let path: string;
  try { path = decodeURIComponent(value || 'index.html'); } catch { return null; }
  return path.includes('\0') || path.includes('\\') || path.startsWith('/') || path.split('/').some((v) => v === '..' || v === '.') ? null : path;
}
