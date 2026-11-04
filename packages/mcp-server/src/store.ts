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

	/** Loads a project (from cache, else from disk) or throws. */
	async getProject(projectId: string): Promise<Project> {
		const cached = this.cache.get(projectId);
		if (cached) return cached;

		let raw: string;
		try {
			raw = await readFile(this.projectPath(projectId), "utf8");
		} catch {
			throw new Error(`No project with id "${projectId}"`);
		}
		const project = ProjectSchema.parse(JSON.parse(raw));
		this.cache.set(projectId, project);
		return project;
	}

	/** Writes a project to disk and refreshes the in-memory cache. Used both for a brand-new project and after mutating an already-loaded one. */
	async saveProject(project: Project): Promise<void> {
		await this.ensureDataDir();
		await writeFile(this.projectPath(project.metadata.id), JSON.stringify(project, null, 2));
		this.cache.set(project.metadata.id, project);
	}

	/** Deletes a project's file and cache entry. Throws if it never existed, same as `getProject`. */
	async deleteProject(projectId: string): Promise<void> {
		await this.getProject(projectId); // throws "No project with id" if missing
		this.cache.delete(projectId);
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
