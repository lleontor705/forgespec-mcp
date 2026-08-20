/**
 * OpenCode Plugin for ForgeSpec MCP v2.0
 *
 * Provides:
 * 1. Automatic Board discovery & creation via task_board_create
 * 2. Pre-hook: Advisory file reservation via file_reserve
 * 3. Post-hook: Automatic task completion & file lock release via task_complete & file_release
 * 4. System prompt injection with SDD workflow instructions
 */

export function createForgeSpecPlugin(context = {}) {
  const client = context.client;
  const logger = context.logger || console;
  const projectName = context.projectName || "default-project";
  const agentName = context.agentName || "opencode-agent";

  let activeBoardId = null;
  let activeTaskId = null;

  return {
    name: "opencode-forgespec",

    /**
     * Called when the OpenCode session starts.
     * Creates or initializes a board for the project.
     */
    async onSessionStart() {
      if (!client) return;
      try {
        const createRes = await client.callTool("task_board_create", {
          project: projectName,
          name: `${projectName}-main`,
          owner_actor: agentName,
        });
        const created = typeof createRes?.content?.[0]?.text === "string"
          ? JSON.parse(createRes.content[0].text)
          : createRes?.structuredContent || {};
        activeBoardId = created.board_id;
        logger.info?.(`[ForgeSpec v2] Initialized board: ${activeBoardId} for project ${projectName}`);
      } catch (err) {
        logger.error?.(`[ForgeSpec v2] Session initialization error: ${err.message}`);
      }
    },

    /**
     * Pre-execution hook: Intercepts file modification tools to acquire advisory file locks.
     */
    async beforeToolExecute({ toolName, params }) {
      if (!client) return;
      const fileMutationTools = ["write_file", "edit_file", "replace_content", "apply_patch", "write_to_file"];
      const targetPath = params?.path || params?.TargetFile || params?.filePath;

      if (fileMutationTools.includes(toolName) && targetPath) {
        const normalized = targetPath.replace(/\\/g, "/");
        logger.info?.(`[ForgeSpec v2] Requesting advisory file reservation for: ${normalized}`);

        const reserveRes = await client.callTool("file_reserve", {
          project: projectName,
          paths: [normalized],
          holder: agentName,
          lease_seconds: 300,
        });

        const result = typeof reserveRes?.content?.[0]?.text === "string"
          ? JSON.parse(reserveRes.content[0].text)
          : reserveRes?.structuredContent || {};

        if (result.ok === false || reserveRes.isError) {
          throw new Error(
            `[ForgeSpec Conflict] File '${normalized}' cannot be locked: ${result.error || "Conflict detected"}`
          );
        }
      }
    },

    /**
     * Post-execution hook: When tasks are completed, release held locks.
     */
    async afterToolExecute({ toolName, params, result }) {
      if (!client) return;
      if (toolName === "complete_task" || toolName === "task_complete") {
        try {
          const targetPath = params?.path || params?.TargetFile || params?.filePath;
          if (targetPath) {
            await client.callTool("file_release", {
              project: projectName,
              paths: [targetPath.replace(/\\/g, "/")],
              holder: agentName,
            });
            logger.info?.(`[ForgeSpec v2] Released file reservation: ${targetPath}`);
          }
        } catch (err) {
          logger.warn?.(`[ForgeSpec v2] Error releasing file reservations: ${err.message}`);
        }
      }
    },

    /**
     * Injects context and guidelines into OpenCode system instructions.
     */
    getSystemPromptAdditions() {
      return `
[FORGESPEC V2 COORDINATION ACTIVE]
Connected to ForgeSpec MCP Server v2.0 (14 Semantic Tools).
- Active Board ID: ${activeBoardId || "Auto-detected on startup"}
- Agent Identity: ${agentName}
- Rules:
  1. Use 'task_board_get' to view ready and backlog tasks.
  2. Use 'task_claim' before editing to claim task and reserve working file locks at once.
  3. Use 'task_complete' once work is complete to auto-unblock dependents and free locks.
  4. Follow SDD phase sequence (spec -> tasks -> apply -> verify) via 'spec_save'.
`;
    },

    /**
     * Getter for current state (useful for tests and diagnostics).
     */
    getState() {
      return { activeBoardId, activeTaskId, agentName, projectName };
    },
  };
}

export default createForgeSpecPlugin;
