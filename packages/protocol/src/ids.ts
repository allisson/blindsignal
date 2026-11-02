import { z } from 'zod';

export const appId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

// `<app_id>:<scope>`; the scope is 1–128 visible ASCII characters, no spaces.
export const namespaceId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}:[\x21-\x7e]{1,128}$/);

export const userId = z.string().min(1).max(256);

export const deviceId = z.string().min(1).max(256);

export const sessionId = z.uuid();

export const requestId = z.string().min(1).max(64);
