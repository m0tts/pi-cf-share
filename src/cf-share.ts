import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, readdirSync } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// An anonymous login challenge tests only this URL, not the policy's authorized identities.
const WORKER_TEMPLATE = fileURLToPath(new URL("./worker/worker.mjs", import.meta.url));
const ACCESS_GUIDE = "https://developers.cloudflare.com/workers/configuration/cloudflare-access/";

export async function stageWorker(
	staging: string,
	name: string,
	accountId: string,
	locked = false,
	markdownIndex = false,
): Promise<string> {
	const config = join(staging, "wrangler.jsonc");
	await copyFile(WORKER_TEMPLATE, join(staging, "worker.mjs"), constants.COPYFILE_EXCL);
	await writeFile(
		config,
		JSON.stringify(
			{
				name,
				main: "./worker.mjs",
				account_id: accountId,
				compatibility_date: "2025-10-01",
				workers_dev: true,
				preview_urls: false,
				vars: { SHARE_LOCKED: locked ? "true" : "false", SHARE_INDEX_MD: markdownIndex ? "true" : "false" },
				assets: { directory: "./public", binding: "ASSETS", run_worker_first: true },
			},
			null,
			2,
		) + "\n",
		{ flag: "wx" },
	);
	return config;
}

export async function unlockWorker(config: string, markdownIndex: boolean): Promise<void> {
	const settings = JSON.parse(await readFile(config, "utf8"));
	settings.vars.SHARE_LOCKED = "false";
	settings.vars.SHARE_INDEX_MD = markdownIndex ? "true" : "false";
	await writeFile(config, JSON.stringify(settings, null, 2) + "\n");
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 20_000;
const COMMAND_TIMEOUT_MS = 180_000;
const STATUS_KEY = "cf-share";
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/i;

type Source = { kind: "session" | "file"; path: string };
type Inventory = { files: number; bytes: number };

export function parseSource(args: string, cwd: string, currentSession?: string): Source {
	const input = args.trim();
	if (!input) throw new Error("Usage: /cf-share session OR /cf-share path <file-or-directory>");
	if (input === "session") {
		if (!currentSession) throw new Error("This session has no saved file yet");
		return { kind: "session", path: currentSession };
	}
	if (input.startsWith("session ")) throw new Error("Only the current session can be shared; use /cf-share session");
	const path = resolve(cwd, input.startsWith("path ") ? input.slice(5).trim() : input);
	return { kind: "file", path }; // stat() determines whether it is a directory.
}

export function sourceCompletions(
	prefix: string,
	cwd: string,
): { value: string; label: string }[] | null {
	const options = [
		{ value: "account", label: "account — choose or change the deployment account" },
		{ value: "session", label: "session — current Pi session" },
		{ value: "path ", label: "path <file-or-dir> — HTML, Markdown or built app" },
	];
	if (!prefix.startsWith("path ")) {
		return options.filter(({ value }) => value.startsWith(prefix));
	}
	const command = "path ";
	const suffix = prefix.slice(command.length);
	const slash = suffix.lastIndexOf("/");
	const parent = slash === -1 ? "" : suffix.slice(0, slash + 1);
	const stem = suffix.slice(slash + 1);
	try {
		const entries = readdirSync(resolve(cwd, parent || "."), { withFileTypes: true });
		const matches = entries.filter(
			(entry) =>
				entry.name.startsWith(stem) &&
				!entry.name.startsWith(".") &&
				(entry.isDirectory() ||
					(entry.isFile() && /\.(html|md)$/i.test(entry.name))),
		);
		return matches.slice(0, 30).map((entry) => {
			const value = `${command}${parent}${entry.name}${entry.isDirectory() ? "/" : ""}`;
			return { value, label: value };
		});
	} catch {
		return null;
	}
}

export function workerDashboardUrl(accountId: string, name: string): string {
	return `https://dash.cloudflare.com/${accountId}/workers/services/view/${encodeURIComponent(name)}/production`;
}

export function deploymentUrl(output: string, name: string): string | undefined {
	// Wrangler's route output identifies the live Worker; reject unrelated preview/dashboard URLs.
	const urls = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev(?:\/[a-z0-9/_-]*)?/gi) ?? [];
	return urls.find((url) => new URL(url).hostname.startsWith(`${name}.`))?.replace(/\/+$/, "");
}

export async function accessChallengesAnonymousVisitor(
	url: string,
	request: typeof fetch = fetch,
): Promise<boolean> {
	// No Access cookie or credentials are supplied. Do not follow a redirect to a login page.
	const response = await request(url, { redirect: "manual", signal: AbortSignal.timeout(12_000) });
	await response.body?.cancel();
	if (![301, 302, 303, 307, 308].includes(response.status)) return false;
	const location = response.headers.get("location");
	if (!location) return false;
	const target = new URL(location, url);
	return (
		target.hostname.endsWith(".cloudflareaccess.com") ||
		target.pathname.startsWith("/cdn-cgi/access/")
	);
}

function validateAssetName(name: string): void {
	// Do not upload hidden config, source maps, or executable/framework-specific routes as assets.
	if (
		name.startsWith(".") ||
		name === "functions" ||
		name === "_worker.js" ||
		name === "_routes.json" ||
		name.endsWith(".map")
	) {
		throw new Error(`Refusing to publish ${name} (hidden, source map, or executable asset)`);
	}
}

async function checkAsset(path: string, size: number): Promise<void> {
	if (size > MAX_FILE_BYTES)
		throw new Error(`${path} exceeds the Workers Static Assets 25 MiB per-file limit`);
}

export async function stageAssets(source: Source, output: string): Promise<Inventory> {
	const stat = await lstat(source.path); // Do not follow a symlink at the root.
	await mkdir(output, { recursive: true });
	if (source.kind === "session") throw new Error("Session assets must be exported by Pi first");
	if (stat.isFile()) {
		if (!/\.(html|md)$/i.test(source.path))
			throw new Error("Single-file publishing requires an .html or .md file");
		validateAssetName(source.path.split(/[\\/]/).at(-1)!);
		await checkAsset(source.path, stat.size);
		await copyFile(source.path, join(output, source.path.toLowerCase().endsWith(".md") ? "index.md" : "index.html"), constants.COPYFILE_EXCL);
		return { files: 1, bytes: stat.size };
	}
	if (!stat.isDirectory())
		throw new Error("Expected an HTML/Markdown file or a prebuilt asset directory (no symlinks)");

	const inventory: Inventory = { files: 0, bytes: 0 };
	async function visit(input: string, target: string): Promise<void> {
		for (const entry of await readdir(input, { withFileTypes: true })) {
			validateAssetName(entry.name);
			const src = join(input, entry.name);
			const dst = join(target, entry.name);
			if (entry.isDirectory()) {
				await mkdir(dst);
				await visit(src, dst);
			} else if (entry.isFile()) {
				const info = await lstat(src);
				await checkAsset(src, info.size);
				inventory.files++;
				inventory.bytes += info.size;
				if (inventory.files > MAX_FILES || inventory.bytes > MAX_TOTAL_BYTES) {
					throw new Error(
						"Asset directory exceeds 20,000 files or 100 MiB; publish a smaller build output",
					);
				}
				await copyFile(src, dst, constants.COPYFILE_EXCL);
			} else {
				throw new Error(`Refusing non-regular asset: ${src}`);
			}
		}
	}
	await visit(source.path, output);
	if (!(await lstat(join(output, "index.html")).catch(() => undefined))?.isFile() &&
		!(await lstat(join(output, "index.md")).catch(() => undefined))?.isFile()) {
		throw new Error("Asset directory needs an index.html or index.md at its root");
	}
	return inventory;
}

type CommandResult = { stdout: string; stderr: string };
export async function runCommand(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeout = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
	return await new Promise((ok, fail) => {
		const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const collect = (part: string, chunk: Buffer) => (part + chunk.toString()).slice(-64_000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = collect(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = collect(stderr, chunk);
		});
		const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
		child.on("error", (error) => {
			clearTimeout(timer);
			fail((error as NodeJS.ErrnoException).code === "ENOENT"
				? new Error(command === "wrangler"
					? "Wrangler is not installed. Install it with npm install -g wrangler, then run wrangler login."
					: "The pi CLI is not on PATH; it is required to export the current session.")
				: error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) ok({ stdout, stderr });
			else
				fail(
					new Error(
						`${command} ${args[0]} failed (${signal ?? code}); check Wrangler authentication/permissions (wrangler login) or the input session. Command output was not logged because it may contain sensitive data.`,
					),
				);
		});
	});
}

function report(
	ctx: ExtensionCommandContext,
	message: string,
	type: "info" | "error" = "info",
): void {
	ctx.ui.notify(message, type);
}

export type Account = { id: string; name: string };

/** Never use Wrangler's implicit default account. Reject malformed identity data. */
export function parseAccounts(output: string): Account[] {
	const value: unknown = JSON.parse(output);
	if (
		!value ||
		typeof value !== "object" ||
		!("accounts" in value) ||
		!Array.isArray(value.accounts)
	) {
		throw new Error("Wrangler did not return an account list. Create a Cloudflare account at https://dash.cloudflare.com/sign-up if needed, then run wrangler login");
	}
	const accounts: Account[] = [];
	for (const account of value.accounts) {
		if (
			!account ||
			typeof account !== "object" ||
			typeof account.id !== "string" ||
			!ACCOUNT_ID_RE.test(account.id) ||
			typeof account.name !== "string"
		) {
			throw new Error("Wrangler returned an invalid account list");
		}
		if (accounts.some((item) => item.id === account.id))
			throw new Error("Wrangler returned duplicate account IDs");
		accounts.push({ id: account.id, name: account.name });
	}
	if (accounts.length === 0) throw new Error("No Cloudflare accounts available. Sign up at https://dash.cloudflare.com/sign-up if needed, then run wrangler login");
	return accounts;
}

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function accountPath(): string {
	return join(agentDir(), "cf-share.json");
}

export async function savedAccountId(): Promise<string | undefined> {
	let raw: string;
	try {
		raw = await readFile(accountPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const document: unknown = JSON.parse(raw);
	if (
		!document ||
		typeof document !== "object" ||
		!("accountId" in document) ||
		typeof document.accountId !== "string" ||
		!ACCOUNT_ID_RE.test(document.accountId)
	) {
		throw new Error(`${accountPath()} has an invalid account ID; fix or remove the file`);
	}
	return document.accountId;
}

async function saveAccountId(id: string): Promise<void> {
	if (!ACCOUNT_ID_RE.test(id)) throw new Error("Invalid account ID");
	await mkdir(agentDir(), { recursive: true });
	const path = accountPath();
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify({ accountId: id }) + "\n", {
			mode: 0o600,
			flag: "wx",
		});
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function chooseAccount(
	ctx: ExtensionCommandContext,
	cwd: string,
	force = false,
): Promise<Account | undefined> {
	// Identity lookup is deliberately unpinned, so all accounts are available for selection.
	const identityEnv = { ...process.env };
	delete identityEnv["CLOUDFLARE_ACCOUNT_ID"];
	const identity = await runCommand("wrangler", ["whoami", "--json"], cwd, identityEnv, 30_000);
	const accounts = parseAccounts(identity.stdout);
	const saved = force ? undefined : await savedAccountId();
	if (saved) {
		const current = accounts.find((account) => account.id === saved);
		if (!current)
			throw new Error(
				`Selected account ${saved} is not available to Wrangler; run /cf-share account to choose another`,
			);
		return current;
	}
	const choices = accounts.map((account) => `${account.name} (${account.id})`);
	const choice = await ctx.ui.select("Choose the Cloudflare account for /cf-share", choices);
	if (!choice) return undefined;
	const account = accounts[choices.indexOf(choice)];
	if (!account) throw new Error("Unknown account selection");
	await saveAccountId(account.id);
	return account;
}

export default function cfShare(pi: ExtensionAPI): void {
	let completionCwd = process.cwd();
	pi.on("session_start", (_event, ctx) => {
		completionCwd = ctx.cwd;
	});
	pi.registerCommand("cf-share", {
		description: "Suggest content to share or deploy reviewed HTML/Markdown via a Worker",
		getArgumentCompletions: (prefix) => sourceCompletions(prefix, completionCwd),
		handler: async (args, ctx) => {
			if (!args.trim()) {
				pi.sendUserMessage("Please suggest what would be most useful and safe to share from our current conversation or project. Identify a specific artifact or the current session, note sensitive data that should be removed, and ask me what to publish. Do not publish anything yet. Once I decide, explain /cf-share session or /cf-share path <file-or-directory> and that Cloudflare Access is recommended.");
				return;
			}
			if (!ctx.hasUI) {
				report(ctx, "Publishing requires an interactive confirmation (TUI or RPC with dialogs).", "error");
				return;
			}
			if (args.trim() === "account") {
				try {
					const account = await chooseAccount(ctx, ctx.cwd, true);
					if (account) report(ctx, `Selected /cf-share account: ${account.name} (${account.id})`);
				} catch (error) {
					report(
						ctx,
						`Account selection failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}

			let staging: string | undefined;
			let attemptedWorker: string | undefined;
			let accountId: string | undefined;
			let phase = "preparing";
			const started = Date.now();
			const progress = (message: string, announce = false) => {
				phase = message;
				ctx.ui.setStatus(
					STATUS_KEY,
					`share: ${phase} (${Math.floor((Date.now() - started) / 1000)}s)`,
				);
				if (announce) report(ctx, `Sharing: ${message}…`);
			};
			progress("preparing", true);
			const ticker = ctx.mode === "tui" ? setInterval(() => progress(phase), 1000) : undefined;
			try {
				const source = parseSource(args, ctx.cwd, ctx.sessionManager.getSessionFile());
				staging = await mkdtemp(join(tmpdir(), "pi-cf-share-"));
				progress("checking Wrangler account", true);
				const account = await chooseAccount(ctx, staging);
				if (!account) {
					report(ctx, "Publishing cancelled; no account selected.");
					return;
				}
				accountId = account.id;
				const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };
				// Keep real content outside the deployable assets directory until Access is verified.
				const contentDir = join(staging, "content");
				const publicDir = join(staging, "public");
				let inventory: Inventory;
				if (source.kind === "session") {
					progress("exporting session", true);
					if (!(await lstat(source.path)).isFile())
						throw new Error("Session must be a regular .jsonl file");
					await mkdir(contentDir);
					const html = join(contentDir, "index.html");
					// Pi renders the transcript and tool output. No raw JSONL is uploaded.
					await runCommand("pi", ["--no-extensions", "--offline", "--export", source.path, html], staging, process.env);
					const size = (await lstat(html)).size;
					await checkAsset(html, size);
					inventory = { files: 1, bytes: size };
				} else {
					progress("staging static assets", true);
					inventory = await stageAssets(source, contentDir);
				}
				const name = `pi-share-${randomBytes(7).toString("hex")}`;
				const protectedChoice = "Protect with Cloudflare Access (recommended)";
				const publicChoice = "Public — anyone with the link (not recommended)";
				const choice = await ctx.ui.select("Who should be able to view this share?", [protectedChoice, publicChoice]);
				if (!choice) return;
				if (choice !== protectedChoice && choice !== publicChoice) throw new Error("Unknown visibility choice");
				const protectedShare = choice === protectedChoice;
				const markdownIndex = !!(await lstat(join(contentDir, "index.md")).catch(() => undefined))?.isFile()
					&& !(await lstat(join(contentDir, "index.html")).catch(() => undefined))?.isFile();
				// A protected share initially deploys a locked placeholder without user content.
				if (protectedShare) {
					await mkdir(publicDir);
					await writeFile(join(publicDir, "index.html"), "Share awaiting Cloudflare Access setup");
				} else {
					await rename(contentDir, publicDir);
				}
				const config = await stageWorker(staging, name, accountId, protectedShare, !protectedShare && markdownIndex);
				progress("awaiting your review");
				const yes = await ctx.ui.confirm(
					protectedShare ? "Deploy locked Worker, then enable Access?" : "Publish without Access?",
					`Account: ${account.name} (${accountId})\nWorker: ${name}\nSource: ${source.path}\nStaged: ${staging} (${inventory.files} files, ${(inventory.bytes / 1024 / 1024).toFixed(2)} MiB)\n\nReview the staged content before continuing. ${protectedShare ? "Only a locked placeholder is deployed initially. You must configure Access for ALL production traffic in the dashboard before content is uploaded." : "PUBLIC: Anyone can view and copy the content. Do not publish secrets, credentials, private conversations or customer data."} Session exports include tool output. Continue?`,
				);
				if (!yes) {
					report(ctx, "Publishing cancelled; nothing uploaded.");
					return;
				}
				if (!protectedShare && !(await ctx.ui.confirm("Confirm public publication", "This Worker will be reachable by anyone on the internet, without Cloudflare Access. Publish it publicly?"))) {
					report(ctx, "Publishing cancelled; nothing uploaded.");
					return;
				}

				attemptedWorker = name;
				progress(protectedShare ? "deploying locked placeholder" : "deploying public content", true);
				const deployed = await runCommand("wrangler", ["deploy", "--config", config], staging, env);
				const url = deploymentUrl(`${deployed.stdout}\n${deployed.stderr}`, name);
				if (!url) throw new Error("Wrangler did not return a workers.dev URL; check the account subdomain");
				if (protectedShare) {
					progress("waiting for Access setup");
					const ready = await ctx.ui.confirm(
						"Enable Cloudflare Access before uploading content",
						`The locked Worker is at ${url}. Open ${workerDashboardUrl(accountId, name)} > Access > Protect this Worker behind Access > All traffic. Configure who may sign in (account members or invitees by email), then Apply Access. Zero Trust must be enabled on the account; see ${ACCESS_GUIDE}. This prompt does NOT configure Access for you. Continue only after the policy is active. Cancel deletes the placeholder.`,
					);
					if (!ready) throw new Error("Access setup cancelled");
					progress("checking anonymous Access challenge", true);
					if (!(await accessChallengesAnonymousVisitor(url))) throw new Error("No Access login challenge. Enable Access for all production traffic and verify your policy before retrying");
					await rm(publicDir, { recursive: true });
					await rename(contentDir, publicDir);
					await unlockWorker(config, markdownIndex);
					progress("uploading protected content", true);
					await runCommand("wrangler", ["deploy", "--config", config], staging, env);
					if (!(await accessChallengesAnonymousVisitor(url))) throw new Error("Access challenge disappeared after content deployment");
				}
				attemptedWorker = undefined;
				report(ctx, `${protectedShare ? "Published behind Access" : "Published publicly"}: ${url}\nWorker: ${name} · Account: ${account.name}\nDashboard: ${workerDashboardUrl(accountId, name)}${protectedShare ? "\nVerify the permitted identities and keep Access enabled. An anonymous challenge does not validate the policy." : ""}`);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				let cleanup = "";
				if (attemptedWorker && staging) {
					progress("removing failed deployment", true);
					try {
						await runCommand(
							"wrangler",
							["delete", attemptedWorker, "--force", "--config", join(staging, "wrangler.jsonc")],
							staging,
							{ ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
						);
						cleanup = `\nRemoved newly created Worker ${attemptedWorker}.`;
					} catch {
						cleanup = `\nURGENT: Check/delete Worker ${attemptedWorker}: ${workerDashboardUrl(accountId!, attemptedWorker)}`;
					}
				}
				report(ctx, `Worker publish failed: ${reason}${cleanup}`, "error");
			} finally {
				if (ticker) clearInterval(ticker);
				ctx.ui.setStatus(STATUS_KEY, undefined);
				if (staging) await rm(staging, { recursive: true, force: true });
			}
		},
	});
}
