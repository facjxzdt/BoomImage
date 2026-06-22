import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { ApiError, api, uploadImage } from "./api";
import type { ImageItem, ImageStatus, RuntimeSettings } from "./types";

type Screen = "loading" | "setup" | "login" | "gallery";

interface UploadEntry {
  id: string;
  name: string;
  progress: number;
  state: "uploading" | "done" | "error";
  message?: string;
}

type UploadStorageDriver = "local" | "s3";
type UploadAccessMode = "direct" | "proxy";

const errorMessages: Record<string, string> = {
  INVALID_CREDENTIALS: "密码不正确",
  ALREADY_INITIALIZED: "管理员已经初始化，请直接登录",
  FILE_TOO_LARGE: "文件超过上传大小限制",
  UNSUPPORTED_IMAGE_TYPE: "暂不支持这种图片格式",
  INVALID_IMAGE: "图片已损坏或无法解码",
  IMAGE_TYPE_MISMATCH: "图片内容与文件格式不一致",
  INVALID_CSRF_OR_SESSION: "会话已过期，请重新登录",
  IMAGE_BUSY: "图片仍在转换，请稍后再删除",
  NETWORK_ERROR: "无法连接到服务",
  INVALID_SETTINGS: "设置无效，请检查必填项和取值范围",
  S3_NOT_CONFIGURED: "S3 尚未配置完整",
};

const brandMarkClass =
  "inline-grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-blue-600 to-teal-500 font-black text-white shadow-[0_10px_24px_rgba(37,99,235,0.28)]";
const eyebrowClass = "mb-3 text-[11px] font-black tracking-[0.16em] text-blue-600";
const primaryButtonClass =
  "rounded-xl border-0 bg-gradient-to-br from-blue-600 to-blue-700 px-4 py-3.5 font-black text-white shadow-[0_12px_24px_rgba(37,99,235,0.22)] transition hover:-translate-y-0.5 hover:brightness-105 hover:shadow-[0_16px_30px_rgba(37,99,235,0.28)] disabled:translate-y-0 disabled:cursor-wait disabled:opacity-60 disabled:shadow-none";
const quietButtonClass =
  "rounded-[10px] border border-slate-200 bg-white/75 px-3 py-2 text-xs font-bold text-slate-700 transition hover:border-blue-300 hover:bg-white hover:text-blue-600 hover:shadow-sm";
const ghostButtonClass =
  "rounded-[10px] border border-transparent bg-transparent px-3 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-slate-900";
const inputClass =
  "w-full rounded-[13px] border border-slate-200 bg-white px-3.5 py-3 text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-blue-500/70 focus:shadow-[0_0_0_4px_rgba(37,99,235,0.10)]";
const dangerTextClass = "text-[13px] text-red-500";

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function friendlyError(error: unknown): string {
  if (error instanceof ApiError) return errorMessages[error.code] ?? `请求失败：${error.code}`;
  return error instanceof Error ? error.message : "发生未知错误";
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusText(status: ImageStatus): string {
  return {
    pending: "等待转换",
    processing: "正在转换",
    ready: "转换完成",
    partial: "部分完成",
    failed: "转换失败",
  }[status];
}

function statusDescription(status: ImageStatus): string {
  return {
    pending: "任务已入队，等待后台 Worker 领取。",
    processing: "正在生成 AVIF、WebP 和缩略图。",
    ready: "所有常用变体已经准备好。",
    partial: "部分变体失败，原图仍可访问。",
    failed: "转换失败，可在卡片上重试。",
  }[status];
}

function statusBadgeClass(status: ImageStatus): string {
  const variants: Record<ImageStatus, string> = {
    pending: "border-blue-200 bg-blue-50/95 text-blue-600",
    processing: "border-blue-200 bg-blue-50/95 text-blue-600",
    ready: "border-green-200 bg-green-50/95 text-green-600",
    partial: "border-amber-200 bg-amber-50/95 text-amber-600",
    failed: "border-red-200 bg-red-50/95 text-red-500",
  };

  return cx(
    "absolute right-3 top-3 rounded-full border px-2.5 py-1.5 text-[10px] font-black shadow-sm backdrop-blur",
    variants[status],
  );
}

function StatCard({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="rounded-2xl border border-slate-200/85 bg-white/75 p-4 shadow-sm backdrop-blur">
      <p className="mb-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <strong className="block text-2xl font-black tracking-[-0.04em] text-slate-950">{value}</strong>
      <span className="mt-1 block text-xs text-slate-500">{hint}</span>
    </div>
  );
}

function AuthPanel({ mode, onAuthenticated }: { mode: "setup" | "login"; onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const isSetup = mode === "setup";

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (isSetup && password !== confirmation) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      if (isSetup) await api.setup(password);
      else await api.login(password);
      onAuthenticated();
    } catch (submitError) {
      setError(friendlyError(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-6 py-10">
      <section className="relative w-full max-w-[470px] overflow-hidden rounded-[28px] border border-slate-200/90 bg-white/85 p-8 shadow-[0_28px_80px_rgba(32,55,84,0.16)] backdrop-blur-xl sm:p-10">
        <div className="pointer-events-none absolute -right-20 -top-24 h-52 w-52 rounded-full bg-blue-100/80 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-20 h-52 w-52 rounded-full bg-teal-100/80 blur-3xl" />
        <div className="relative">
        <div className="mb-12 flex items-center gap-2.5 text-[19px] font-black tracking-[-0.035em] text-slate-950">
          <span className={brandMarkClass} aria-hidden="true">B</span>
          <span>BoomImage</span>
        </div>
        <p className={eyebrowClass}>PRIVATE IMAGE VAULT</p>
        <h1 className="mb-3.5 text-[clamp(30px,7vw,42px)] font-black leading-[1.05] tracking-[-0.055em] text-slate-950">
          {isSetup ? "创建你的私人图床" : "欢迎回来"}
        </h1>
        <p className="mb-8 leading-relaxed text-slate-500">
          {isSetup ? "设置管理员密码后，就可以开始上传和自动转换图片。" : "输入管理员密码进入图片管理台。"}
        </p>
        <form onSubmit={submit} className="grid gap-4.5">
          <label className="grid gap-2 text-[13px] font-bold text-slate-700">
            管理员密码
            <input
              className={inputClass}
              autoFocus
              type="password"
              minLength={12}
              maxLength={128}
              autoComplete={isSetup ? "new-password" : "current-password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 12 个字符"
              required
            />
          </label>
          {isSetup && (
            <label className="grid gap-2 text-[13px] font-bold text-slate-700">
              确认密码
              <input
                className={inputClass}
                type="password"
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder="再次输入密码"
                required
              />
            </label>
          )}
          {error && <p className={dangerTextClass} role="alert">{error}</p>}
          <button className={primaryButtonClass} disabled={submitting}>
            {submitting ? "请稍候…" : isSetup ? "初始化 BoomImage" : "登录"}
          </button>
        </form>
        <p className="mt-5 text-center text-xs text-slate-400">密码只在本机以 Argon2id 哈希保存</p>
        </div>
      </section>
    </main>
  );
}

function UploadZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    onFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <section
      className={cx(
        "group relative overflow-hidden rounded-[26px] border border-dashed border-slate-300 bg-white/80 shadow-sm transition",
        "before:absolute before:inset-0 before:bg-[radial-gradient(circle_at_20%_20%,rgba(37,99,235,0.12),transparent_30%),radial-gradient(circle_at_80%_0%,rgba(20,184,166,0.11),transparent_28%)] before:opacity-80 before:transition",
        "hover:-translate-y-0.5 hover:border-blue-500/70 hover:bg-white hover:shadow-[0_16px_40px_rgba(32,55,84,0.10)]",
        dragging && "-translate-y-0.5 border-blue-500/70 bg-white shadow-[0_16px_40px_rgba(32,55,84,0.10)] before:opacity-100",
      )}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={drop}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        multiple
        hidden
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className="relative grid min-h-[204px] w-full place-items-center content-center gap-2 border-0 bg-transparent px-5 text-slate-700"
        onClick={() => inputRef.current?.click()}
      >
        <span className="mb-2 grid h-14 w-14 place-items-center rounded-2xl bg-white text-3xl text-blue-600 shadow-[0_14px_32px_rgba(37,99,235,0.14),inset_0_0_0_1px_rgba(37,99,235,0.10)] transition group-hover:scale-105" aria-hidden="true">↑</span>
        <span className="text-base"><strong className="text-blue-600">拖入图片</strong>，或点击选择文件</span>
        <small className="max-w-md text-center text-xs leading-relaxed text-slate-500">JPEG、PNG、WebP、GIF、AVIF · 自动生成 AVIF/WebP 和缩略图 · 支持剪贴板粘贴上传</small>
      </button>
    </section>
  );
}

function ImageCard({
  image,
  onCopy,
  onRetry,
  onDelete,
}: {
  image: ImageItem;
  onCopy: (text: string, label: string) => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const thumbnail = image.variants.find((variant) => variant.profile === "thumb" && variant.format === "avif" && variant.url)
    ?? image.variants.find((variant) => variant.profile === "thumb" && variant.url);
  const display = image.variants.find((variant) => variant.profile === "display" && variant.format === "avif" && variant.url)
    ?? image.variants.find((variant) => variant.profile === "display" && variant.url);
  const preferredUrl = display?.url ?? image.originalUrl;
  const markdown = `![${image.originalName}](${preferredUrl})`;
  const html = `<img src="${preferredUrl}" alt="${image.originalName.replaceAll('"', "&quot;")}">`;
  const readyVariants = image.variants.filter((variant) => variant.status === "ready");
  const actionButtonClass =
    "rounded-[10px] border border-slate-200 bg-white p-2 text-[11px] font-bold text-slate-600 transition hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 disabled:bg-slate-50 disabled:text-slate-400";

  return (
    <article className="group overflow-hidden rounded-[22px] border border-slate-200/95 bg-white/90 shadow-sm transition hover:-translate-y-1 hover:border-blue-200 hover:shadow-[0_18px_46px_rgba(32,55,84,0.12)]">
      <div className="relative aspect-[4/3] overflow-hidden bg-white [background-image:linear-gradient(45deg,#f1f5f9_25%,transparent_25%),linear-gradient(-45deg,#f1f5f9_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f1f5f9_75%),linear-gradient(-45deg,transparent_75%,#f1f5f9_75%)] [background-position:0_0,0_9px,9px_-9px,-9px_0] [background-size:18px_18px]">
        <img className="block h-full w-full object-contain transition duration-300 group-hover:scale-[1.015]" src={thumbnail?.url ?? image.originalUrl} alt={image.originalName} loading="lazy" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-slate-950/20 to-transparent opacity-0 transition group-hover:opacity-100" />
        <span className={statusBadgeClass(image.status)}>{statusText(image.status)}</span>
      </div>
      <div className="p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="mb-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-bold text-slate-950" title={image.originalName}>
              {image.originalName}
            </h3>
            <p className="text-[11px] text-slate-500">
              {image.width} × {image.height} <span className="px-1 text-slate-300">·</span> {formatBytes(image.sizeBytes)}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-500">{readyVariants.length}/4</span>
        </div>
        <p className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          {statusDescription(image.status)}
        </p>
        <div className="flex min-h-10 flex-wrap content-start gap-1.5">
          <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[9px] font-black text-slate-500">原图</span>
          <span className={cx(
            "rounded-md border px-2 py-1 text-[9px] font-black",
            image.storageDriver === "s3"
              ? "border-violet-200 bg-violet-50 text-violet-600"
              : "border-slate-200 bg-slate-50 text-slate-500",
          )}>
            {image.storageDriver === "s3" ? `S3 ${image.accessMode === "proxy" ? "代理" : "直链"}` : "本地"}
          </span>
          {readyVariants.map((variant) => (
            <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[9px] font-black text-slate-500" key={`${variant.profile}-${variant.format}`}>
              {variant.profile === "thumb" ? "缩略" : "展示"} {variant.format.toUpperCase()}
            </span>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className={actionButtonClass} type="button" onClick={() => onCopy(preferredUrl, "图片链接")}>复制链接</button>
          <button className={actionButtonClass} type="button" onClick={() => onCopy(markdown, "Markdown")}>Markdown</button>
          <button className={actionButtonClass} type="button" onClick={() => onCopy(html, "HTML")}>HTML</button>
          {image.status === "failed" || image.status === "partial" ? (
            <button className={actionButtonClass} type="button" onClick={onRetry}>重新转换</button>
          ) : image.status === "ready" ? (
            <button className={cx(actionButtonClass, "hover:border-red-200 hover:bg-red-50 hover:text-red-500")} type="button" onClick={onDelete}>删除</button>
          ) : (
            <button className={actionButtonClass} type="button" disabled>转换中</button>
          )}
        </div>
      </div>
    </article>
  );
}

function TokenPanel({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<Awaited<ReturnType<typeof api.tokens>>["items"]>([]);
  const [name, setName] = useState("PicGo");
  const [rawToken, setRawToken] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setTokens((await api.tokens()).items); } catch (loadError) { setError(friendlyError(loadError)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      const created = await api.createToken(name.trim());
      setRawToken(created.token);
      setName("");
      await load();
    } catch (createError) { setError(friendlyError(createError)); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/30 p-5 backdrop-blur-[10px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="max-h-[min(760px,calc(100vh-40px))] w-full max-w-[660px] overflow-auto rounded-[28px] border border-slate-200/95 bg-white/95 p-7 shadow-[0_28px_80px_rgba(32,55,84,0.16)]" role="dialog" aria-modal="true" aria-labelledby="token-title">
        <div className="flex items-start justify-between gap-5">
          <div>
            <p className={eyebrowClass}>API ACCESS</p>
            <h2 id="token-title" className="m-0 text-2xl font-black tracking-tight text-slate-950">个人访问令牌</h2>
          </div>
          <button className={quietButtonClass} type="button" onClick={onClose}>关闭</button>
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-slate-500">用于 PicGo、命令行或其他上传客户端。令牌只在创建时显示一次，请马上复制保存。</p>
        <form className="my-5 grid gap-2 sm:grid-cols-[1fr_auto]" onSubmit={create}>
          <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="令牌名称，例如 PicGo" required />
          <button className={primaryButtonClass}>创建令牌</button>
        </form>
        {rawToken && (
          <div className="mb-4 grid gap-2 rounded-2xl border border-blue-200 bg-blue-50 p-3.5">
            <strong className="text-xs text-blue-800">请立即保存</strong>
            <code className="break-all text-[11px] text-slate-800">{rawToken}</code>
            <button className="justify-self-start border-0 bg-transparent p-0 text-[11px] font-black text-blue-600" type="button" onClick={() => void navigator.clipboard.writeText(rawToken)}>复制令牌</button>
          </div>
        )}
        {error && <p className={dangerTextClass}>{error}</p>}
        <div className="grid gap-1.5">
          {tokens.length === 0 ? <p className="text-xs text-slate-500">尚未创建令牌</p> : tokens.map((token) => (
            <div className={cx("flex items-center justify-between gap-3.5 rounded-2xl border border-slate-200 bg-slate-50/70 px-3.5 py-3", token.revokedAt && "opacity-55")} key={token.id}>
              <div className="grid gap-1">
                <strong className="text-[13px] text-slate-950">{token.name}</strong>
                <span className="text-[10px] text-slate-500">
                  {token.revokedAt ? `已撤销 · ${formatDate(token.revokedAt)}` : token.lastUsedAt ? `最近使用 ${formatDate(token.lastUsedAt)}` : `创建于 ${formatDate(token.createdAt)}`}
                </span>
              </div>
              {!token.revokedAt && (
                <button
                  className="border-0 bg-transparent text-[11px] font-black text-red-500"
                  type="button"
                  onClick={() => void api.revokeToken(token.id).then(load).catch((cause) => setError(friendlyError(cause)))}
                >
                  撤销
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function numberInputValue(value: number): string {
  return Number.isFinite(value) ? String(value) : "";
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [clearSecretAccessKey, setClearSecretAccessKey] = useState(false);
  const [clearSessionToken, setClearSessionToken] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings((await api.settings()).settings);
      setError("");
    } catch (loadError) {
      setError(friendlyError(loadError));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(""), 2_000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  function update<K extends keyof RuntimeSettings>(key: K, value: RuntimeSettings[K]) {
    setSettings((current) => current ? { ...current, [key]: value } : current);
  }

  function updateS3<K extends keyof RuntimeSettings["s3"]>(key: K, value: RuntimeSettings["s3"][K]) {
    setSettings((current) => current ? { ...current, s3: { ...current.s3, [key]: value } } : current);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setSaving(true);
    setError("");
    try {
      const payload = {
        ...settings,
        s3: {
          ...settings.s3,
          ...(secretAccessKey ? { secretAccessKey } : {}),
          ...(clearSecretAccessKey ? { clearSecretAccessKey: true } : {}),
          ...(sessionToken ? { sessionToken } : {}),
          ...(clearSessionToken ? { clearSessionToken: true } : {}),
        },
      };
      const response = await api.updateSettings(payload);
      setSettings(response.settings);
      setSecretAccessKey("");
      setSessionToken("");
      setClearSecretAccessKey(false);
      setClearSessionToken(false);
      setSaved("设置已保存");
    } catch (saveError) {
      setError(friendlyError(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/30 p-5 backdrop-blur-[10px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="max-h-[min(860px,calc(100vh-40px))] w-full max-w-[860px] overflow-auto rounded-[28px] border border-slate-200/95 bg-white/95 p-7 shadow-[0_28px_80px_rgba(32,55,84,0.16)]" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="flex items-start justify-between gap-5">
          <div>
            <p className={eyebrowClass}>RUNTIME SETTINGS</p>
            <h2 id="settings-title" className="m-0 text-2xl font-black tracking-tight text-slate-950">程序设置</h2>
          </div>
          <button className={quietButtonClass} type="button" onClick={onClose}>关闭</button>
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-slate-500">
          这里保存到 SQLite，会覆盖 `.env` 中对应默认值。端口、数据目录、APP_SECRET 等启动级配置仍建议通过 `.env` 管理；反向代理上传上限改动后也要同步调整 Nginx/Caddy。
        </p>
        {!settings ? (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">正在读取设置…</div>
        ) : (
          <form className="mt-6 grid gap-6" onSubmit={submit}>
            <section className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <h3 className="text-sm font-black text-slate-950">基础与转换</h3>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  公开访问地址
                  <input className={inputClass} value={settings.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://img.example.com" required />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  最大上传字节
                  <input className={inputClass} type="number" min={1} max={1_073_741_824} value={numberInputValue(settings.maxUploadBytes)} onChange={(event) => update("maxUploadBytes", Number(event.target.value))} />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  最大解码像素
                  <input className={inputClass} type="number" min={1} max={1_000_000_000} value={numberInputValue(settings.maxInputPixels)} onChange={(event) => update("maxInputPixels", Number(event.target.value))} />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  任务租约秒数
                  <input className={inputClass} type="number" min={30} max={3600} value={numberInputValue(settings.jobLeaseSeconds)} onChange={(event) => update("jobLeaseSeconds", Number(event.target.value))} />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  最大重试次数
                  <input className={inputClass} type="number" min={1} max={10} value={numberInputValue(settings.jobMaxAttempts)} onChange={(event) => update("jobMaxAttempts", Number(event.target.value))} />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  AVIF 质量
                  <input className={inputClass} type="number" min={1} max={100} value={numberInputValue(settings.avifQuality)} onChange={(event) => update("avifQuality", Number(event.target.value))} />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  AVIF Effort
                  <input className={inputClass} type="number" min={0} max={9} value={numberInputValue(settings.avifEffort)} onChange={(event) => update("avifEffort", Number(event.target.value))} />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  WebP 质量
                  <input className={inputClass} type="number" min={1} max={100} value={numberInputValue(settings.webpQuality)} onChange={(event) => update("webpQuality", Number(event.target.value))} />
                </label>
              </div>
            </section>

            <section className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <h3 className="text-sm font-black text-slate-950">默认存储</h3>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  默认上传后端
                  <select className={inputClass} value={settings.storageDriver} onChange={(event) => update("storageDriver", event.target.value as RuntimeSettings["storageDriver"])}>
                    <option value="local">本地</option>
                    <option value="s3">S3</option>
                  </select>
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  默认 S3 访问方式
                  <select className={inputClass} value={settings.storageAccessMode} onChange={(event) => update("storageAccessMode", event.target.value as RuntimeSettings["storageAccessMode"])}>
                    <option value="direct">S3/CDN 直链</option>
                    <option value="proxy">服务器代理</option>
                  </select>
                </label>
              </div>
            </section>

            <section className="grid gap-4 rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <h3 className="text-sm font-black text-slate-950">S3 兼容存储</h3>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  Endpoint
                  <input className={inputClass} value={settings.s3.endpoint} onChange={(event) => updateS3("endpoint", event.target.value)} placeholder="https://xxx.r2.cloudflarestorage.com" />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  Region
                  <input className={inputClass} value={settings.s3.region} onChange={(event) => updateS3("region", event.target.value)} placeholder="auto" />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  Bucket
                  <input className={inputClass} value={settings.s3.bucket} onChange={(event) => updateS3("bucket", event.target.value)} />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  Prefix
                  <input className={inputClass} value={settings.s3.prefix} onChange={(event) => updateS3("prefix", event.target.value)} placeholder="boomimage" />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700 md:col-span-2">
                  直链公开基址 / CDN
                  <input className={inputClass} value={settings.s3.publicBaseUrl} onChange={(event) => updateS3("publicBaseUrl", event.target.value)} placeholder="https://cdn.example.com" />
                </label>
                <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-[13px] font-bold text-slate-700">
                  <input type="checkbox" checked={settings.s3.forcePathStyle} onChange={(event) => updateS3("forcePathStyle", event.target.checked)} />
                  使用 path-style 访问
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  Access Key ID
                  <input className={inputClass} value={settings.s3.accessKeyId} onChange={(event) => updateS3("accessKeyId", event.target.value)} />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  Secret Access Key
                  <input className={inputClass} type="password" value={secretAccessKey} onChange={(event) => { setSecretAccessKey(event.target.value); setClearSecretAccessKey(false); }} placeholder={settings.s3.secretAccessKeyConfigured ? "已保存，留空则不修改" : "未配置"} />
                </label>
                <label className="grid gap-2 text-[13px] font-bold text-slate-700">
                  Session Token
                  <input className={inputClass} type="password" value={sessionToken} onChange={(event) => { setSessionToken(event.target.value); setClearSessionToken(false); }} placeholder={settings.s3.sessionTokenConfigured ? "已保存，留空则不修改" : "可选"} />
                </label>
              </div>
              <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={clearSecretAccessKey} onChange={(event) => { setClearSecretAccessKey(event.target.checked); if (event.target.checked) setSecretAccessKey(""); }} />
                  清空 Secret Access Key
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={clearSessionToken} onChange={(event) => { setClearSessionToken(event.target.checked); if (event.target.checked) setSessionToken(""); }} />
                  清空 Session Token
                </label>
              </div>
            </section>

            {error && <p className={dangerTextClass} role="alert">{error}</p>}
            {saved && <p className="text-[13px] font-bold text-green-600">{saved}</p>}
            <div className="flex justify-end gap-2">
              <button className={quietButtonClass} type="button" onClick={() => void load()}>重新读取</button>
              <button className={primaryButtonClass} disabled={saving}>{saving ? "保存中…" : "保存设置"}</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function Gallery({ onLogout }: { onLogout: () => void }) {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [tokensOpen, setTokensOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploadStorage, setUploadStorage] = useState<UploadStorageDriver>("local");
  const [uploadAccess, setUploadAccess] = useState<UploadAccessMode>("direct");
  const readyCount = images.filter((image) => image.status === "ready").length;
  const processingCount = images.filter((image) => image.status === "pending" || image.status === "processing").length;
  const totalBytes = images.reduce((sum, image) => sum + image.sizeBytes, 0);

  const refresh = useCallback(async () => {
    try {
      const response = await api.images();
      setImages(response.items);
      setError("");
    } catch (refreshError) {
      if (refreshError instanceof ApiError && refreshError.status === 401) onLogout();
      else setError(friendlyError(refreshError));
    } finally {
      setLoading(false);
    }
  }, [onLogout]);

  useEffect(() => { void refresh(); }, [refresh]);
  const hasActiveConversions = useMemo(
    () => images.some((image) => image.status === "pending" || image.status === "processing"),
    [images],
  );
  useEffect(() => {
    if (!hasActiveConversions) return;
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(timer);
  }, [hasActiveConversions, refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function addFiles(files: File[]) {
    for (const file of files) {
      const id = `${file.name}-${file.lastModified}-${Math.random()}`;
      setUploads((current) => [...current, { id, name: file.name, progress: 0, state: "uploading" }]);
      try {
        const result = await uploadImage(
          file,
          (progress) => {
            setUploads((current) => current.map((entry) => entry.id === id ? { ...entry, progress } : entry));
          },
          { storageDriver: uploadStorage, accessMode: uploadAccess },
        );
        setUploads((current) => current.map((entry) => entry.id === id
          ? { ...entry, progress: 100, state: "done", message: result.duplicate ? "已存在" : "已上传" }
          : entry));
        setImages((current) => [result.image, ...current.filter((image) => image.id !== result.image.id)]);
      } catch (uploadError) {
        setUploads((current) => current.map((entry) => entry.id === id
          ? { ...entry, state: "error", message: friendlyError(uploadError) }
          : entry));
      }
    }
    window.setTimeout(() => setUploads((current) => current.filter((entry) => entry.state === "uploading")), 3_500);
  }

  async function copy(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setToast(`${label}已复制`);
  }

  async function retryImage(id: string) {
    try {
      await api.retryImage(id);
      setToast("已重新加入转换队列");
      await refresh();
    } catch (retryError) {
      setError(friendlyError(retryError));
    }
  }

  async function deleteImage(image: ImageItem) {
    if (!window.confirm(`确定删除“${image.originalName}”及其所有变体吗？`)) return;
    try {
      await api.deleteImage(image.id);
      setImages((current) => current.filter((item) => item.id !== image.id));
      setToast("图片已删除");
    } catch (deleteError) {
      setError(friendlyError(deleteError));
    }
  }

  function pasteImages(event: ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      event.preventDefault();
      void addFiles(files);
    }
  }

  return (
    <div className="min-h-screen" onPaste={pasteImages}>
      <header className="sticky top-0 z-10 flex h-[70px] items-center gap-7 border-b border-slate-200/90 bg-white/80 px-[max(24px,calc((100vw-1240px)/2))] shadow-[0_1px_0_rgba(15,23,42,0.02)] backdrop-blur-xl max-sm:px-4">
        <div className="flex items-center gap-2.5 text-[19px] font-black tracking-[-0.035em] text-slate-950">
          <span className={brandMarkClass}>B</span>
          <span>BoomImage</span>
        </div>
        <div className="ml-auto hidden text-xs text-slate-500 sm:block">
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-green-600 shadow-[0_0_0_4px_rgba(22,163,74,0.12)]" /> 本地服务正常
        </div>
        <div className="flex gap-2">
          <button className={quietButtonClass} type="button" onClick={() => setSettingsOpen(true)}>设置</button>
          <button className={quietButtonClass} type="button" onClick={() => setTokensOpen(true)}>API Token</button>
          <button className={ghostButtonClass} type="button" onClick={onLogout}>退出</button>
        </div>
      </header>
      <main className="mx-auto w-[min(1240px,calc(100%-48px))] py-16 pb-24 max-sm:w-[min(100%-28px,1240px)] max-sm:py-10">
        <section className="mb-8 grid grid-cols-[1fr_auto] items-end gap-8 max-lg:grid-cols-1">
          <div>
            <p className={eyebrowClass}>IMAGE LIBRARY</p>
            <h1 className="mb-4 max-w-[820px] text-[clamp(38px,6vw,68px)] font-black leading-[0.98] tracking-[-0.065em] text-slate-950">
              你的图片，轻装上阵。
            </h1>
            <p className="leading-relaxed text-slate-500">上传一次，自动生成 AVIF 与 WebP。原图始终保留。</p>
          </div>
          <div className="grid min-w-[420px] grid-cols-3 gap-3 max-lg:min-w-0 max-sm:grid-cols-1">
            <StatCard label="全部图片" value={images.length} hint="已入库资源" />
            <StatCard label="已就绪" value={readyCount} hint="可直接分发" />
            <StatCard label="原图体积" value={formatBytes(totalBytes)} hint={processingCount > 0 ? `${processingCount} 个任务进行中` : "后台队列空闲"} />
          </div>
        </section>
        <section className="mb-4 grid gap-3 rounded-3xl border border-slate-200/90 bg-white/70 p-4 shadow-sm backdrop-blur md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <h2 className="text-sm font-black text-slate-950">上传存储策略</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500">
              当前上传到 {uploadStorage === "local" ? "本地磁盘" : uploadAccess === "proxy" ? "S3，并通过服务器代理访问" : "S3，并返回 S3/CDN 直链"}。
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1 text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">
              Storage
              <select
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold normal-case tracking-normal text-slate-700 outline-none focus:border-blue-400"
                value={uploadStorage}
                onChange={(event) => setUploadStorage(event.target.value as UploadStorageDriver)}
              >
                <option value="local">本地</option>
                <option value="s3">S3</option>
              </select>
            </label>
            <label className={cx("grid gap-1 text-[11px] font-black uppercase tracking-[0.12em] text-slate-400", uploadStorage === "local" && "opacity-50")}>
              Access
              <select
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold normal-case tracking-normal text-slate-700 outline-none focus:border-blue-400 disabled:cursor-not-allowed"
                value={uploadAccess}
                disabled={uploadStorage === "local"}
                onChange={(event) => setUploadAccess(event.target.value as UploadAccessMode)}
              >
                <option value="direct">S3 直链</option>
                <option value="proxy">服务器代理</option>
              </select>
            </label>
          </div>
        </section>
        <UploadZone onFiles={(files) => void addFiles(files)} />
        {uploads.length > 0 && (
          <section className="mt-3 grid gap-2" aria-live="polite">
            {uploads.map((entry) => (
              <div className={cx(
                "grid grid-cols-[minmax(120px,1fr)_minmax(100px,2fr)_90px] items-center gap-3.5 rounded-xl border border-slate-200 bg-white/90 px-3.5 py-2.5 text-xs text-slate-500 shadow-sm max-sm:grid-cols-[1fr_65px]",
                entry.state === "error" && "text-red-500",
              )} key={entry.id}>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-slate-700">{entry.name}</span>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 max-sm:col-span-full max-sm:row-start-2">
                  <span className="block h-full rounded-full bg-gradient-to-r from-blue-600 to-teal-500 transition-[width]" style={{ width: `${entry.progress}%` }} />
                </div>
                <span>{entry.message ?? `${entry.progress}%`}</span>
              </div>
            ))}
          </section>
        )}
        <section className="mb-4 mt-14 flex items-center justify-between gap-4">
          <div>
            <h2 className="m-0 text-xl font-black tracking-tight text-slate-950">最近上传</h2>
            <p className="mt-1 text-xs text-slate-500">转换状态会自动刷新，复制链接会优先使用展示图。</p>
          </div>
          <button className={quietButtonClass} type="button" onClick={() => void refresh()}>刷新</button>
        </section>
        {error && <p className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-[13px] text-red-500" role="alert">{error}</p>}
        {loading ? (
          <div className="grid min-h-[250px] place-items-center content-center gap-2 rounded-[20px] border border-slate-200/95 bg-white/75 text-slate-500 shadow-sm">正在读取图片库…</div>
        ) : images.length === 0 ? (
          <div className="grid min-h-[250px] place-items-center content-center gap-2 rounded-[20px] border border-slate-200/95 bg-white/75 text-slate-500 shadow-sm">
            <strong className="text-lg text-slate-950">这里还很安静</strong>
            <span>上传第一张图片，转换结果会出现在这里。</span>
          </div>
        ) : (
          <section className="grid grid-cols-3 gap-4.5 max-lg:grid-cols-2 max-sm:grid-cols-1">
            {images.map((image) => (
              <ImageCard
                key={image.id}
                image={image}
                onCopy={(text, label) => void copy(text, label)}
                onRetry={() => void retryImage(image.id)}
                onDelete={() => void deleteImage(image)}
              />
            ))}
          </section>
        )}
      </main>
      {toast && <div className="fixed bottom-8 left-1/2 z-30 -translate-x-1/2 rounded-full border border-blue-200 bg-white/95 px-4 py-2.5 text-xs font-black text-blue-800 shadow-[0_16px_40px_rgba(32,55,84,0.10)]" role="status">✓ {toast}</div>}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {tokensOpen && <TokenPanel onClose={() => setTokensOpen(false)} />}
    </div>
  );
}

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");

  const checkSession = useCallback(async () => {
    try {
      const status = await api.authStatus();
      if (!status.initialized) {
        setScreen("setup");
        return;
      }
      await api.me();
      setScreen("gallery");
    } catch {
      setScreen("login");
    }
  }, []);

  useEffect(() => { void checkSession(); }, [checkSession]);

  async function logout() {
    try { await api.logout(); } catch { /* Expired sessions still return to login. */ }
    setScreen("login");
  }

  if (screen === "loading") {
    return (
      <main className="grid min-h-screen place-items-center content-center gap-3.5 px-6 py-10 text-slate-500">
        <span className={brandMarkClass}>B</span>
        <p>正在唤醒 BoomImage…</p>
      </main>
    );
  }
  if (screen === "setup" || screen === "login") {
    return <AuthPanel mode={screen} onAuthenticated={() => setScreen("gallery")} />;
  }
  return <Gallery onLogout={() => void logout()} />;
}
