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
  createdAt: string;
  updatedAt: string;
  originalUrl: string;
  variants: ImageVariant[];
}

