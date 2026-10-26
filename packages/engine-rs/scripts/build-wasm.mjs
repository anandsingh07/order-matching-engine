// Rebuilds wasm/engine.wasm from rust/. Only needed after changing the Rust
// source: the built file is committed, so using the package needs no Rust
// toolchain. Needs rustup with `rustup target add wasm32-unknown-unknown`.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The committed wasm can be rebuilt byte for byte only with the compiler
// release that built it: std's panic locations embed that release's commit
// hash, and codegen changes between releases. This is not a
// rust-toolchain.toml on purpose. rustup resolves such a pin for its default
// host, so on a machine whose default host is -gnu and whose stable is -msvc
// (this one), any cargo command in rust/ silently downloaded a second copy of
// the same release. Here an installed toolchain of the release is used under
// whatever name it has, and any other compiler still builds, with a warning.
const PINNED_RUSTC = "1.99.1";

const root = fileURLToPath(new URL("..", import.meta.url));
const crate = join(root, "rust");
// rustup installs its tools here, which a fresh Windows shell often lacks on PATH.
const tool = (name) => {
  const installed = join(homedir(), ".cargo", "bin", process.platform === "win32" ? `${name}.exe` : name);
  return existsSync(installed) ? installed : name;
};
// Run from rust/, so that cargo finds .cargo/config.toml.
const output = (command, args, env = process.env) => execFileSync(command, args, { cwd: crate, env, encoding: "utf8" }).trim();

const env = { ...process.env };
if (env.RUSTUP_TOOLCHAIN === undefined) {
  const rustcOf = (toolchain) => {
    try {
      return output(tool("rustup"), ["run", toolchain, "rustc", "--version"]);
    } catch {
      return "";
    }
  };
  let toolchains = [];
  try {
    toolchains = output(tool("rustup"), ["toolchain", "list"]).split(/\r?\n/).map((line) => line.split(" ")[0]);
  } catch {
    // No rustup: cargo on PATH builds with its own rustc, and the check below says if it is not the pinned one.
  }
  const same = toolchains.find((toolchain) => rustcOf(toolchain).startsWith(`rustc ${PINNED_RUSTC} `));
  if (same !== undefined) env.RUSTUP_TOOLCHAIN = same;
}
if (env.RUSTFLAGS !== undefined || env.CARGO_ENCODED_RUSTFLAGS !== undefined) {
  console.warn("RUSTFLAGS is set. It replaces the flags in rust/.cargo/config.toml, so the wasm will not match the committed one.");
}

// No crates.io dependencies, so nothing runs on the host: rust-lld links the
// wasm directly, and no native linker (MSVC or otherwise) is needed.
execFileSync(tool("cargo"), ["build", "--release", "--target", "wasm32-unknown-unknown"], { cwd: crate, env, stdio: "inherit" });

const rustc = output(tool("rustc"), ["--version"], env);
const built = join(crate, "target", "wasm32-unknown-unknown", "release", "ome_engine.wasm");
mkdirSync(join(root, "wasm"), { recursive: true });
copyFileSync(built, join(root, "wasm", "engine.wasm"));
console.log(`wasm/engine.wasm: ${statSync(join(root, "wasm", "engine.wasm")).size.toLocaleString("en-US")} bytes, built with ${rustc}`);
if (!rustc.startsWith(`rustc ${PINNED_RUSTC} `)) {
  console.warn(`The committed wasm was built with rustc ${PINNED_RUSTC}. This one works, but its bytes differ.`);
}
