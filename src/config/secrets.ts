import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

interface Secrets {
  googleRefreshToken: string;
  googleClientId: string;
  googleClientSecret: string;
}

let cachedSecrets: Secrets | null = null;

// Try to get secret from environment variable first, then fall back to Secret Manager
async function getSecret(name: string, envVar: string, projectId: string): Promise<string> {
  // Check environment variable first (for local development)
  const envValue = process.env[envVar];
  if (envValue) {
    return envValue;
  }

  // Fall back to Secret Manager (for production)
  const client = new SecretManagerServiceClient();
  const secretPath = `projects/${projectId}/secrets/${name}/versions/latest`;
  const [version] = await client.accessSecretVersion({ name: secretPath });
  const payload = version.payload?.data;

  if (!payload) {
    throw new Error(`Secret ${name} not found in environment or Secret Manager`);
  }

  return payload.toString();
}

export async function loadSecrets(): Promise<Secrets> {
  if (cachedSecrets) {
    return cachedSecrets;
  }

  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    throw new Error('GCP_PROJECT_ID environment variable is required');
  }

  const [googleClientId, googleClientSecret, googleRefreshToken] = await Promise.all([
    getSecret('google-oauth-client-id', 'GOOGLE_CLIENT_ID', projectId),
    getSecret('google-oauth-client-secret', 'GOOGLE_CLIENT_SECRET', projectId),
    getSecret('google-tasks-refresh-token', 'GOOGLE_REFRESH_TOKEN', projectId),
  ]);

  cachedSecrets = {
    googleRefreshToken,
    googleClientId,
    googleClientSecret,
  };

  return cachedSecrets;
}
