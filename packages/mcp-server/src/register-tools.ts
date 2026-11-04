import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProjectStore } from "./store";
import {
	addClip,
	addMedia,
	addText,
	createProject,
	deleteProject,
	exportVideo,
	getProjectState,
	getRenderStatus,
	listProjects,
	removeElement,
	splitClip,
	trimClip,
} from "./tools";

function json(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
	};
}

function toolError(err: unknown) {
	return {
		isError: true,
		content: [
			{
				type: "text" as const,
				text: err instanceof Error ? err.message : String(err),
			},
		],
	};
}

/**
 * All 11 MVP tool registrations, shared between the stdio entry point
 * (`server.ts`) and the HTTP entry point (`http-server.ts`) — see
 * `docs/mcp-headless.md` §3: the desktop app's "Add custom connector" dialog
 * only accepts an HTTP(S) MCP server URL, not a local stdio command, so the
 * HTTP transport exists purely to make that dialog's input usable. One
 * `McpServer` instance per transport (each gets its own `store`, so stdio
 * and HTTP never share project state).
 */
export function registerTools(server: McpServer, store: ProjectStore): void {
	server.registerTool(
		"create_project",
		{
			description:
				"Create a new project: canvas size, frame rate, background color. Returns the full project state.",
			inputSchema: {
				name: z.string().describe("Project name"),
				width: z.number().int().positive().optional().describe("Canvas width in pixels, default 1920"),
				height: z.number().int().positive().optional().describe("Canvas height in pixels, default 1080"),
				fpsNumerator: z.number().int().positive().optional().describe("Frame rate numerator, default 30"),
				fpsDenominator: z.number().int().positive().optional().describe("Frame rate denominator, default 1"),
				backgroundColor: z.string().optional().describe("CSS color, default #000000"),
			},
		},
		async (args) => {
			try {
				return json(await createProject(store, args));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"list_projects",
		{
			description:
				"List every project persisted to disk (id, name, duration, last updated), newest first. Use this to find a projectId before calling get_project_state or export_video.",
			inputSchema: {},
		},
		async () => {
			try {
				return json(await listProjects(store));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"add_media",
		{
			description:
				"Register a local media file (video) with a project: probes it with ffprobe for duration/resolution/fps. Returns a mediaId used by add_clip.",
			inputSchema: {
				projectId: z.string(),
				filePath: z.string().describe("Absolute path to a local video file"),
			},
		},
		async (args) => {
			try {
				return json(await addMedia(store, args));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"add_clip",
		{
			description:
				"Add a video clip (from a mediaId returned by add_media) onto the main track. Defaults to placing it after the last clip.",
			inputSchema: {
				projectId: z.string(),
				mediaId: z.string(),
				startTime: z
					.number()
					.nonnegative()
					.optional()
					.describe("Seconds on the timeline; defaults to the end of the main track"),
			},
		},
		async (args) => {
			try {
				return json(await addClip(store, args));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"split_clip",
		{
			description:
				"Split a main-track video element into two elements at an absolute timeline position (seconds).",
			inputSchema: {
				projectId: z.string(),
				elementId: z.string(),
				atSeconds: z.number().nonnegative(),
			},
		},
		async (args) => {
			try {
				return json(await splitClip(store, args));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"trim_clip",
		{
			description:
				"Adjust a video element's in/out points (trimStart/trimEnd, in source-seconds). The element's timeline duration follows trimEnd - trimStart.",
			inputSchema: {
				projectId: z.string(),
				elementId: z.string(),
				trimStartSeconds: z.number().nonnegative().optional(),
				trimEndSeconds: z.number().nonnegative().optional(),
			},
		},
		async (args) => {
			try {
				return json(await trimClip(store, args));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"add_text",
		{
			description:
				"Add a text overlay at a given time range. Creates a text overlay track on first use.",
			inputSchema: {
				projectId: z.string(),
				content: z.string(),
				startTime: z.number().nonnegative().describe("Seconds on the timeline"),
				durationSeconds: z.number().positive(),
				fontSize: z.number().positive().optional().describe("Default 48"),
				color: z.string().optional().describe("CSS color, default #ffffff"),
			},
		},
		async (args) => {
			try {
				return json(await addText(store, args));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"remove_element",
		{
			description: "Remove an element (from the main or any overlay track) by id.",
			inputSchema: {
				projectId: z.string(),
				elementId: z.string(),
			},
		},
		async (args) => {
			try {
				return json({ removed: await removeElement(store, args) });
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"get_project_state",
		{
			description: "Return the full current project JSON.",
			inputSchema: {
				projectId: z.string(),
			},
		},
		async (args) => {
			try {
				return json(await getProjectState(store, args.projectId));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"delete_project",
		{
			description:
				"Delete a project from disk. Does not delete any mp4 already exported from it, and does not affect other projects that reference the same media.",
			inputSchema: {
				projectId: z.string(),
			},
		},
		async (args) => {
			try {
				await deleteProject(store, args.projectId);
				return json({ deleted: true });
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"export_video",
		{
			description:
				"Start a headless render of the project's main track + text overlays to an mp4 file. Returns a jobId immediately; poll get_render_status for completion.",
			inputSchema: {
				projectId: z.string(),
				outputPath: z.string().describe("Absolute path to write the mp4 to"),
			},
		},
		async (args) => {
			try {
				return json(await exportVideo(store, args));
			} catch (err) {
				return toolError(err);
			}
		},
	);

	server.registerTool(
		"get_render_status",
		{
			description: "Poll a render job started by export_video.",
			inputSchema: {
				jobId: z.string(),
			},
		},
		(args) => {
			try {
				return json(getRenderStatus(store, args.jobId));
			} catch (err) {
				return toolError(err);
			}
		},
	);
}
