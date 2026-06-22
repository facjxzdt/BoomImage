export type ImageStatus = "pending" | "processing" | "ready" | "partial" | "failed";

export interface ImageVariant {
  profile: "display" | "thumb";
  format: "avif" | "webp";
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  status: "pending" | "ready" | "failed";
  error: string | null;
  url: string | null;
}

export interface ImageItem {
  id: string;
  sha256: string;
  originalName: string;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  hasAlpha: boolean;
  isAnimated: boolean;
  status: ImageStatus;
  storageDriver: "local" | "s3";
  accessMode: "direct" | "proxy";
  createdAt: string;
  updatedAt: string;
  originalUrl: string;
  variants: ImageVariant[];
}

export interface RuntimeSettings {
  baseUrl: string;
  maxUploadBytes: number;
  maxInputPixels: number;
  jobLeaseSeconds: number;
  jobMaxAttempts: number;
  avifQuality: number;
  avifEffort: number;
  webpQuality: number;
  storageDriver: "local" | "s3";
  storageAccessMode: "direct" | "proxy";
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    prefix: string;
    publicBaseUrl: string;
    forcePathStyle: boolean;
    accessKeyId: string;
    secretAccessKeyConfigured: boolean;
    sessionTokenConfigured: boolean;
  };
}
