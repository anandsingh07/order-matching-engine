// Helpers for the demo recording (demo.spec.ts): a multi-camera recorder, the narration cues, the
// on-screen captions, and the exchange processes (gateway, bots, actors) the spec starts and stops.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";

export const REPO = resolve(__dirname, "../../..");
export const OUT = resolve(__dirname, "../test-results/demo");

// ---------------------------------------------------------------------------------------------
// Recorder: every camera (page) streams JPEG frames through Playwright's screencast API. While
// rolling, the frame of the camera on air is appended at a fixed 25 fps locked to the wall clock,
// so cutting between cameras is a hard cut and pausing removes time. At the end the frames are
// encoded with Playwright's own ffmpeg (VP9 webm; it has no H.264 or GIF).
// ---------------------------------------------------------------------------------------------

export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? "", "ms-playwright")
      : process.platform === "darwin"
        ? join(homedir(), "Library/Caches/ms-playwright")
        : join(homedir(), ".cache/ms-playwright"));
  const dir = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith("ffmpeg-")).sort().at(-1) : undefined;
  if (dir === undefined) throw new Error("Playwright's ffmpeg is missing: pnpm exec playwright install ffmpeg (or set FFMPEG_PATH)");
  const exe = process.platform === "win32" ? "ffmpeg-win64.exe" : process.platform === "darwin" ? "ffmpeg-mac" : "ffmpeg-linux";
  return join(root, dir, exe);
}

export class Director {
  private latest = new Map<Page, Buffer>();
  private frames: Buffer[] = [];
  private onAir: Page | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private rolledAt = 0;
  private framesAtRoll = 0;
  readonly scenes: { name: string; start: number; end: number }[] = [];
  /** The scene being filmed, for the narration log. */
  current = "";
  readonly cameras: Page[] = [];

  constructor(
    readonly fps = 25,
    readonly size = { width: 1440, height: 900 },
  ) {}

  async addCamera(page: Page): Promise<void> {
    let first!: () => void;
    const got = new Promise<void>((r) => (first = r));
    await page.screencast.start({
      size: this.size,
      quality: 90,
      onFrame: ({ data }) => {
        this.latest.set(page, data);
        first();
      },
    });
    // An animated mouse pointer for clicks; the developer-facing action title is hidden.
    await page.screencast.showActions({ cursor: "pointer", duration: 700, style: { title: "display: none" } });
    this.cameras.push(page);
    await Promise.race([got, new Promise((r) => setTimeout(r, 5_000))]);
  }

  /** Puts a camera on air (a hard cut). */
  cut(page: Page): void {
    this.pump();
    this.onAir = page;
  }

  get page(): Page {
    if (this.onAir === null) throw new Error("no camera on air");
    return this.onAir;
  }

  roll(): void {
    if (this.timer !== undefined) return;
    this.rolledAt = performance.now();
    this.framesAtRoll = this.frames.length;
    this.timer = setInterval(() => this.pump(), 10);
  }

  pause(): void {
    this.pump();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get rolling(): boolean {
    return this.timer !== undefined;
  }

  private pump(): void {
    if (this.timer === undefined || this.onAir === null) return;
    const frame = this.latest.get(this.onAir);
    if (frame === undefined) return;
    const due = this.framesAtRoll + Math.floor(((performance.now() - this.rolledAt) * this.fps) / 1000);
    while (this.frames.length < due) this.frames.push(frame);
  }

  /** Runs one scene. A failed optional scene is cut out of the video; a failed core scene fails the run. */
  async scene(name: string, body: () => Promise<void>, optional = false): Promise<boolean> {
    const start = this.frames.length;
    const began = performance.now();
    this.current = name;
    try {
      await body();
      this.pump();
      this.scenes.push({ name, start: start / this.fps, end: this.frames.length / this.fps });
      console.log(`scene ${name}: ${((this.frames.length - start) / this.fps).toFixed(1)} s of video (${((performance.now() - began) / 1000).toFixed(1)} s wall)`);
      return true;
    } catch (error) {
      this.pause();
      for (const p of this.cameras) await p.screenshot({ path: join(OUT, `failed-${name}-${this.cameras.indexOf(p)}.png`) }).catch(() => {});
      if (!optional) throw error;
      this.frames.length = start;
      console.warn(`dropped optional scene ${name}: ${String(error)}`);
      return false;
    }
  }

  seconds(): number {
    return this.frames.length / this.fps;
  }

  /** Index of the frame at a time in the video, for stills. */
  frameAt(seconds: number): Buffer | undefined {
    return this.frames[Math.min(this.frames.length - 1, Math.round(seconds * this.fps))];
  }

  async stopCameras(): Promise<void> {
    this.pause();
    for (const p of this.cameras) await p.screencast.stop().catch(() => {});
  }

  async encode(out: string, crf = 32): Promise<void> {
    const ff = spawn(
      ffmpegPath(),
      [
        "-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(this.fps), "-i", "pipe:0",
        "-y", "-an", "-c:v", "libvpx-vp9", "-crf", String(crf), "-b:v", "0", "-deadline", "good", "-cpu-used", "2", "-row-mt", "1",
        "-pix_fmt", "yuv420p", "-vf", `scale=${this.size.width}:${this.size.height}`, out,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    for (const f of this.frames) if (!ff.stdin.write(f)) await once(ff.stdin, "drain");
    ff.stdin.end();
    const [code] = (await once(ff, "close")) as [number];
    if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
  }
}

/** Converts one JPEG frame to PNG with the bundled ffmpeg. */
export async function writePng(jpeg: Buffer, out: string): Promise<void> {
  const ff = spawn(ffmpegPath(), ["-loglevel", "error", "-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0", "-y", "-frames:v", "1", out], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  ff.stdin.end(jpeg);
  const [code] = (await once(ff, "close")) as [number];
  if (code !== 0) throw new Error(`ffmpeg exited ${code} writing ${out}`);
}

// ---------------------------------------------------------------------------------------------
// On-screen captions and highlights: plain divs injected into the page with page.evaluate. They
// ignore the pointer, so they never block a click.
// ---------------------------------------------------------------------------------------------

export type Where = "low" | "high" | "top-right";

/** Shows a caption on every camera (so it survives a cut); an empty text removes it. */
export async function caption(pages: Page[], text: string, where: Where = "low"): Promise<void> {
  await Promise.all(
    pages.map((p) =>
      p
        .evaluate(
          ({ text, where }) => {
            let el = document.getElementById("demo-caption");
            if (text === "") {
              el?.remove();
              return;
            }
            if (el === null) {
              el = document.createElement("div");
              el.id = "demo-caption";
              document.documentElement.appendChild(el);
            }
            const place =
              where === "high" ? "top:104px;left:24px;" : where === "top-right" ? "top:10px;right:24px;" : "bottom:262px;left:24px;";
            el.setAttribute(
              "style",
              `position:fixed;${place}z-index:2147483646;max-width:760px;pointer-events:none;` +
                "background:#ffe600;color:#111111;border:3px solid #111111;border-radius:3px;" +
                "padding:10px 16px;font:700 21px/1.38 system-ui,-apple-system,'Segoe UI',sans-serif;" +
                "box-shadow:6px 6px 0 0 #111111;",
            );
            el.textContent = text;
          },
          { text, where },
        )
        .catch(() => {}),
    ),
  );
}

/** Dims everything but one element for `ms` (also the reading hold). */
export async function spotlight(page: Page, target: Locator, ms = 2_500): Promise<void> {
  const box = await target.boundingBox({ timeout: 5_000 });
  if (box === null) throw new Error(`spotlight: ${String(target)} is not visible`);
  await page.evaluate((b) => {
    document.getElementById("demo-spot")?.remove();
    const el = document.createElement("div");
    el.id = "demo-spot";
    const pad = 4;
    el.setAttribute(
      "style",
      `position:fixed;left:${b.x - pad}px;top:${b.y - pad}px;width:${b.width + 2 * pad}px;height:${b.height + 2 * pad}px;` +
        "border:4px solid #111111;border-radius:3px;box-shadow:0 0 0 4px #ff5c8a,0 0 0 9999px rgba(17,17,17,.36);pointer-events:none;z-index:2147483645;",
    );
    document.documentElement.appendChild(el);
  }, box);
  await hold(ms);
  await page.evaluate(() => document.getElementById("demo-spot")?.remove()).catch(() => {});
}

/** A small "+12 s" tag, top right, where time was cut out. */
export async function badge(page: Page, text: string, ms = 1_400): Promise<void> {
  await page.evaluate((text) => {
    const el = document.createElement("div");
    el.id = "demo-badge";
    el.setAttribute(
      "style",
      "position:fixed;top:60px;right:24px;z-index:2147483646;pointer-events:none;background:#4dd8ff;color:#111111;" +
        "border:2px solid #111111;box-shadow:3px 3px 0 0 #111111;border-radius:3px;padding:4px 12px;font:700 15px system-ui,'Segoe UI',sans-serif;",
    );
    el.textContent = text;
    document.documentElement.appendChild(el);
  }, text);
  await hold(ms);
  await page.evaluate(() => document.getElementById("demo-badge")?.remove()).catch(() => {});
}

/** Visible typing. */
export async function typeSlowly(target: Locator, text: string, delay = 70): Promise<void> {
  await target.click();
  await target.fill("");
  await target.pressSequentially(text, { delay });
}

/** A reading pause. The only plain timer in the demo: every state is waited for with expect(). */
export function hold(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------------------------
// Narration: one pre-synthesized clip per cue (narration.md, narration.py). The spec cues a clip
// when the beat it describes starts; the clip is laid into the video at that moment by
// `narration.py mix`, from the cue log written here. Times are video seconds, so time cut out of
// the video (Director.pause) is cut out of the narration timeline too.
// ---------------------------------------------------------------------------------------------

export const NARRATION = join(OUT, "narration");

/** The venv Python that runs narration.py (services/ai/.venv, with kokoro-onnx and imageio-ffmpeg). */
export function narrationPython(): string {
  return join(REPO, "services/ai/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

/** Runs `narration.py <args>` and fails on a non-zero exit. */
export function runNarration(args: string[]): void {
  const python = narrationPython();
  if (!existsSync(python)) throw new Error(`narration needs the Python venv in services/ai (.venv): ${python} is missing`);
  const r = spawnSync(python, ["-I", join(__dirname, "narration.py"), ...args], { stdio: "inherit", windowsHide: true });
  if (r.status !== 0) throw new Error(`narration.py ${args[0]} exited ${r.status ?? r.error}`);
}

export interface Cue {
  key: string;
  scene: string;
  at: number;
  seconds: number;
}

export class Narrator {
  readonly cues: Cue[] = [];
  private until = 0;
  private readonly durations: Record<string, number>;

  /** `gap`: the pause after each clip before the next one may start. */
  constructor(
    private readonly d: Director,
    readonly gap = 0.35,
  ) {
    this.durations = JSON.parse(readFileSync(join(NARRATION, "durations.json"), "utf8")) as Record<string, number>;
  }

  /** Starts a clip: waits until the one before it (and its gap) is over, then cues it now. */
  async say(key: string): Promise<void> {
    const seconds = this.durations[key];
    if (seconds === undefined) throw new Error(`no narration clip ${key}: run narration.py synth`);
    await this.wait();
    const at = this.d.seconds();
    this.cues.push({ key, scene: this.d.current, at, seconds });
    this.until = at + seconds + this.gap;
  }

  /** Holds the picture until the current clip is over, plus `extra` seconds. */
  async wait(extra = 0): Promise<void> {
    for (;;) {
      const left = this.until + extra - this.d.seconds();
      if (left <= 0) return;
      if (!this.d.rolling) throw new Error("narration: waiting for a clip while the camera is paused");
      await hold(Math.min(250, left * 1000 + 5));
    }
  }

  /** Milliseconds of the current clip still to play (at least `min`): a hold that ends with the sentence. */
  leftMs(min = 1_200): number {
    return Math.max(min, Math.round((this.until - this.gap - this.d.seconds()) * 1000));
  }
}

// ---------------------------------------------------------------------------------------------
// The exchange: gateway, bots and actors as child processes, plus REST helpers.
// ---------------------------------------------------------------------------------------------

export class Market {
  private children: { name: string; child: ChildProcess }[] = [];
  readonly url: string;

  constructor(readonly port: number) {
    this.url = `http://127.0.0.1:${port}`;
    mkdirSync(OUT, { recursive: true });
  }

  private start(name: string, cwd: string, args: string[], env: Record<string, string> = {}): void {
    const outFd = openSync(join(OUT, `${name}.log`), "w");
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", outFd, outFd],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.children.push({ name, child });
  }

  async startGateway(env: Record<string, string>): Promise<void> {
    if (await portOpen(this.port)) throw new Error(`port ${this.port} is in use`);
    this.start("gateway", join(REPO, "services/gateway"), ["src/main.ts"], { PORT: String(this.port), HOST: "127.0.0.1", ...env });
    await this.waitFor(async () => (await this.get<{ status: string }>("/api/health")).status === "ok", 60_000, "gateway health");
  }

  startBots(args: string[]): void {
    this.start("bots", join(REPO, "services/bots"), ["src/main.ts", `--url=${this.url}`, ...args]);
  }

  startActors(args: string[]): void {
    this.start("actors", join(REPO, "services/bots"), [join(REPO, "apps/terminal/demo/actors.mts"), `--url=${this.url}`, ...args]);
  }

  stop(): void {
    for (const { name, child } of this.children.reverse()) {
      if (child.pid === undefined || child.exitCode !== null) continue;
      try {
        if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
        else process.kill(-child.pid, "SIGINT");
      } catch (error) {
        console.warn(`could not stop ${name}: ${String(error)}`);
      }
    }
    this.children = [];
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.url}${path}`);
    if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
    return (await response.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`POST ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  /** Polls until `probe` is truthy, with a named timeout. */
  async waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs: number, what: string): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    for (;;) {
      try {
        const v = await probe();
        if (v !== null && v !== undefined && v !== false) return v;
      } catch (error) {
        last = error;
      }
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}${last ? ` (${String(last)})` : ""}`);
      await hold(500);
    }
  }

  status(symbol: string): Promise<Status> {
    return this.get<Status[]>("/api/status").then((all) => all.find((s) => s.symbol === symbol)!);
  }

  book(symbol: string, levels = 20): Promise<Book> {
    return this.get<Book>(`/api/book/${encodeURIComponent(symbol)}?levels=${levels}`);
  }

  trades(symbol: string): Promise<{ price: number; time: number }[]> {
    return this.get(`/api/trades/${encodeURIComponent(symbol)}`);
  }
}

export interface Status {
  symbol: string;
  phase: string;
  reason: string | null;
  referencePrice: number;
  bandPct: number;
  breakerPct: number | null;
  volatility: { sigmaPct: number; horizonMinutes: number; model: string } | null;
}

export interface Book {
  bids: { price: number; quantity: number }[];
  asks: { price: number; quantity: number }[];
}

export interface Instrument {
  symbol: string;
  priceScale: number;
  quantityScale: number;
  tickSize: number;
  referencePrice: number;
  underlying?: string;
  strike?: number;
  right?: "call" | "put";
  expiry?: number;
}

export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** A price in ticks as the terminal formats it: no thousands separator, the instrument's decimals. */
export function fmtPrice(i: Pick<Instrument, "priceScale">, ticks: number): string {
  return (ticks / i.priceScale).toFixed(Math.round(Math.log10(i.priceScale)));
}
