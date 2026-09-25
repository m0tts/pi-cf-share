import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import cfShare, {
  accessChallengesAnonymousVisitor, deploymentUrl, parseAccounts, parseSource,
  savedAccountId, sourceCompletions, stageAssets, stageWorker, unlockWorker, workerDashboardUrl,
} from "../src/cf-share.ts";

const ID_A = "41502faeef990142381b28952e25b6ea";
const ID_B = "b".repeat(32);
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "cf-share-test-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function withEnv(values, run) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await run(); } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
const template = (await import("../src/worker/worker.mjs")).default;

test("only the current session, direct paths, and Markdown completions", async () => fixture(async root => {
  await writeFile(join(root, "doc.md"), "# Hi");
  await writeFile(join(root, "app.html"), "hi");
  await mkdir(join(root, "dist"));
  assert.deepEqual(parseSource("session", root, join(root, "now.jsonl")), { kind: "session", path: join(root, "now.jsonl") });
  assert.throws(() => parseSource("session old.jsonl", root), /Only the current session/);
  assert.throws(() => parseSource("session", root), /no saved file/);
  assert.deepEqual(parseSource("path doc.md", root), { kind: "file", path: join(root, "doc.md") });
  assert.deepEqual(sourceCompletions("", root).map(x => x.value), ["account", "session", "path "]);
  assert.deepEqual(sourceCompletions("path ", root).map(x => x.value).sort(), ["path app.html", "path dist/", "path doc.md"]);
}));

test("bundled Worker serves HTML, formats Markdown safely and locks all routes", async () => fixture(async root => {
  await mkdir(join(root, "public"));
  const configFile = await stageWorker(root, "pi-share-test", ID_B, true);
  const config = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(config.account_id, ID_B);
  assert.equal(config.preview_urls, false);
  assert.equal(config.vars.SHARE_LOCKED, "true");
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(await readFile(join(root, "worker.mjs"), "utf8"), await readFile(new URL("../src/worker/worker.mjs", import.meta.url), "utf8"));
  const staged = (await import(pathToFileURL(join(root, "worker.mjs")).href)).default;
  const assets = { fetch: req => new Response(new URL(req.url).pathname === "/index.md" ? "# Hello\n\n<script>alert(1)</script> [bad](javascript:alert) [safe](https://example.com)" : "<h1>hi</h1>") };
  let response = await staged.fetch(new Request("https://test/doc.md"), { ASSETS: assets, SHARE_LOCKED: "true" });
  assert.equal(response.status, 403);
  response = await staged.fetch(new Request("https://test/", { method: "POST" }), { ASSETS: assets, SHARE_LOCKED: "false" });
  assert.equal(response.status, 405);
  response = await staged.fetch(new Request("https://test/"), { ASSETS: assets, SHARE_LOCKED: "false", SHARE_INDEX_MD: "false" });
  assert.match(await response.text(), /<h1>hi<\/h1>/);
  await unlockWorker(configFile, true);
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")).vars, { SHARE_LOCKED: "false", SHARE_INDEX_MD: "true" });
  response = await staged.fetch(new Request("https://test/"), { ASSETS: assets, SHARE_LOCKED: "false", SHARE_INDEX_MD: "true" });
  const html = await response.text();
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  response = await staged.fetch(new Request("https://test/doc.md?raw"), { ASSETS: assets, SHARE_LOCKED: "false" });
  assert.match(response.headers.get("content-type"), /text\/markdown/);
  response = await staged.fetch(new Request("https://test/doc.md", { method: "HEAD" }), { ASSETS: assets, SHARE_LOCKED: "false" });
  assert.equal(await response.text(), "");
}));

test("assets accept HTML and Markdown roots, reject executable assets and symlinks", async () => fixture(async root => {
  const source = join(root, "dist");
  await mkdir(source);
  await writeFile(join(source, "index.md"), "# doc");
  await writeFile(join(source, "page.html"), "<p>ok</p>");
  assert.deepEqual(await stageAssets({ kind: "file", path: source }, join(root, "out")), { files: 2, bytes: 14 });
  await stageAssets({ kind: "file", path: join(source, "index.md") }, join(root, "single"));
  assert.equal(await readFile(join(root, "single", "index.md"), "utf8"), "# doc");
  for (const name of [".env", "app.js.map", "_worker.js"]) {
    await writeFile(join(source, name), "secret");
    await assert.rejects(stageAssets({ kind: "file", path: source }, join(root, `reject-${name}`)), /Refusing/);
    await rm(join(source, name));
  }
  await symlink(join(source, "index.md"), join(source, "link"));
  await assert.rejects(stageAssets({ kind: "file", path: source }, join(root, "symlink")), /non-regular/);
  await assert.rejects(stageAssets({ kind: "file", path: join(source, "link") }, join(root, "link-root")), /Expected/);
  const empty = join(root, "empty"); await mkdir(empty);
  await writeFile(join(empty, "data.json"), "{}");
  await assert.rejects(stageAssets({ kind: "file", path: empty }, join(root, "missing")), /index.html or index.md/);
}));

test("account parsing and anonymous challenge are conservative", async () => fixture(async root => withEnv({ PI_CODING_AGENT_DIR: root }, async () => {
  assert.deepEqual(parseAccounts(JSON.stringify({ accounts: [{ id: ID_A, name: "personal" }, { id: ID_B, name: "team" }] })).map(a => a.id), [ID_A, ID_B]);
  assert.throws(() => parseAccounts('{"accounts":[]}'), /No Cloudflare accounts/);
  assert.equal(await savedAccountId(), undefined);
  await writeFile(join(root, "cf-share.json"), '{"accountId":"wrong"}');
  await assert.rejects(savedAccountId(), /invalid account ID/);
  assert.equal(deploymentUrl("Preview https://1-test.foo.workers.dev Live https://test.foo.workers.dev", "test"), "https://test.foo.workers.dev");
  assert.equal(deploymentUrl("https://wrong.foo.workers.dev", "test"), undefined);
  assert.equal(workerDashboardUrl(ID_A, "pi-share-test"), `https://dash.cloudflare.com/${ID_A}/workers/services/view/pi-share-test/production`);
  assert.equal(await accessChallengesAnonymousVisitor("https://test.foo.workers.dev", async () => Response.redirect("https://team.cloudflareaccess.com/cdn-cgi/access/login", 302)), true);
  assert.equal(await accessChallengesAnonymousVisitor("https://test.foo.workers.dev", async () => new Response("public")), false);
})));

test("bare command asks agent to suggest rather than opening a picker; no UI means no deployment", async () => {
  let handler; const prompts = []; const messages = [];
  cfShare({ on() {}, sendUserMessage: text => prompts.push(text), registerCommand: (_name, command) => { handler = command.handler; } });
  const ctx = { hasUI: false, ui: { notify: message => messages.push(message) } };
  await handler("", ctx);
  assert.match(prompts[0], /Do not publish anything yet/);
  await handler("session", ctx);
  assert.match(messages[0], /interactive confirmation/);
});

test("session export uses only the active Pi session, before any deployment", async () => fixture(async root => {
  const bin = join(root, "bin"), log = join(root, "commands.log");
  await mkdir(bin);
  await writeFile(join(bin, "wrangler"), `#!/bin/sh\nprintf 'wrangler %s\\n' "$*" >> "$PUBLISH_TEST_LOG"\necho '{"accounts":[{"id":"${ID_A}","name":"personal"}]}'\n`);
  await writeFile(join(bin, "pi"), `#!/bin/sh\nprintf 'pi %s\\n' "$*" >> "$PUBLISH_TEST_LOG"\ncp "$4" "$5"\n`);
  await chmod(join(bin, "wrangler"), 0o755); await chmod(join(bin, "pi"), 0o755);
  const session = join(root, "now.jsonl"); await writeFile(session, "<html>mock export</html>");
  let handler; cfShare({ on() {}, registerCommand: (_name, command) => { handler = command.handler; } });
  const messages = [];
  const ctx = { cwd: root, mode: "tui", hasUI: true, sessionManager: { getSessionFile: () => session },
    ui: { notify: message => messages.push(message), setStatus() {}, select: async (_title, choices) => choices[0], confirm: async () => false } };
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, PUBLISH_TEST_LOG: log, PI_CODING_AGENT_DIR: join(root, "config") }, async () => {
    await handler("session", ctx);
    assert.match(messages.at(-1), /cancelled/);
  });
  const output = await readFile(log, "utf8");
  assert.match(output, /pi --no-extensions --offline --export/);
  assert.match(output, /now.jsonl/);
  assert.doesNotMatch(output, /wrangler deploy/);
}));

test("protected flow deploys harmless placeholder, verifies Access, then uploads; failures clean up", async () => fixture(async root => {
  const bin = join(root, "bin"), log = join(root, "commands.log"), configRoot = join(root, "config");
  await mkdir(bin); await mkdir(configRoot);
  await writeFile(join(bin, "wrangler"), `#!/bin/sh\nprintf '%s\\n' "$CLOUDFLARE_ACCOUNT_ID|$*" >> "$PUBLISH_TEST_LOG"\nif [ "$1" = whoami ]; then echo '{"accounts":[{"id":"${ID_A}","name":"personal"}]}'; fi\nif [ "$1" = deploy ]; then\n  name=$(awk -F '"' '/"name":/{print $4; exit}' "$3")\n  grep '"SHARE_LOCKED"' "$3" >> "$PUBLISH_TEST_LOG"\n  if [ -f public/index.md ]; then echo 'real-content' >> "$PUBLISH_TEST_LOG"; else echo 'placeholder' >> "$PUBLISH_TEST_LOG"; fi\n  echo "Deployed https://$name.account.workers.dev"\nfi\n`);
  await chmod(join(bin, "wrangler"), 0o755);
  const md = join(root, "doc.md"); await writeFile(md, "# Review first");
  let handler; cfShare({ on() {}, sendUserMessage() {}, registerCommand: (_name, command) => { handler = command.handler; } });
  const messages = [], statuses = [], confirms = [];
  let challenge = true, visibility = "protected", approve = true;
  const ctx = {
    cwd: root, mode: "tui", hasUI: true,
    sessionManager: { getSessionFile: () => undefined },
    ui: {
      notify: message => messages.push(message), setStatus: (_key, value) => statuses.push(value),
      select: async (_title, options) => options.find(option => option.startsWith(visibility === "public" ? "Public" : "Protect")) ?? options[0],
      confirm: async (_title, text) => { confirms.push(text); return approve; },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => challenge ? Response.redirect("https://team.cloudflareaccess.com/cdn-cgi/access/login", 302) : new Response("public");
  try {
    await withEnv({ PATH: `${bin}:${process.env.PATH}`, PUBLISH_TEST_LOG: log, PI_CODING_AGENT_DIR: configRoot }, async () => {
      approve = false;
      await handler(`path ${md}`, ctx);
      assert.match(messages.at(-1), /cancelled/);
      assert.doesNotMatch(await readFile(log, "utf8"), /deploy/);
      approve = true;
      await handler(`path ${md}`, ctx);
      assert.match(messages.at(-1), /Published behind Access/);
      assert.match(messages.at(-1), new RegExp(`Dashboard: https://dash\\.cloudflare\\.com/${ID_A}/workers/services/view/pi-share-[a-f0-9]+/production`));
      let output = await readFile(log, "utf8");
      assert.match(output, /placeholder[\s\S]*real-content/);
      assert.match(output, /"SHARE_LOCKED": "true"[\s\S]*"SHARE_LOCKED": "false"/);
      assert.equal((output.match(/deploy --config/g) ?? []).length, 2);
      assert.equal(await savedAccountId(), ID_A);
      assert.ok(confirms.some(text => /All traffic/.test(text) && /workers\/services\/view\/pi-share-/.test(text)));
      challenge = false;
      await handler(`path ${md}`, ctx);
      assert.match(messages.at(-1), /Removed newly created Worker/);
      output = await readFile(log, "utf8");
      assert.equal((output.match(/real-content/g) ?? []).length, 1); // no real content on failed probe
      visibility = "public";
      await handler(`path ${md}`, ctx);
      assert.match(messages.at(-1), /Published publicly/);
      assert.match(messages.at(-1), /Dashboard: https:\/\/dash\.cloudflare\.com\/41502faeef990142381b28952e25b6ea\/workers\/services\/view\/pi-share-[a-f0-9]+\/production/);
      assert.ok(confirms.some(text => /anyone on the internet/.test(text)));
      assert.equal(statuses.at(-1), undefined);
    });
  } finally { globalThis.fetch = originalFetch; }
}));
