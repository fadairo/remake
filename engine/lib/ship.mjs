// Ship: a private GitHub repo and a live Google Cloud Run site behind a passcode, then check the gate works.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { copyTemplates } from "./project.mjs";
import { RemakeError, say, ok, warn, step, readJson, writeJson, runCmd } from "./util.mjs";

const DEFAULT_REGION = "us-central1";
const APIS = ["run.googleapis.com", "cloudbuild.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com"];

export function sh(cmd, args, { cwd, input, allowFail = false } = {}) {
  const r = runCmd(cmd, args, { cwd, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.error) {
    if (allowFail) return { ok: false, out: r.error.message, code: -1 };
    throw new RemakeError(`${cmd} isn't installed.`, "Run `remake doctor --fix`.");
  }
  if (r.status !== 0 && !allowFail) throw new RemakeError(`${cmd} ${args.join(" ")} failed:\n${out.trim().slice(-1500)}`);
  return { ok: r.status === 0, out, stdout: r.stdout || "", code: r.status };
}

// Cloud Run service and secret names: lowercase letters, digits and hyphens, starting with a letter.
function serviceName(name) {
  const n = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return /^[a-z]/.test(n) ? n : `remake-${n}`.slice(0, 40).replace(/-+$/g, "");
}

function gcloud(args, opts = {}) {
  return sh("gcloud", args, opts);
}

function makePasscode(name) {
  const word = name.replace(/[^a-z]/gi, "").toUpperCase().slice(0, 8) || "REMAKE";
  return `${word}-${crypto.randomBytes(6).toString("base64url")}`;
}

export async function verifyGate(url, passcode, pagePath = "/") {
  const res = { url, gate: false, unlock: false, page: false, noindex: false };
  try {
    const a = await fetch(url, { redirect: "manual" });
    const body = await a.text();
    res.gate = a.status === 401 && body.includes("data-remake-gate");
    res.noindex = /noindex/i.test(a.headers.get("x-robots-tag") || "");
    const form = new URLSearchParams({ passcode, next: "/" });
    const b = await fetch(new URL("/_remake/gate", url), {
      method: "POST",
      body: form,
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const cookie = (b.headers.get("set-cookie") || "").split(";")[0];
    res.unlock = b.status === 303 && cookie.startsWith("remake_pass=");
    if (res.unlock) {
      const c = await fetch(new URL(pagePath, url), { headers: { cookie }, redirect: "manual" });
      const html = await c.text();
      res.page = c.status === 200 && !html.includes("data-remake-gate");
    }
  } catch (e) {
    res.error = e.message;
  }
  return res;
}

export async function ship(proj, opts = {}) {
  const { cfg, p, root } = proj;
  const score = readJson(p.score);
  if (!score) warn("No score yet: shipping anyway, but the report won't pass until `remake score` passes.");
  else if (!score.pass) warn("The score doesn't pass yet. Shipping anyway so you can look at it; the report will say what's left.");
  copyTemplates(root, { name: cfg.name, url: cfg.url });
  // A remade page that isn't the home page (/en, /about/): send the site's root to it.
  const first = cfg.pages?.[0] || "/";
  if (first !== "/" && !fs.existsSync(path.join(p.site, "index.html"))) {
    fs.writeFileSync(path.join(p.site, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><meta http-equiv="refresh" content="0;url=${first}"><link rel="canonical" href="${first}"><title>Redirecting</title><a href="${first}">Continue</a>`);
  }
  const prev = readJson(p.ship, {}) || {};
  const name = opts.name || prev.name || `remake-${cfg.name}`.slice(0, 90);
  const passcode = opts.passcode || prev.passcode || makePasscode(cfg.name);
  const service = serviceName(name);
  const secret = `${service}-passcode`;

  step("Checking you're signed in to GitHub and Google Cloud");
  if (!sh("gh", ["auth", "status"], { allowFail: true }).ok) {
    throw new RemakeError("GitHub CLI isn't signed in.", "Run `gh auth login --web` and click through once in your browser.");
  }
  const account = gcloud(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], { allowFail: true });
  if (!account.ok || !account.stdout.trim()) {
    throw new RemakeError("The gcloud CLI isn't signed in.", "Run `gcloud auth login` and click through once in your browser.");
  }
  const project = opts.project || process.env.REMAKE_GCP_PROJECT || prev.project || gcloud(["config", "get-value", "project"], { allowFail: true }).stdout.trim();
  if (!project || project === "(unset)") {
    throw new RemakeError("No Google Cloud project chosen.", "Run `remake ship --project <project-id>`, or set REMAKE_GCP_PROJECT.");
  }
  const region = opts.region || process.env.REMAKE_GCP_REGION || prev.region || DEFAULT_REGION;
  ok(`GitHub and Google Cloud (${account.stdout.trim().split("\n")[0]}, project ${project}, ${region})`);

  step("Saving to a private GitHub repo");
  if (!fs.existsSync(path.join(root, ".git"))) sh("git", ["init", "-b", "main"], { cwd: root });
  // A commit needs an author. Without one set on this machine, use the GitHub account's.
  if (!sh("git", ["config", "user.email"], { cwd: root, allowFail: true }).stdout.trim()) {
    const me = JSON.parse(sh("gh", ["api", "user"], { allowFail: true }).stdout || "{}");
    const email = me.email || (me.id && me.login ? `${me.id}+${me.login}@users.noreply.github.com` : "remake@users.noreply.github.com");
    sh("git", ["config", "user.email", email], { cwd: root });
    sh("git", ["config", "user.name", me.name || me.login || "Remake"], { cwd: root });
  }
  sh("git", ["add", "-A"], { cwd: root });
  const dirty = !sh("git", ["diff", "--cached", "--quiet"], { cwd: root, allowFail: true }).ok;
  if (dirty) sh("git", ["commit", "-m", `Remake of ${cfg.url}`, "-m", "Made with https://github.com/rubenhassid1/remake"], { cwd: root });
  const hasOrigin = sh("git", ["remote", "get-url", "origin"], { cwd: root, allowFail: true }).ok;
  if (!hasOrigin) {
    sh("gh", ["repo", "create", name, "--private", "--source", ".", "--remote", "origin", "--push"], { cwd: root });
  } else {
    sh("git", ["push", "-u", "origin", "HEAD"], { cwd: root });
  }
  const repo = sh("gh", ["repo", "view", "--json", "url,visibility", "-q", ".url + \" \" + .visibility"], { cwd: root }).stdout.trim();
  const [repoUrl, visibility] = repo.split(" ");
  if (visibility && visibility !== "PRIVATE") warn(`The repo is ${visibility.toLowerCase()}. A remake should stay private until it's yours.`);
  ok(repoUrl);

  step("Deploying to Google Cloud Run behind a passcode");
  const inProject = (args) => [...args, "--project", project];
  gcloud(inProject(["services", "enable", ...APIS]), { cwd: root });
  // The passcode lives in Secret Manager; Cloud Run reads it as REMAKE_PASSCODE.
  const exists = gcloud(inProject(["secrets", "describe", secret]), { cwd: root, allowFail: true }).ok;
  if (exists) gcloud(inProject(["secrets", "versions", "add", secret, "--data-file=-"]), { cwd: root, input: passcode });
  else gcloud(inProject(["secrets", "create", secret, "--replication-policy=automatic", "--data-file=-"]), { cwd: root, input: passcode });
  const number = gcloud(["projects", "describe", project, "--format=value(projectNumber)"], { cwd: root }).stdout.trim();
  gcloud(inProject(["secrets", "add-iam-policy-binding", secret, `--member=serviceAccount:${number}-compute@developer.gserviceaccount.com`, "--role=roles/secretmanager.secretAccessor", "--quiet"]), { cwd: root });
  // The passcode gate in server.js is the lock, so Google's own sign-in is off for this service.
  const dep = gcloud(inProject(["run", "deploy", service, "--source", ".", "--region", region, "--allow-unauthenticated", "--set-secrets", `REMAKE_PASSCODE=${secret}:latest`, "--memory", "512Mi", "--quiet"]), { cwd: root, allowFail: true });
  if (!dep.ok) throw new RemakeError(`gcloud run deploy failed:\n${dep.out.trim().slice(-1500)}`);
  const url =
    gcloud(inProject(["run", "services", "describe", service, "--region", region, "--format=value(status.url)"]), { cwd: root, allowFail: true }).stdout.trim() ||
    /Service URL:\s*(https:\/\/\S+)/.exec(dep.out)?.[1];
  if (!url) throw new RemakeError("The deploy worked but Cloud Run gave no address.", `Run \`gcloud run services describe ${service} --region ${region} --project ${project}\`.`);
  ok(`deployed: ${url}`);
  // Keep the repo in step with anything the deploy changed.
  sh("git", ["add", "-A"], { cwd: root });
  if (!sh("git", ["diff", "--cached", "--quiet"], { cwd: root, allowFail: true }).ok) {
    sh("git", ["commit", "-m", "Deploy config"], { cwd: root });
    sh("git", ["push", "-u", "origin", "HEAD"], { cwd: root });
  }

  step("Checking the passcode gate");
  const check = await verifyGate(url, passcode, first);
  let verified = "no";
  if (check.gate && check.unlock && check.page) {
    verified = "yes";
    ok(`locked without the passcode, open with it${check.noindex ? ", hidden from search engines" : ""}`);
  } else {
    warn(`gate check: ${JSON.stringify(check)}`);
  }
  const head = sh("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
  const shipInfo = { name, project, region, service, secret, repo: repoUrl, visibility, url, passcode, verified, check, commit: head, at: new Date().toISOString() };
  writeJson(p.ship, shipInfo);
  say(`\n  Live:     ${url}\n  Passcode: ${passcode}\n  Repo:     ${repoUrl} (${(visibility || "private").toLowerCase()})\n  Proof:    ${url}/_remake/\n  Swap:     ${url}/_remake/swap/`);
  say("\nNext: remake report");
  return shipInfo;
}
