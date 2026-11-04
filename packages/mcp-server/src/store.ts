import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProjectSchema, type Project } from "@opencut/project-schema";

export interface MediaRecord {
	id: string;
	path: string;
	durationSeconds: number;
	width: number;
	height: number;
	fps: number;
}

export type RenderJobStatus = "queued" | "running" | "done" | "error";

export interface RenderJob {
	id: string;
	projectId: string;
	status: RenderJobStatus;
	/** 0..1 */
	progress: number;
	outputPath?: string;
	error?: string;
}

export interface ProjectSummary {
	id: string;
	name: string;
	/** MediaTime ticks, same unit as `Project.metadata.duration`. */
	duration: number;
	updatedAt: string;
}

/**
 * Projects persist to disk, one JSON file per project
 * (`<dataDir>/<projectId>.json`); `media` and `jobs` stay in-memory only —
 * see `docs/mcp-headless.md` §5. `dataDir` defaults to
 * `~/.opencut-headless/projects`, overridable (tests point it at a tmp dir
 * so they never touch the real user data directory).
 *
 * Loading is lazy: nothing is read from disk until a project is asked for
 * by id, so startup cost and memory use don't scale with how many projects
 * exist on disk — only with how many this session actually touches. Every
 * mutating tool call writes the project back to disk immediately
 * (write-through; no debouncing, no batched writes) so the in-memory copy
 * is never the only copy.
 *
 * No concurrency control beyond JS's single-threaded event loop and no file
 * locking — acceptable for the MVP's single-agent, single-process use.
 */
export class ProjectStore {
	private readonly dataDir: string;
	private readonly cache = new Map<string, Project>();
	/** In-flight disk loads, keyed by projectId — see `getProject`. */
	private readonly loading = new Map<string, Promise<Project>>();
	/**
	 * `metadata.updatedAt` (as millis) of the on-disk revision each cached
	 * project was last known to match — set on load and after every save.
	 * Used by `saveProject` to detect "someone else wrote this project since
	 * I last saw it", which only the write-through, lazy-load design can't
	 * catch on its own: two *processes* (e.g. this server's stdio and HTTP
	 * entry points, run at once, pointed at the same `dataDir`) each cache
	 * their own copy in their own memory, so one process's cache has no way
	 * to know the file moved — this is the check that replaces that missing
	 * cross-process signal.
	 */
	private readonly knownRevision = new Map<string, number>();
	readonly media = new Map<string, MediaRecord>();
	readonly jobs = new Map<string, RenderJob>();

	constructor(dataDir?: string) {
		this.dataDir = dataDir ?? join(homedir(), ".opencut-headless", "projects");
	}

	private projectPath(projectId: string): string {
		return join(this.dataDir, `${projectId}.json`);
	}

	private async ensureDataDir(): Promise<void> {
		await mkdir(this.dataDir, { recursive: true });
	}

	/**
	 * Loads a project (from cache, else from disk) or throws. Two calls for
	 * the same not-yet-cached project share one disk read instead of racing:
	 * without this, each would parse its own separate copy and whichever
	 * finished its edit and saved last would silently overwrite the other's.
	 */
	async getProject(projectId: string): Promise<Project> {
		const cached = this.cache.get(projectId);
		if (cached) return cached;

		const inFlight = this.loading.get(projectId);
		if (inFlight) return inFlight;

		const load = (async () => {
			let raw: string;
			try {
				raw = await readFile(this.projectPath(projectId), "utf8");
			} catch {
				throw new Error(`No project with id "${projectId}"`);
			}
			const project = ProjectSchema.parse(JSON.parse(raw));
			this.cache.set(projectId, project);
			this.knownRevision.set(projectId, project.metadata.updatedAt.getTime());
			return project;
		})();
		this.loading.set(projectId, load);
		try {
			return await load;
		} finally {
			this.loading.delete(projectId);
		}
	}

	/**
	 * Writes a project to disk and refreshes the in-memory cache. Used both
	 * for a brand-new project and after mutating an already-loaded one.
	 *
	 * Throws instead of overwriting if this project was previously loaded by
	 * this store (there's a `knownRevision` for it) and the on-disk file's
	 * `metadata.updatedAt` no longer matches — another process (or another
	 * `ProjectStore` instance) saved a newer revision in the meantime. A
	 * brand-new project (never loaded, no `knownRevision` entry) always
	 * writes through with no check, same as before.
	 */
	async saveProject(project: Project): Promise<void> {
		const projectId = project.metadata.id;
		const known = this.knownRevision.get(projectId);
		if (known !== undefined) {
			const onDiskUpdatedAt = await this.readUpdatedAtFromDisk(projectId);
			if (onDiskUpdatedAt !== null && onDiskUpdatedAt !== known) {
				throw new Error(
					`Project "${projectId}" was modified elsewhere since it was last loaded here ` +
						`(on disk: ${new Date(onDiskUpdatedAt).toISOString()}, expected: ${new Date(known).toISOString()}). ` +
						"Call get_project_state again and re-apply this change.",
				);
			}
		}

		await this.ensureDataDir();
		await writeFile(this.projectPath(projectId), JSON.stringify(project, null, 2));
		this.cache.set(projectId, project);
		this.knownRevision.set(projectId, project.metadata.updatedAt.getTime());
	}

	/** Reads just `metadata.updatedAt` from the on-disk file, without full schema validation — `saveProject`'s conflict check needs only this one field. Returns `null` if the file doesn't exist or can't be parsed (treated as "nothing to conflict with"). */
	private async readUpdatedAtFromDisk(projectId: string): Promise<number | null> {
		try {
			const raw = await readFile(this.projectPath(projectId), "utf8");
			const parsed = JSON.parse(raw) as { metadata?: { updatedAt?: string } };
			const updatedAt = parsed.metadata?.updatedAt;
			if (!updatedAt) return null;
			const ms = new Date(updatedAt).getTime();
			return Number.isFinite(ms) ? ms : null;
		} catch {
			return null;
		}
	}

	/** Deletes a project's file and cache entry. Throws if it never existed, same as `getProject`. */
	async deleteProject(projectId: string): Promise<void> {
		await this.getProject(projectId); // throws "No project with id" if missing
		this.cache.delete(projectId);
		this.knownRevision.delete(projectId);
		try {
			await unlink(this.projectPath(projectId));
		} catch {
			// Already gone from disk (e.g. deleted out-of-band) — the cache
			// entry is what mattered for "does this store still know about it".
		}
	}

	/**
	 * Lists every project on disk by reading just enough of each file to
	 * summarize it — not a full `ProjectSchema.parse`, so one malformed file
	 * (hand-edited, from an incompatible future schema version) is skipped
	 * with a console warning rather than failing the whole listing.
	 */
	async listProjects(): Promise<ProjectSummary[]> {
		await this.ensureDataDir();
		const files = await readdir(this.dataDir);
		const summaries: ProjectSummary[] = [];
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			try {
				const raw = await readFile(join(this.dataDir, file), "utf8");
				const parsed = JSON.parse(raw) as Project;
				summaries.push({
					id: parsed.metadata.id,
					name: parsed.metadata.name,
					duration: parsed.metadata.duration,
					updatedAt: String(parsed.metadata.updatedAt),
				});
			} catch (err) {
				console.error(`[store] skipping unreadable project file "${file}":`, err);
			}
		}
		summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return summaries;
	}

	getMediaOrThrow(mediaId: string): MediaRecord {
		const media = this.media.get(mediaId);
		if (!media) {
			throw new Error(`No media with id "${mediaId}"`);
		}
		return media;
	}
}

let counter = 0;
export function nextId(prefix: string): string {
	counter += 1;
	return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}
