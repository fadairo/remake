// Doctor: is everything installed and signed in? With --fix, installs what can be installed.
import { chromium } from "playwright";
import { say, ok, warn, step, runCmd } from "./util.mjs";
import { ENGINE_ROOT } from "./project.mjs";

const has = (cmd, args = ["--version"]) => {
  const r = runCmd(cmd, args, { encoding: "utf8" });
  return { ok: !r.error && r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim(), stdout: (r.stdout || "").trim() };
};

export async function doctor({ fix = false } = {}) {
  step("Checking your machine");
  const todo = [];
  const node = Number(process.versions.node.split(".")[0]);
  node >= 20 ? ok(`Node ${process.versions.node}`) : todo.push(["Node 20 or newer", "Install it from https://nodejs.org (the LTS button)."]);

  has("git").ok ? ok("git") : todo.push(["git", "macOS: run `xcode-select --install`. Windows: https://git-scm.com"]);

  let gh = has("gh");
  if (!gh.ok && fix && has("brew").ok) {
    say("  installing GitHub CLI…");
    runCmd("brew", ["install", "gh"], { stdio: "inherit" });
    gh = has("gh");
  }
  if (!gh.ok) todo.push(["GitHub CLI", "macOS: `brew install gh`. Others: https://cli.github.com"]);
  else if (!has("gh", ["auth", "status"]).ok) todo.push(["GitHub sign-in", "Run `gh auth login --web` and click through once in your browser."]);
  else ok("GitHub CLI, signed in");

  const gcloud = has("gcloud");
  if (!gcloud.ok) todo.push(["Google Cloud CLI", "Install it from https://cloud.google.com/sdk/docs/install (macOS: `brew install --cask google-cloud-sdk`)."]);
  else {
    const acct = has("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]);
    const who = acct.ok ? acct.stdout.split("\n")[0] : "";
    who ? ok(`Google Cloud CLI, signed in as ${who}`) : todo.push(["Google Cloud sign-in", "Run `gcloud auth login` and click through once in your browser."]);
    const proj = has("gcloud", ["config", "get-value", "project"]);
    const id = proj.ok ? proj.stdout.split("\n").pop() : "";
    if (who && (!id || id === "(unset)") && !process.env.REMAKE_GCP_PROJECT) todo.push(["Google Cloud project", "Run `gcloud config set project <project-id>`, or pass `--project` to `remake ship`."]);
  }

  let browserOk = false;
  try {
    const b = await chromium.launch();
    await b.close();
    browserOk = true;
  } catch {}
  if (!browserOk && fix) {
    say("  downloading Chromium for Playwright (about 150 MB, once)…");
    runCmd("npx", ["playwright", "install", "chromium"], { stdio: "inherit", cwd: ENGINE_ROOT });
    try {
      const b = await chromium.launch();
      await b.close();
      browserOk = true;
    } catch {}
  }
  browserOk ? ok("Chromium for Playwright") : todo.push(["Chromium for Playwright", "Run `remake doctor --fix`."]);

  if (!todo.length) {
    say("\nREADY: everything Remake needs is installed and signed in.");
    return true;
  }
  say("\nNOT READY:");
  for (const [what, how] of todo) say(`  - ${what}: ${how}`);
  if (!fix) say("\nRun `remake doctor --fix` to install what can be installed automatically.");
  return false;
}
