// Server-only. Never import this module from a component.
if (!process.env["DATABASE_URL"] && typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env");
  } catch {
    // Running with an injected environment (CI, hosting). Nothing to load.
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const env = {
  supabaseUrl: required("SUPABASE_URL"),
  supabasePublishableKey:
    process.env["SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["SUPABASE_ANON_KEY"] ??
    required("SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  databaseUrl: required("DATABASE_URL"),
  sessionSecret: required("SESSION_SECRET"),
  demoEmail: process.env["DEMO_EMAIL"] ?? "demo.owner@bahi.app",
  demoPassword: process.env["DEMO_PASSWORD"] ?? "",
  demoTenantName: process.env["DEMO_TENANT_NAME"] ?? "Shree Metals Works",
  isProduction: process.env["NODE_ENV"] === "production",
  appBaseUrl: (process.env["APP_BASE_URL"] ?? "").replace(/\/+$/, ""),
  tokenEncryptionKey: process.env["TOKEN_ENCRYPTION_KEY"] ?? "",
  cronSecret: process.env["CRON_SECRET"] ?? "",
  ai: {
    baseUrl: (process.env["AI_BASE_URL"] ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: process.env["AI_API_KEY"] ?? "",
    modelSmall: process.env["AI_MODEL_SMALL"] ?? "gpt-4o-mini",
    modelLarge: process.env["AI_MODEL_LARGE"] ?? "gpt-4o",
    visionModel: process.env["AI_VISION_MODEL"] ?? process.env["AI_MODEL_LARGE"] ?? "gpt-4o",
    timeoutMs: Number(process.env["AI_TIMEOUT_MS"] ?? "45000"),
  },
  bridge: {
    signingSecret: process.env["BRIDGE_SIGNING_SECRET"] ?? "",
    pollLimit: Number(process.env["BRIDGE_POLL_LIMIT"] ?? "10"),
  },
  google: {
    clientId: process.env["GOOGLE_CLIENT_ID"] ?? "",
    clientSecret: process.env["GOOGLE_CLIENT_SECRET"] ?? "",
    redirectUri: process.env["GOOGLE_REDIRECT_URI"] ?? "",
  },
  gstn: {
    url: process.env["GSTIN_API_URL"] ?? "",
    apiKey: process.env["GSTIN_API_KEY"] ?? "",
  },
  notifications: {
    emailUrl: process.env["EMAIL_API_URL"] ?? "",
    emailKey: process.env["EMAIL_API_KEY"] ?? "",
    whatsappUrl: process.env["WHATSAPP_API_URL"] ?? "",
    whatsappToken: process.env["WHATSAPP_TOKEN"] ?? "",
    whatsappPhoneId: process.env["WHATSAPP_PHONE_ID"] ?? "",
  },
  langfuse: {
    publicKey: process.env["LANGFUSE_PUBLIC_KEY"] ?? "",
    secretKey: process.env["LANGFUSE_SECRET_KEY"] ?? "",
    host: (process.env["LANGFUSE_HOST"] ?? "https://cloud.langfuse.com").replace(/\/+$/, ""),
  },
};
