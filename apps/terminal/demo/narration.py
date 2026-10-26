"""Narration for the product demo: local text-to-speech, the mix, and checks.

Needs the Python venv in services/ai (.venv) with kokoro-onnx, soundfile, numpy and imageio-ffmpeg,
and the Kokoro model files (kokoro-v1.0.onnx and voices-v1.0.bin from the kokoro-onnx releases) in a
folder named by --models or the KOKORO_MODELS environment variable. Everything runs on the CPU; no
network, no paid API.

    PY=services/ai/.venv/Scripts/python      # Windows; services/ai/.venv/bin/python elsewhere
    $PY -I apps/terminal/demo/narration.py synth --models <dir>   # narration.md -> one WAV per cue + durations.json
    $PY -I apps/terminal/demo/narration.py mix                    # recorded video + cue log -> docs/demo.mp4 and docs/demo.webm
    $PY -I apps/terminal/demo/narration.py verify                 # duration, levels, cue onsets, frames to look at

`pnpm --filter @ome/terminal demo` runs `synth` before filming (the spec needs every clip's length
to hold each beat long enough) and `mix` after it. Synthesis is cached: a clip is redone only when its
text, voice or speed changes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
OUT = HERE.parent / "test-results" / "demo"
CLIPS = OUT / "narration"
DOCS = REPO / "docs"
SR = 24_000  # Kokoro's sample rate

# Spellings the phonemizer reads better (the script keeps the usual spelling).
SAY = {r"\bONNX\b": "onyx", r"\bREADME\b": "read-me"}


def ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def cues_from_script(path: Path) -> dict[str, str]:
    """`key` text lines under the scene headings (## ...) of narration.md."""
    cues: dict[str, str] = {}
    in_scenes = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            in_scenes = True
            continue
        m = re.match(r"^`([a-z0-9.-]+)`\s+(.+)$", line.strip())
        if in_scenes and m:
            if m.group(1) in cues:
                raise SystemExit(f"duplicate cue {m.group(1)}")
            cues[m.group(1)] = m.group(2).strip()
    if not cues:
        raise SystemExit(f"no cues in {path}")
    return cues


def trim(samples: np.ndarray, threshold: float = 0.004, pad_s: float = 0.04) -> np.ndarray:
    """Cuts the model's leading and trailing silence, keeping a few milliseconds."""
    loud = np.flatnonzero(np.abs(samples) > threshold)
    if loud.size == 0:
        return samples
    pad = int(pad_s * SR)
    return samples[max(0, loud[0] - pad) : min(len(samples), loud[-1] + pad)]


def synth(args: argparse.Namespace) -> None:
    import soundfile as sf

    models = Path(args.models or os.environ.get("KOKORO_MODELS", ""))
    cues = cues_from_script(HERE / "narration.md")
    CLIPS.mkdir(parents=True, exist_ok=True)
    manifest_path = CLIPS / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {}
    kokoro = None
    for key, text in cues.items():
        spoken = text
        for pattern, repl in SAY.items():
            spoken = re.sub(pattern, repl, spoken)
        digest = hashlib.sha256(f"{args.voice}|{args.speed}|{spoken}".encode()).hexdigest()[:16]
        wav = CLIPS / f"{key}.wav"
        if manifest.get(key, {}).get("hash") == digest and wav.is_file():
            continue
        if kokoro is None:
            if not (models / "kokoro-v1.0.onnx").is_file() or not (models / "voices-v1.0.bin").is_file():
                raise SystemExit(f"Kokoro model files not found in '{models}': pass --models or set KOKORO_MODELS")
            from kokoro_onnx import Kokoro

            kokoro = Kokoro(str(models / "kokoro-v1.0.onnx"), str(models / "voices-v1.0.bin"))
        samples, sr = kokoro.create(spoken, voice=args.voice, speed=args.speed, lang="en-us")
        assert sr == SR, sr
        samples = trim(np.asarray(samples, dtype=np.float32))
        sf.write(wav, samples, SR, subtype="FLOAT")
        manifest[key] = {"hash": digest, "seconds": round(len(samples) / SR, 3), "words": len(text.split()), "text": text}
        print(f"{key}: {len(samples) / SR:.2f} s", flush=True)
    for key in list(manifest):
        if key not in cues:
            del manifest[key]
    manifest_path.write_text(json.dumps(manifest, indent=1))
    durations = {k: manifest[k]["seconds"] for k in cues}
    (CLIPS / "durations.json").write_text(json.dumps(durations, indent=1))
    total = sum(durations.values())
    words = sum(manifest[k]["words"] for k in cues)
    print(f"{len(cues)} clips (variants included), {total:.1f} s, {words} words, {60 * words / total:.0f} words/min")


def load_cue_log(path: Path) -> dict:
    log = json.loads(path.read_text())
    return log


def build_track(log: dict) -> np.ndarray:
    import soundfile as sf

    seconds = float(log["seconds"])
    track = np.zeros(int(round(seconds * SR)), dtype=np.float32)
    clips = []
    for cue in log["cues"]:
        samples, sr = sf.read(CLIPS / f"{cue['key']}.wav", dtype="float32")
        assert sr == SR
        clips.append((cue, samples))
    # One gain for every clip: speech at about -19 dBFS RMS, peaks below -1 dBFS.
    speech = np.concatenate([s[np.abs(s) > 0.01] for _, s in clips])
    gain = 10 ** (-19 / 20) / float(np.sqrt(np.mean(speech**2)))
    gain = min(gain, 0.89 / float(max(np.max(np.abs(s)) for _, s in clips)))
    fade = int(0.008 * SR)
    ramp = np.linspace(0, 1, fade, dtype=np.float32)
    end_prev = 0
    for cue, samples in clips:
        s = samples * gain
        s[:fade] *= ramp
        s[-fade:] *= ramp[::-1]
        start = int(round(float(cue["at"]) * SR))
        if start < end_prev:
            print(f"warning: {cue['key']} at {cue['at']:.2f} s overlaps the clip before by {(end_prev - start) / SR:.2f} s")
        if start + len(s) > len(track):
            print(f"warning: {cue['key']} runs {(start + len(s) - len(track)) / SR:.2f} s past the end; cut")
            s = s[: max(0, len(track) - start)]
        track[start : start + len(s)] += s
        end_prev = start + len(s)
    return track


def mix(args: argparse.Namespace) -> None:
    import soundfile as sf

    video = Path(args.video)
    log = load_cue_log(Path(args.cues))
    track = build_track(log)
    wav = OUT / "narration-mix.wav"
    sf.write(wav, track, SR, subtype="PCM_16")
    seconds = f"{float(log['seconds']):.3f}"
    ff = ffmpeg()
    outputs = {
        Path(args.mp4): ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-profile:v", "high",
                         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"],
        Path(args.webm): ["-c:v", "copy", "-c:a", "libopus", "-b:a", "96k"],
    }
    for target, codec in outputs.items():
        tmp = target.with_name(f".{target.stem}.tmp{target.suffix}")
        cmd = [ff, "-y", "-hide_banner", "-loglevel", "error", "-i", str(video), "-i", str(wav), "-map", "0:v:0", "-map", "1:a:0",
               *codec, "-ar", "48000", "-ac", "2", "-t", seconds, str(tmp)]
        subprocess.run(cmd, check=True)
        os.replace(tmp, target)
        print(f"{target}: {target.stat().st_size / 1e6:.1f} MB")


def decode_audio(path: Path) -> np.ndarray:
    raw = subprocess.run([ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def probe(path: Path) -> str:
    r = subprocess.run([ffmpeg(), "-hide_banner", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True)
    keep = [l.strip() for l in r.stderr.splitlines() if re.search(r"Duration|Stream #|mean_volume|max_volume", l)]
    return "\n  ".join(keep)


def db(x: np.ndarray) -> float:
    return 20 * np.log10(max(1e-9, float(np.sqrt(np.mean(x**2))) if x.size else 1e-9))


def verify(args: argparse.Namespace) -> None:
    log = load_cue_log(Path(args.cues))
    ok = True
    for f in [Path(p) for p in args.files]:
        print(f"{f} ({f.stat().st_size / 1e6:.1f} MB)\n  {probe(f)}")
    audio = decode_audio(Path(args.files[0]))
    print(f"\naudio {len(audio) / SR:.2f} s vs video log {float(log['seconds']):.2f} s; overall {db(audio):.1f} dBFS RMS")
    scenes = {s["name"]: s for s in log["scenes"]}
    win = int(0.02 * SR)
    env = np.sqrt(np.convolve(audio**2, np.ones(win) / win, mode="same"))
    print("\ncue                      at (s)   onset (s)  clip end  scene window       level")
    for cue in log["cues"]:
        at = float(cue["at"])
        lo = int(max(0, at - 0.25) * SR)
        hi = int((at + 0.6) * SR)
        loud = np.flatnonzero(env[lo:hi] > 10 ** (-42 / 20))
        onset = (lo + loud[0]) / SR if loud.size else float("nan")
        end = at + float(cue["seconds"])
        sc = scenes.get(cue["scene"])
        inside = sc is not None and sc["start"] - 0.05 <= at and end <= sc["end"] + 0.05
        level = db(audio[int(at * SR) : int(end * SR)])
        good = loud.size > 0 and abs(onset - at) < 0.15 and inside and level > -35
        ok &= good
        print(f"{cue['key']:<24} {at:7.2f}  {onset:9.2f}  {end:8.2f}  {sc['start']:6.1f}-{sc['end']:6.1f}  {level:6.1f} dB  {'ok' if good else 'CHECK'}")
    # Silence where no clip plays (well away from every clip): the track is narration only.
    mask = np.ones(len(audio), dtype=bool)
    for cue in log["cues"]:
        mask[max(0, int((float(cue["at"]) - 0.3) * SR)) : int((float(cue["at"]) + float(cue["seconds"]) + 0.3) * SR)] = False
    print(f"\nbetween clips: {db(audio[mask]):.1f} dBFS RMS over {mask.sum() / SR:.1f} s")
    if args.frames:
        out = Path(args.frames)
        out.mkdir(parents=True, exist_ok=True)
        for cue in log["cues"]:
            t = float(cue["at"]) + min(2.0, float(cue["seconds"]) / 2)
            subprocess.run([ffmpeg(), "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", args.files[0], "-frames:v", "1",
                            "-vf", "scale=960:-1", str(out / f"{t:06.1f}-{cue['key']}.jpg")], check=True)
        print(f"frames at each cue in {out}")
    print("\nall cues ok" if ok else "\nsome cues need a look")
    if not ok:
        sys.exit(1)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("synth")
    s.add_argument("--models")
    s.add_argument("--voice", default="af_heart")
    s.add_argument("--speed", type=float, default=0.94)
    m = sub.add_parser("mix")
    m.add_argument("--video", default=str(OUT / "demo.webm"))
    m.add_argument("--cues", default=str(OUT / "narration-cues.json"))
    m.add_argument("--mp4", default=str(DOCS / "demo.mp4"))
    m.add_argument("--webm", default=str(DOCS / "demo.webm"))
    v = sub.add_parser("verify")
    v.add_argument("files", nargs="*", default=[str(DOCS / "demo.mp4"), str(DOCS / "demo.webm")])
    v.add_argument("--cues", default=str(OUT / "narration-cues.json"))
    v.add_argument("--frames", help="folder for one frame per cue")
    a = p.parse_args()
    {"synth": synth, "mix": mix, "verify": verify}[a.cmd](a)


if __name__ == "__main__":
    main()
