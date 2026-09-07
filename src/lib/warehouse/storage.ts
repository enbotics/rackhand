/**
 * Supabase Storage — the photo captured at putaway time.
 *
 * SERVER ONLY. Uses the service-role key (full read/write, bypasses RLS) —
 * this app has no per-user auth model to scope a narrower key against, and
 * the browser never talks to Supabase directly, only to our own API routes,
 * so the service key never needs to leave the server.
 *
 * The bucket is public-read: these are warehouse-floor photos of parts on a
 * calibration mat, not sensitive data, and there is no viewer-auth model in
 * this app to gate a private bucket against anyway.
 */
import { createClient } from "@supabase/supabase-js";

const BUCKET = "putaway-photos";

let cachedClient: ReturnType<typeof createClient> | null = null;

function getClient() {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not set — see .env.local.");
  }
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

let bucketEnsured = false;

/** Idempotent: creates the bucket once per process if it doesn't already exist. */
async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const client = getClient();
  const { data: buckets, error: listError } = await client.storage.listBuckets();
  if (listError) throw new Error(`Could not list Supabase Storage buckets: ${listError.message}`);

  if (!buckets?.some((bucket) => bucket.name === BUCKET)) {
    const { error: createError } = await client.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: "5MB",
    });
    // A concurrent request may have created it a moment earlier — that's success, not a failure.
    if (createError && !createError.message.includes("already exists")) {
      throw new Error(`Could not create Supabase Storage bucket "${BUCKET}": ${createError.message}`);
    }
  }
  bucketEnsured = true;
}

function decodeDataUrl(dataUrl: string): { bytes: Buffer; contentType: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("imageDataUrl is not a valid base64 data URL.");
  return { contentType: match[1], bytes: Buffer.from(match[2], "base64") };
}

/**
 * Uploads the photo captured for one scan and returns its public URL.
 *
 * Never throws for a caller to treat as fatal in the way a warehouse
 * business rule would — see the try/catch at every call site. A photo is
 * evidence for a human later, not something a physical operation should ever
 * be blocked by.
 */
export async function uploadPutawayPhoto(scanId: string, imageDataUrl: string): Promise<string> {
  await ensureBucket();
  const { bytes, contentType } = decodeDataUrl(imageDataUrl);
  const path = `${scanId}.jpg`;

  const client = getClient();
  const { error } = await client.storage.from(BUCKET).upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);

  const { data } = client.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Stores the fresh, operator-reviewed view of a presented bin. Unlike the
 * intake scan photo above, this upload is required before the gantry may
 * return a bin containing a newly placed item.
 */
export async function uploadBinVerificationPhoto(
  movementId: string,
  binCode: string,
  imageDataUrl: string,
): Promise<string> {
  await ensureBucket();
  const { bytes, contentType } = decodeDataUrl(imageDataUrl);
  const safeBinCode = binCode.toUpperCase().replace(/[^A-Z0-9-]/g, "-");
  const path = `bin-verifications/${safeBinCode}/${movementId}.jpg`;

  const client = getClient();
  const { error } = await client.storage.from(BUCKET).upload(path, bytes, {
    contentType,
    upsert: true,
  });
  if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);

  const { data } = client.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}
