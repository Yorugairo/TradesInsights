import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export function sha256Hex(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export interface PutResult {
  storageKey: string;
  sha256: string;
  byteSize: number;
  /** True when an object with this content already existed (idempotent rerun). */
  alreadyExisted: boolean;
}

/**
 * Immutable artifact storage. Keys are content-addressed
 * (raw/<sourceKey>/<sha256>) so identical content is stored once and existing
 * content is never overwritten with different bytes.
 */
export interface ObjectStore {
  putImmutable(sourceKey: string, body: Buffer, contentType: string): Promise<PutResult>;
  get(storageKey: string): Promise<Buffer>;
  exists(storageKey: string): Promise<boolean>;
}

export interface S3ObjectStoreConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Optional STS-style session token. MinIO does not use one; Supabase Storage's
   * S3 protocol does, and its credential shape is NOT the obvious one — verified
   * empirically 2026-07-27 against project arbmeioglflvzoffgtii:
   *
   *   accessKeyId     = project ref
   *   secretAccessKey = ANON key         (what the request is signed with)
   *   sessionToken    = SERVICE ROLE JWT (what actually authorises it)
   *
   * Signing with the service-role key in secretAccessKey fails, with or without
   * a token. Optional so the MinIO path and every existing caller are unchanged.
   */
  sessionToken?: string;
}

export function s3ConfigFromEnv(): S3ObjectStoreConfig {
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const sessionToken = process.env["OBJECT_STORAGE_SESSION_TOKEN"];
  return {
    endpoint: need("OBJECT_STORAGE_ENDPOINT"),
    region: need("OBJECT_STORAGE_REGION"),
    bucket: need("OBJECT_STORAGE_BUCKET"),
    accessKeyId: need("OBJECT_STORAGE_ACCESS_KEY"),
    secretAccessKey: need("OBJECT_STORAGE_SECRET_KEY"),
    // Absent for MinIO; required for Supabase Storage (see S3ObjectStoreConfig).
    ...(sessionToken ? { sessionToken } : {}),
  };
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3ObjectStoreConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        // Spread, not a literal undefined: the AWS SDK signs `sessionToken`
        // into the request when the key is PRESENT, so an explicit undefined
        // is not equivalent to omitting it.
        ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
      },
    });
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async putImmutable(
    sourceKey: string,
    body: Buffer,
    contentType: string,
  ): Promise<PutResult> {
    const sha = sha256Hex(body);
    const storageKey = `raw/${sourceKey}/${sha}`;
    if (await this.exists(storageKey)) {
      return { storageKey, sha256: sha, byteSize: body.byteLength, alreadyExisted: true };
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: body,
        ContentType: contentType,
        Metadata: { sha256: sha },
      }),
    );
    return { storageKey, sha256: sha, byteSize: body.byteLength, alreadyExisted: false };
  }

  async get(storageKey: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`object ${storageKey} has no body`);
    return Buffer.from(bytes);
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }),
      );
      return true;
    } catch {
      return false;
    }
  }
}

/** In-memory store for unit tests; integration tests use MinIO via S3ObjectStore. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();

  async putImmutable(
    sourceKey: string,
    body: Buffer,
    _contentType: string,
  ): Promise<PutResult> {
    const sha = sha256Hex(body);
    const storageKey = `raw/${sourceKey}/${sha}`;
    const alreadyExisted = this.objects.has(storageKey);
    if (!alreadyExisted) this.objects.set(storageKey, Buffer.from(body));
    return { storageKey, sha256: sha, byteSize: body.byteLength, alreadyExisted };
  }

  async get(storageKey: string): Promise<Buffer> {
    const body = this.objects.get(storageKey);
    if (!body) throw new Error(`object ${storageKey} not found`);
    return body;
  }

  async exists(storageKey: string): Promise<boolean> {
    return this.objects.has(storageKey);
  }
}
