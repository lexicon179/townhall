/**
 * Images and video: uploaded to your own server, which stores them and serves them from
 * your domain under /media/. The cast carries the file's URL as an embed, like any link.
 *
 * Your server only takes a file from someone whose app key your node lists as active.
 * The browser proves it holds that key by signing
 *   sha256("townhall-upload:<fid>:<unix time>:<sha256 of the file>")
 * with it (Ed25519), the same key that signs your casts.
 */
import { signerOf, type Stored } from './keys';

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (data: BufferSource) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
export const isVideoUrl = (u: string) => /\.(mp4|mov|webm)(\?|$)/i.test(u);

export async function upload(k: Stored, file: File, onProgress?: (share: number) => void): Promise<{ url: string; kind: 'image' | 'video' }> {
  const body = await file.arrayBuffer();
  const ts = Math.floor(Date.now() / 1000);
  const fileHash = hex(await sha256(body));
  const digest = await sha256(new TextEncoder().encode(`townhall-upload:${k.fid}:${ts}:${fileHash}`));
  const sig = (await signerOf(k).signMessageHash(digest))._unsafeUnwrap();

  // XMLHttpRequest rather than fetch: it reports upload progress, which matters for video.
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/upload');
    x.setRequestHeader('content-type', 'application/octet-stream');
    x.setRequestHeader('x-fid', String(k.fid));
    x.setRequestHeader('x-key', k.pub);
    x.setRequestHeader('x-ts', String(ts));
    x.setRequestHeader('x-sig', '0x' + hex(sig));
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let b: any = {};
      try { b = JSON.parse(x.responseText); } catch { /* not JSON: a proxy error page */ }
      if (x.status === 200 && b.url) resolve(b);
      else reject(new Error(b.error || (x.status === 404 || x.status === 502 ? 'Uploads need the latest step 2 on your server.' : `Upload failed (${x.status})`)));
    };
    x.onerror = () => reject(new Error('Upload failed: your server did not answer.'));
    x.send(body);
  });
}
