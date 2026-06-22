import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent } from "react";
import { ApiError, api, uploadImage } from "./api";
import type { ImageItem, ImageStatus } from "./types";

type Screen = "loading" | "setup" | "login" | "gallery";

interface UploadEntry {
  id: string;
  name: string;
  progress: number;
  state: "uploading" | "done" | "error";
  message?: string;
}

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
};

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

function statusText(status: ImageStatus): string {
  return {
    pending: "等待转换",
    processing: "正在转换",
    ready: "转换完成",
    partial: "部分完成",
    failed: "转换失败",
  }[status];
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
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand brand-auth">
          <span className="brand-mark" aria-hidden="true">B</span>
          <span>BoomImage</span>
        </div>
        <p className="eyebrow">PRIVATE IMAGE VAULT</p>
        <h1>{isSetup ? "创建你的私人图床" : "欢迎回来"}</h1>
        <p className="auth-intro">
          {isSetup ? "设置管理员密码后，就可以开始上传和自动转换图片。" : "输入管理员密码进入图片管理台。"}
        </p>
        <form onSubmit={submit} className="auth-form">
          <label>
            管理员密码
            <input
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
            <label>
              确认密码
              <input
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
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button" disabled={submitting}>
            {submitting ? "请稍候…" : isSetup ? "初始化 BoomImage" : "登录"}
          </button>
        </form>
        <p className="auth-note">密码只在本机以 Argon2id 哈希保存</p>
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
      className={`upload-zone${dragging ? " is-dragging" : ""}`}
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
      <button className="upload-trigger" onClick={() => inputRef.current?.click()}>
        <span className="upload-icon" aria-hidden="true">↑</span>
        <span><strong>拖入图片</strong>，或点击选择文件</span>
        <small>JPEG、PNG、WebP、GIF、AVIF · 自动生成现代格式</small>
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

  return (
    <article className="image-card">
      <div className="image-preview">
        <img src={thumbnail?.url ?? image.originalUrl} alt={image.originalName} loading="lazy" />
        <span className={`status-badge status-${image.status}`}>{statusText(image.status)}</span>
      </div>
      <div className="image-info">
        <h3 title={image.originalName}>{image.originalName}</h3>
        <p>{image.width} × {image.height} <span>·</span> {formatBytes(image.sizeBytes)}</p>
        <div className="format-row">
          <span>原图</span>
          {image.variants.filter((variant) => variant.status === "ready").map((variant) => (
            <span key={`${variant.profile}-${variant.format}`}>{variant.profile === "thumb" ? "缩略" : "展示"} {variant.format.toUpperCase()}</span>
          ))}
        </div>
        <div className="card-actions">
          <button onClick={() => onCopy(preferredUrl, "图片链接")}>复制链接</button>
          <button onClick={() => onCopy(markdown, "Markdown")}>Markdown</button>
          <button onClick={() => onCopy(html, "HTML")}>HTML</button>
          {image.status === "failed" || image.status === "partial" ? (
            <button onClick={onRetry}>重新转换</button>
          ) : image.status === "ready" ? (
            <button className="danger-action" onClick={onDelete}>删除</button>
          ) : (
            <button disabled>转换中</button>
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
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="token-panel" role="dialog" aria-modal="true" aria-labelledby="token-title">
        <div className="panel-heading"><div><p className="eyebrow">API ACCESS</p><h2 id="token-title">个人访问令牌</h2></div><button className="quiet-button" onClick={onClose}>关闭</button></div>
        <p className="panel-intro">用于 PicGo、命令行或其他上传客户端。令牌只在创建时显示一次。</p>
        <form className="token-form" onSubmit={create}>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="令牌名称，例如 PicGo" required />
          <button className="primary-button">创建令牌</button>
        </form>
        {rawToken && (
          <div className="token-reveal">
            <strong>请立即保存</strong><code>{rawToken}</code>
            <button onClick={() => void navigator.clipboard.writeText(rawToken)}>复制令牌</button>
          </div>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="token-list">
          {tokens.length === 0 ? <p>尚未创建令牌</p> : tokens.map((token) => (
            <div className={token.revokedAt ? "token-row revoked" : "token-row"} key={token.id}>
              <div><strong>{token.name}</strong><span>{token.revokedAt ? "已撤销" : token.lastUsedAt ? `最近使用 ${new Date(token.lastUsedAt).toLocaleDateString()}` : "从未使用"}</span></div>
              {!token.revokedAt && <button className="danger-link" onClick={() => void api.revokeToken(token.id).then(load).catch((cause) => setError(friendlyError(cause)))}>撤销</button>}
            </div>
          ))}
        </div>
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
        const result = await uploadImage(file, (progress) => {
          setUploads((current) => current.map((entry) => entry.id === id ? { ...entry, progress } : entry));
        });
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
    <div className="app-shell" onPaste={pasteImages}>
      <header className="topbar">
        <div className="brand"><span className="brand-mark">B</span><span>BoomImage</span></div>
        <div className="topbar-meta"><span className="health-dot" /> 本地服务正常</div>
        <div className="topbar-actions"><button className="quiet-button" onClick={() => setTokensOpen(true)}>API Token</button><button className="quiet-button" onClick={onLogout}>退出</button></div>
      </header>
      <main className="content">
        <section className="hero-row">
          <div>
            <p className="eyebrow">IMAGE LIBRARY</p>
            <h1>你的图片，轻装上阵。</h1>
            <p>上传一次，自动生成 AVIF 与 WebP。原图始终保留。</p>
          </div>
          <div className="library-count"><strong>{images.length}</strong><span>张图片</span></div>
        </section>
        <UploadZone onFiles={(files) => void addFiles(files)} />
        {uploads.length > 0 && (
          <section className="upload-list" aria-live="polite">
            {uploads.map((entry) => (
              <div className={`upload-item ${entry.state}`} key={entry.id}>
                <span className="upload-name">{entry.name}</span>
                <div className="progress-track"><span style={{ width: `${entry.progress}%` }} /></div>
                <span>{entry.message ?? `${entry.progress}%`}</span>
              </div>
            ))}
          </section>
        )}
        <section className="library-heading">
          <h2>最近上传</h2>
          <button className="quiet-button" onClick={() => void refresh()}>刷新</button>
        </section>
        {error && <p className="page-error" role="alert">{error}</p>}
        {loading ? (
          <div className="empty-state">正在读取图片库…</div>
        ) : images.length === 0 ? (
          <div className="empty-state"><strong>这里还很安静</strong><span>上传第一张图片，转换结果会出现在这里。</span></div>
        ) : (
          <section className="image-grid">
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
      {toast && <div className="toast" role="status">✓ {toast}</div>}
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
    return <main className="loading-screen"><span className="brand-mark">B</span><p>正在唤醒 BoomImage…</p></main>;
  }
  if (screen === "setup" || screen === "login") {
    return <AuthPanel mode={screen} onAuthenticated={() => setScreen("gallery")} />;
  }
  return <Gallery onLogout={() => void logout()} />;
}
