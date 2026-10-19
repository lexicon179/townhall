// @farcaster/core uses Node's Buffer in a few validators (e.g. link types). Browsers don't have it.
import { Buffer } from 'buffer';
(globalThis as any).Buffer ??= Buffer;
