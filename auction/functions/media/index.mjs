// incoming/{owner}/{id} -> check the real type from the file's first bytes ->
// media/{owner}/{id}. Anything off the allowlist, or over its size cap, is
// deleted. The original in incoming/ is always removed.
//
// Phase 1 adds sharp (strip EXIF/GPS, WebP + AVIF at 320/800/1600) and
// ffmpeg (faststart remux, 720p cap, poster frame) as Lambda layers.
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const MB = 1024 * 1024;

const ascii = (b, start, end) => b.toString('latin1', start, end);
const isFtyp = (b, brands) => ascii(b, 4, 8) === 'ftyp' && brands.some((x) => ascii(b, 8, 12).startsWith(x));

// [content type, size cap, test on the first 16 bytes]. Order matters: the
// specific ftyp brands (AVIF, MOV) are checked before generic MP4.
const TYPES = [
  ['image/jpeg', 25 * MB, (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', 25 * MB, (b) => ascii(b, 1, 4) === 'PNG' && b[0] === 0x89],
  ['image/gif', 25 * MB, (b) => ascii(b, 0, 4) === 'GIF8'],
  ['image/webp', 25 * MB, (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP'],
  ['image/avif', 25 * MB, (b) => isFtyp(b, ['avif', 'avis'])],
  ['video/quicktime', 500 * MB, (b) => isFtyp(b, ['qt  '])],
  ['video/mp4', 500 * MB, (b) => isFtyp(b, ['iso', 'mp4', 'avc1', 'M4V'])],
  ['application/pdf', 50 * MB, (b) => ascii(b, 0, 5) === '%PDF-'],
  ['model/gltf-binary', 50 * MB, (b) => ascii(b, 0, 4) === 'glTF'],
];

const sniff = async (Bucket, Key) => {
  const head = await s3.send(new GetObjectCommand({ Bucket, Key, Range: 'bytes=0-15' }));
  return Buffer.from(await head.Body.transformToByteArray());
};

export const handler = async (event) => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    const size = record.s3.object.size;

    const bytes = size >= 16 ? await sniff(bucket, key) : Buffer.alloc(0);
    const type = bytes.length ? TYPES.find(([, , test]) => test(bytes)) : undefined;

    if (!type || size > type[1]) {
      console.warn(JSON.stringify({ msg: 'rejected', key, size, type: type?.[0] ?? 'unknown' }));
    } else {
      const [contentType] = type;
      const target = key.replace(/^incoming\//, 'media/');
      const inline = contentType.startsWith('image/') || contentType.startsWith('video/');
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        Key: target,
        CopySource: `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
        MetadataDirective: 'REPLACE',
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable',
        // Documents and 3D files download instead of rendering on our domain.
        ContentDisposition: inline ? undefined : 'attachment',
      }));
      console.log(JSON.stringify({ msg: 'accepted', key: target, size, type: contentType }));
    }

    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
};
