import sharp from "sharp";

export interface ImageFormatReadiness {
  checkedAt: string;
}

let readinessPromise: Promise<ImageFormatReadiness> | undefined;

async function assertFormatOutput(format: "avif" | "webp"): Promise<void> {
  const outputSupport = format === "avif" ? sharp.format.heif?.output : sharp.format.webp?.output;
  if (!outputSupport) throw new Error(`Sharp output support is missing for ${format.toUpperCase()}`);

  const source = sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  });

  if (format === "avif") {
    await source.avif({ quality: 50, effort: 0 }).toBuffer();
  } else {
    await source.webp({ quality: 80 }).toBuffer();
  }
}

export async function assertImageFormatsReady(): Promise<ImageFormatReadiness> {
  if (!readinessPromise) {
    readinessPromise = (async () => {
      await assertFormatOutput("avif");
      await assertFormatOutput("webp");
      return { checkedAt: new Date().toISOString() };
    })();
  }
  return readinessPromise;
}
