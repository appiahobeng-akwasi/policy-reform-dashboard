// File storage through the S3 API, so any S3-compatible store works: Supabase Storage today,
// MinIO or AWS later, by changing environment variables only (CLAUDE.md: hosting not decided).
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env';

let client: S3Client | undefined;
let publicClient: S3Client | undefined;

export function s3ClientConfig(endpoint = env.s3.endpoint): S3ClientConfig {
  const { region, accessKeyId, secretAccessKey, forcePathStyle } = env.s3;
  return { endpoint, region, forcePathStyle, credentials: { accessKeyId, secretAccessKey } };
}

function s3(): S3Client {
  client ??= new S3Client(s3ClientConfig());
  return client;
}

export const storage = {
  get bucket(): string {
    return env.s3.bucket;
  },

  async ensureBucket(): Promise<'exists' | 'created'> {
    try {
      await s3().send(new HeadBucketCommand({ Bucket: this.bucket }));
      return 'exists';
    } catch {
      await s3().send(new CreateBucketCommand({ Bucket: this.bucket }));
      return 'created';
    }
  },

  /** Every object key and size in the bucket (for backups), page by page. */
  async list(): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const page = await s3().send(new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: token }));
      for (const o of page.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  },

  /** True if the bucket answers (for the health check). */
  async reachable(): Promise<boolean> {
    try {
      await s3().send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal: AbortSignal.timeout(3000) });
      return true;
    } catch {
      return false;
    }
  },

  async exists(key: string): Promise<boolean> {
    try {
      await s3().send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  },

  /** Reads a whole object, refusing anything larger than maxBytes. */
  async read(key: string, maxBytes: number): Promise<Uint8Array> {
    const head = await s3().send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    if ((head.ContentLength ?? 0) > maxBytes) throw new RangeError(`Object ${key} is larger than ${maxBytes} bytes`);
    const object = await s3().send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return object.Body!.transformToByteArray();
  },

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await s3().send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  },

  async remove(key: string): Promise<void> {
    await s3().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  },

  /** A download link that works for `seconds` only (CLAUDE.md: restricted data by short-lived signed URLs). */
  async signedDownloadUrl(key: string, fileName: string, seconds = 60): Promise<string> {
    publicClient ??= new S3Client(s3ClientConfig(env.s3.publicEndpoint));
    const safeName = fileName.replace(/[^\w.\- ]+/g, '_');
    return getSignedUrl(
      publicClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: `attachment; filename="${safeName}"` }),
      { expiresIn: seconds },
    );
  },
};
