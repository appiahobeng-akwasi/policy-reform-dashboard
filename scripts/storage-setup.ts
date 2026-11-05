// Creates the private file storage bucket if it does not exist. Run once per environment.
import { loadEnv } from './lib/db';

loadEnv();
const { storage } = await import('../src/lib/platform/s3-storage');
const result = await storage.ensureBucket();
console.log(`Bucket ${storage.bucket}: ${result}.`);
